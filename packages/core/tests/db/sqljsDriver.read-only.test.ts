/**
 * SMI-7260: a file-backed sql.js (WASM) database never writes to disk.
 *
 * Real primitives throughout: sql.js itself for the WASM side, and
 * better-sqlite3 to write the fixtures and to play the native process that
 * holds the database in WAL mode. Each write refusal is paired with a read
 * from the same handle, so a handle that refused everything would fail too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqlJsDatabase } from '../../src/db/drivers/sqljsDriver.js'
import { createBetterSqlite3Database } from '../../src/db/drivers/betterSqlite3Driver.js'
import { DB_WASM_READ_ONLY_CODE } from '../../src/db/db-errors.js'
import { sealDatabase } from '../../src/db/read-only-reason.js'
import { getSchemaVersion, initializeSchema, LATEST_SCHEMA_VERSION } from '../../src/db/schema.js'

let dir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smi7260-ro-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function pathIn(name: string): string {
  return join(dir!, name)
}

/** A database written and cleanly closed by the native driver, in WAL mode. */
function nativeFixture(path: string, rows = 3): void {
  const db = createBetterSqlite3Database(path)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
  for (let i = 0; i < rows; i += 1) insert.run(`row-${i}`)
  db.close()
}

function snapshot(path: string) {
  const s = statSync(path)
  return {
    bytes: readFileSync(path),
    ino: s.ino,
    mtimeMs: s.mtimeMs,
    entries: readdirSync(dir!).sort(),
  }
}

/** The thrown error's `code`, or `'no throw'`. */
function codeOf(fn: () => unknown): unknown {
  try {
    fn()
    return 'no throw'
  } catch (error) {
    return (error as { code?: unknown }).code
  }
}

const count = (db: { prepare: (sql: string) => { get: () => unknown } }) =>
  (db.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c

describe('SMI-7260 test 1: an existing file opens read-only and is never written', () => {
  it('refuses every write with the named code, reads work, and close leaves the file identical', async () => {
    const path = pathIn('skills.db')
    nativeFixture(path)
    const before = snapshot(path)

    const db = await createSqlJsDatabase(path)
    expect(db.readonly).toBe(true)
    expect(db.readOnlyReason).toContain(path)
    // Presence: the same handle reads the native rows.
    expect(count(db)).toBe(3)
    // Absence: every write path is refused, by name.
    expect(codeOf(() => db.exec("INSERT INTO t (v) VALUES ('x')"))).toBe(DB_WASM_READ_ONLY_CODE)
    expect(codeOf(() => db.prepare("INSERT INTO t (v) VALUES ('y')").run())).toBe(
      DB_WASM_READ_ONLY_CODE
    )
    expect(codeOf(() => db.exec('CREATE TABLE u (id INTEGER)'))).toBe(DB_WASM_READ_ONLY_CODE)
    expect(count(db)).toBe(3)
    db.close()

    const after = snapshot(path)
    expect(after.bytes.equals(before.bytes)).toBe(true)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.entries).toEqual(before.entries)
  })
})

