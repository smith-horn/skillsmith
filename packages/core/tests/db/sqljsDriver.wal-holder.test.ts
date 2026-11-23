/**
 * SMI-7260: the sql.js driver must never replace a database a native process
 * may hold, or has changed since the sql.js handle read it.
 *
 * Real primitives throughout: a real better-sqlite3 connection in WAL mode with
 * uncheckpointed frames, and the real sql.js driver opening the same path. Both
 * run in this process, which reproduces the multi-process defect faithfully —
 * sql.js takes no file locks, so it cannot tell another process's connection
 * from one in its own.
 *
 * The defect being pinned: sql.js saved by writing `skills.db.tmp` and renaming
 * it over `skills.db`. The native connection kept its descriptor on the old
 * inode and its `-wal`/`-shm` beside the new one, so its work was lost and a
 * later checkpoint folded a stale WAL into the new file.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqlJsDatabase } from '../../src/db/drivers/sqljsDriver.js'
import { sidecarsOf } from '../../src/db/drivers/sqljsDriver.holder.js'
import { createBetterSqlite3Database } from '../../src/db/drivers/betterSqlite3Driver.js'
import { createDatabaseAsync } from '../../src/db/createDatabase.js'
import { DB_HELD_ELSEWHERE_CODE, isDatabaseHeldElsewhereError } from '../../src/db/db-errors.js'
import type { Database } from '../../src/db/database-interface.js'

const ROWS_CHECKPOINTED = 5
const ROWS_BEFORE = 40
const ROWS_AFTER = 10
const CREATE_T = 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)'

function count(db: Database): number {
  return (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n
}

function integrity(db: Database): string[] {
  return (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map(
    (row) => row.integrity_check
  )
}

/**
 * The error `fn` threw, or `undefined` if it returned. Recorded rather than
 * asserted, so a test reaches its file-level assertions (the point of each
 * test) and fails THERE when the refusal is missing.
 */