describe('SMI-7260 test 2: :memory: is unchanged', () => {
  it('stays writable after a seal, and the write is in export()', async () => {
    const db = await createSqlJsDatabase(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    // initializeSchema seals every handle it builds; on :memory: that is a no-op.
    sealDatabase(db)
    expect(db.readonly).toBe(false)
    expect(codeOf(() => db.prepare("INSERT INTO t (v) VALUES ('kept')").run())).toBe('no throw')
    const bytes = db.export()
    db.close()

    // Read the exported image back from disk: the row is in the bytes.
    const path = pathIn('exported.db')
    writeFileSync(path, Buffer.from(bytes))
    const reread = await createSqlJsDatabase(path)
    expect(
      reread
        .prepare<{ v: string }>('SELECT v FROM t')
        .all()
        .map((r) => r.v)
    ).toEqual(['kept'])
    reread.close()
  })
})

describe('SMI-7260 test 3: { readonly: true } is really read-only', () => {
  it('refuses a write on a missing path, where nothing else would seal it', async () => {
    const path = pathIn('absent.db')
    const db = await createSqlJsDatabase(path, { readonly: true })
    expect(db.readonly).toBe(true)
    // Presence: reads work (an empty database).
    expect(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get()).toEqual({
      c: 0,
    })
    expect(codeOf(() => db.exec('CREATE TABLE t (id INTEGER)'))).toBe(DB_WASM_READ_ONLY_CODE)
    db.close()
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a write on an existing file', async () => {
    const path = pathIn('skills.db')
    nativeFixture(path)
    const db = await createSqlJsDatabase(path, { readonly: true })
    expect(count(db)).toBe(3)
    expect(codeOf(() => db.exec("INSERT INTO t (v) VALUES ('x')"))).toBe(DB_WASM_READ_ONLY_CODE)
    db.close()
  })
})

describe('SMI-7260 D1: a first-run handle is writable until its opener seals it', () => {
  it('builds in memory, then seal() makes it read-only for good; the file is never created', async () => {
    const path = pathIn('first-run.db')
    const db = await createSqlJsDatabase(path)
    expect(db.readonly).toBe(false)
    expect(db.readOnlyReason).toBeUndefined()
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.prepare("INSERT INTO t (v) VALUES ('before-seal')").run()

    sealDatabase(db)
    expect(db.readonly).toBe(true)
    expect(db.readOnlyReason).toContain(path)
    expect(count(db)).toBe(1)
    expect(codeOf(() => db.prepare("INSERT INTO t (v) VALUES ('after-seal')").run())).toBe(
      DB_WASM_READ_ONLY_CODE
    )
    // One-shot: sealing again changes nothing and does not throw.
    expect(codeOf(() => sealDatabase(db))).toBe('no throw')
    expect(count(db)).toBe(1)
    db.close()
    expect(existsSync(path)).toBe(false)
  })

  it('initializeSchema builds the current schema in memory and seals', async () => {
    const path = pathIn('skills.db')
    const db = await createSqlJsDatabase(path)
    initializeSchema(db)
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(db.readonly).toBe(true)
    expect(codeOf(() => db.exec("INSERT INTO cache (key, value) VALUES ('k', 'v')"))).toBe(
      DB_WASM_READ_ONLY_CODE
    )
    db.close()
    expect(existsSync(path)).toBe(false)
  })
})

describe('SMI-7260: an unsealed first-run handle warns at close that its writes were discarded', () => {
  it('warns once, naming the path, when it was written; not when it was not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const untouchedPath = pathIn('untouched.db')
    const untouched = await createSqlJsDatabase(untouchedPath)
    untouched.close()
    // Absence: nothing written, nothing to warn about.
    expect(warn).not.toHaveBeenCalled()

    const writtenPath = pathIn('written.db')
    const written = await createSqlJsDatabase(writtenPath)
    written.exec('CREATE TABLE t (id INTEGER)')
    written.close()
    written.close()
    // Presence, same run: one warning, naming the database. Idempotent close.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain(writtenPath)
    expect(existsSync(writtenPath)).toBe(false)
  })

  it('does not warn for a handle that was sealed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const path = pathIn('sealed.db')
    const db = await createSqlJsDatabase(path)
    db.exec('CREATE TABLE t (id INTEGER)')
    sealDatabase(db)
    db.close()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('SMI-7260 test 7: a WASM session never loses a native process’s writes', () => {
  it('a native holder keeps every row and an intact file across a WASM read, write attempt and close', async () => {
    const path = pathIn('skills.db')
    const native = createBetterSqlite3Database(path)
    native.pragma('journal_mode = WAL')
    native.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const insert = native.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 10; i += 1) insert.run(`base-${i}`)
    native.pragma('wal_checkpoint(TRUNCATE)')
    // Hold uncheckpointed writes in the WAL, as a live MCP server does.
    native.pragma('wal_autocheckpoint = 0')
    for (let i = 0; i < 5; i += 1) insert.run(`wal-${i}`)
    expect(existsSync(`${path}-wal`)).toBe(true)

    const wasm = await createSqlJsDatabase(path)
    // It reads the main file: a consistent snapshot without the WAL frames.
    expect(count(wasm)).toBe(10)
    expect(codeOf(() => wasm.exec("INSERT INTO t (v) VALUES ('wasm')"))).toBe(
      DB_WASM_READ_ONLY_CODE
    )
    wasm.close()

    // The native process carries on after the WASM session ended, and
    // checkpoints, as a live server's autocheckpoint does. Measured: when the
    // old sql.js save had renamed a new file over the database, this checkpoint
    // writes to the replaced file, and the reopen below finds only the rows in
    // the WASM image (10 of 18). Without a checkpoint the WAL folds back and
    // nothing is lost, so a test without one would pass on the bug.
    for (let i = 0; i < 3; i += 1) insert.run(`after-${i}`)
    native.pragma('wal_checkpoint(TRUNCATE)')
    native.close()

    const reopened = createBetterSqlite3Database(path)
    try {
      expect(count(reopened)).toBe(18)
      expect(reopened.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
    } finally {
      reopened.close()
    }
  })
})