function attempt(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * A native connection holding `path` in WAL mode: the schema and
 * `ROWS_CHECKPOINTED` rows checkpointed into the main file (so sql.js can open
 * it and has rows to read), and `ROWS_BEFORE` more rows left in the WAL only.
 */
function holdInWal(path: string): Database {
  const native = createBetterSqlite3Database(path)
  native.pragma('journal_mode = WAL')
  native.pragma('wal_autocheckpoint = 0')
  native.exec(CREATE_T)
  const insert = native.prepare('INSERT INTO t (v) VALUES (?)')
  for (let i = 0; i < ROWS_CHECKPOINTED; i++) insert.run(`checkpointed-${i}`)
  native.pragma('wal_checkpoint(TRUNCATE)')
  for (let i = 0; i < ROWS_BEFORE; i++) insert.run(`native-${i}`)
  return native
}

/** A WAL-mode database with table `t` and no connection open (no sidecars). */
function seedClosed(path: string): void {
  const seed = createBetterSqlite3Database(path)
  seed.pragma('journal_mode = WAL')
  seed.exec(CREATE_T)
  seed.close()
}

describe('sql.js driver vs a native WAL holder (SMI-7260)', () => {
  let dir: string
  let path: string
  const open: Database[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqljs-wal-holder-'))
    path = join(dir, 'skills.db')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const db of open.splice(0)) {
      try {
        if (db.open) db.close()
      } catch {
        // a refused persist on close is the behaviour under test elsewhere
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses writes when the database is held at open, and never replaces the file', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', '')
    const native = holdInWal(path)
    open.push(native)
    // Precondition: the rows really are uncheckpointed, so losing the WAL loses them.
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)
    const inodeBefore = statSync(path).ino
    const bytesBefore = readFileSync(path)

    const wasm = await createSqlJsDatabase(path)
    open.push(wasm)
    // Attempt the writes and the close first; assert the outcome afterwards.
    const viaStatement = attempt(() => wasm.prepare("INSERT INTO t (v) VALUES ('wasm')").run())
    const viaExec = attempt(() => wasm.exec('DELETE FROM t'))
    // An explicit persist must refuse too, not only the one close() would make.
    const viaPersist = attempt(() => wasm.persist())
    const viaClose = attempt(() => wasm.close())

    // 1. The file was not replaced or rewritten.
    expect(statSync(path).ino).toBe(inodeBefore)
    expect(readFileSync(path).equals(bytesBefore)).toBe(true)
    expect(existsSync(`${path}.tmp`)).toBe(false)

    // 2. The holder keeps working against the same file, then folds its WAL in:
    //    every row survives and the result is sound.
    const insert = native.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < ROWS_AFTER; i++) insert.run(`native-late-${i}`)
    native.pragma('wal_checkpoint(TRUNCATE)')
    expect(count(native)).toBe(ROWS_CHECKPOINTED + ROWS_BEFORE + ROWS_AFTER)
    expect(integrity(native)).toEqual(['ok'])
    native.close()
    const reopened = createBetterSqlite3Database(path)
    open.push(reopened)
    expect(count(reopened)).toBe(ROWS_CHECKPOINTED + ROWS_BEFORE + ROWS_AFTER)
    expect(integrity(reopened)).toEqual(['ok'])

    // 3. The writes were refused with the named error, and close() succeeded.
    expect(isDatabaseHeldElsewhereError(viaStatement)).toBe(true)
    expect((viaStatement as { code: string }).code).toBe(DB_HELD_ELSEWHERE_CODE)
    expect((viaStatement as Error).message).toContain(
      'the native better-sqlite3 driver did not load'
    )
    expect(isDatabaseHeldElsewhereError(viaExec)).toBe(true)
    expect(isDatabaseHeldElsewhereError(viaPersist)).toBe(true)
    expect(viaClose).toBeUndefined()
    expect(wasm.open).toBe(false)
    expect(wasm.readOnlyReason).toContain('another process may be using it')
  })

  it('refuses the persist when a holder appears after open', async () => {
    seedClosed(path)
    expect(sidecarsOf(path)).toEqual([])

    const wasm = await createSqlJsDatabase(path)
    open.push(wasm)
    expect(wasm.readOnlyReason).toBeUndefined()
    wasm.prepare("INSERT INTO t (v) VALUES ('wasm')").run()

    const late = createBetterSqlite3Database(path)
    open.push(late)
    late.pragma('wal_autocheckpoint = 0')
    late.prepare("INSERT INTO t (v) VALUES ('native-late')").run()
    expect(sidecarsOf(path)).toContain('skills.db-wal')
    const inodeBefore = statSync(path).ino

    const refusal = attempt(() => wasm.close())

    expect(statSync(path).ino).toBe(inodeBefore)
    expect(existsSync(`${path}.tmp`)).toBe(false)
    late.pragma('wal_checkpoint(TRUNCATE)')
    late.close()
    // Read through a FRESH connection: `late` itself would still see its own
    // row on an orphaned inode even if the file had been replaced under it.
    const reopened = createBetterSqlite3Database(path)
    open.push(reopened)
    expect(reopened.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([{ v: 'native-late' }])
    expect(integrity(reopened)).toEqual(['ok'])

    expect(isDatabaseHeldElsewhereError(refusal)).toBe(true)
    expect(wasm.open).toBe(false)
  })

  it('refuses the persist when another process wrote and closed after open, and stays read-only', async () => {
    seedClosed(path)
    const wasm = await createSqlJsDatabase(path)
    open.push(wasm)
    expect(wasm.readOnlyReason).toBeUndefined()
    wasm.prepare("INSERT INTO t (v) VALUES ('wasm')").run()

    // Another process writes and closes: its checkpoint folds its WAL into the
    // main file and removes -wal/-shm, so no sidecar is left for a check to see.
    const other = createBetterSqlite3Database(path)
    other.prepare("INSERT INTO t (v) VALUES ('native-closed')").run()
    other.close()
    expect(sidecarsOf(path)).toEqual([])
    const inodeBefore = statSync(path).ino
    const bytesBefore = readFileSync(path)

    const viaPersist = attempt(() => wasm.persist())
    const laterWrite = attempt(() => wasm.prepare("INSERT INTO t (v) VALUES ('later')").run())
    const viaClose = attempt(() => wasm.close())

    // 1. The other process's file was not replaced, and its row survives.
    expect(statSync(path).ino).toBe(inodeBefore)
    expect(readFileSync(path).equals(bytesBefore)).toBe(true)
    expect(existsSync(`${path}.tmp`)).toBe(false)
    const reopened = createBetterSqlite3Database(path)
    open.push(reopened)
    expect(reopened.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([{ v: 'native-closed' }])
    expect(integrity(reopened)).toEqual(['ok'])

    // 2. The save was refused, and the handle is read-only from then on.
    expect(isDatabaseHeldElsewhereError(viaPersist)).toBe(true)
    expect((viaPersist as Error).message).toContain('has changed')
    expect(isDatabaseHeldElsewhereError(laterWrite)).toBe(true)
    expect(viaClose).toBeUndefined()
    expect(wasm.readOnlyReason).toContain('changed it after this session read it')
  })

  it('control: the same handle saves repeatedly when nothing else changed the file', async () => {
    const wasm = await createSqlJsDatabase(path)
    open.push(wasm)
    wasm.exec(`${CREATE_T}; INSERT INTO t (v) VALUES ('a')`)
    wasm.persist()
    wasm.exec("INSERT INTO t (v) VALUES ('b')")
    wasm.persist()
    wasm.prepare("INSERT INTO t (v) VALUES ('c')").run()
    wasm.close()
    expect(wasm.readOnlyReason).toBeUndefined()

    const reopened = await createSqlJsDatabase(path)
    open.push(reopened)
    expect(reopened.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([
      { v: 'a' },
      { v: 'b' },
      { v: 'c' },
    ])
  })

  it('control: with no sidecars present, a WAL-header database is written back', async () => {
    const native = holdInWal(path)
    native.close()
    // Closing the last connection checkpoints and removes -wal/-shm, leaving a
    // WAL-mode header (bytes 18-19 = 2) with nothing pending.
    expect(sidecarsOf(path)).toEqual([])
    expect(readFileSync(path)[18]).toBe(2)

    const wasm = await createSqlJsDatabase(path)
    expect(wasm.readOnlyReason).toBeUndefined()
    wasm.prepare("INSERT INTO t (v) VALUES ('wasm')").run()
    wasm.close()

    const reopened = createBetterSqlite3Database(path)
    open.push(reopened)
    expect(count(reopened)).toBe(ROWS_CHECKPOINTED + ROWS_BEFORE + 1)
    expect(integrity(reopened)).toEqual(['ok'])
  })

  it('control: a fresh file with no sidecars is written back', async () => {
    const wasm = await createSqlJsDatabase(path)
    wasm.exec(`${CREATE_T}; INSERT INTO t (v) VALUES ('a')`)
    wasm.close()

    const reopened = await createSqlJsDatabase(path)
    open.push(reopened)
    expect(count(reopened)).toBe(1)
  })

  it('treats a leftover rollback journal as a holder', async () => {
    const wasm = await createSqlJsDatabase(path)
    wasm.exec(CREATE_T)
    wasm.close()
    writeFileSync(`${path}-journal`, '')

    const held = await createSqlJsDatabase(path)
    open.push(held)
    expect(held.readOnlyReason).toContain('skills.db-journal')
    expect(
      isDatabaseHeldElsewhereError(attempt(() => held.exec("INSERT INTO t (v) VALUES ('x')")))
    ).toBe(true)
  })

  it('a read-only open of a held database neither warns nor refuses reads', async () => {
    const native = holdInWal(path)
    open.push(native)
    const wasm = await createSqlJsDatabase(path, { readonly: true })
    open.push(wasm)
    expect(wasm.readOnlyReason).toBeUndefined()
    // Paired presence: the read returns the main file's rows (the WAL-only rows
    // are invisible to sql.js), so it ran and read real data.
    expect(count(wasm)).toBe(ROWS_CHECKPOINTED)
  })

  it('createDatabaseAsync warns once; a refused write explains itself without repeating it', async () => {
    const native = holdInWal(path)
    open.push(native)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    vi.stubEnv('SKILLSMITH_QUIET', '')
    try {
      const db = await createDatabaseAsync(path)
      open.push(db)
      const refusal = attempt(() => db.exec("INSERT INTO t (v) VALUES ('x')"))
      const notices = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((m) => m.includes('read-only for this session'))
      expect(notices).toHaveLength(1)
      expect(isDatabaseHeldElsewhereError(refusal)).toBe(true)
      const message = (refusal as Error).message
      // Under FORCE_WASM the native driver may be fine: the error must say why
      // WASM is in use rather than claim the native driver did not load.
      expect(message).toContain('SKILLSMITH_FORCE_WASM is set')
      expect(message).not.toContain('did not load')
      // The warning and the error are different lines, not one text twice.
      expect(message).not.toContain(notices[0])
      expect(notices[0]).not.toContain('Not writing')
    } finally {
      warn.mockRestore()
    }
  })
})
