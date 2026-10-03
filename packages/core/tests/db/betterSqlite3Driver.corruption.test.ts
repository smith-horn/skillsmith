/**
 * SMI-6931: the native driver detects a corrupt database and refuses
 *
 * The WASM driver has had corruption handling since SMI-4484. The native driver
 * — which `createDatabase` prefers — had none, so on any machine where
 * better-sqlite3 loads, a corrupt `skills.db` threw a raw SQLite error from
 * whatever query happened to touch a damaged page, with no indication of the
 * cause and no remedy.
 *
 * **It refuses rather than repairing, and that is the design, not a shortcut.**
 * An earlier draft backed the file aside and rebuilt it, mirroring the WASM
 * driver. A cross-family review rejected that: this database is shared between
 * processes — a CLI invocation and a long-lived MCP server can both hold it —
 * and SQLite coordinates processes through the file PATHS, not the inodes.
 * Renaming it out from under a live handle leaves that process writing into the
 * renamed backup while new connections use the replacement, and the two diverge
 * silently. ADR-155 had already settled the policy: *"Recovery never runs
 * automatically."*
 *
 * The probe runs through a SEPARATE READ-ONLY connection, opened and closed
 * before the caller's connection exists. That is not fastidiousness: a
 * read-write open mutates on close — SQLite checkpoints committed WAL content
 * into the main file and unlinks the journal sidecars — so probing through the
 * caller's own handle cannot deliver a non-mutating refusal however carefully
 * the rest is written. A first version claimed non-mutation without earning it,
 * and the test asserting the sidecars survive is what caught the lie.
 *
 * So every test below asserts the files are left **byte-identical** — all three
 * of them, not just the main file. That is the discriminating assertion, not
 * decoration: a refusal that still touched the bytes would pass a throw-only
 * test.
 *
 * Every test opens a REAL file. The sibling `betterSqlite3Driver.test.ts` passes
 * `:memory:` at all nine of its open sites, which is why a missing corruption
 * probe reached production unnoticed.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBetterSqlite3Database,
  isBetterSqlite3Available,
} from '../../src/db/drivers/betterSqlite3Driver.js'

/** These tests are meaningless without the native module; skip rather than fail. */
const describeNative = isBetterSqlite3Available() ? describe : describe.skip

function makeTempDir(): string {
  return mkdtempSync(
    join(tmpdir(), `smi6931-${Date.now()}-${Math.random().toString(36).slice(2)}-`)
  )
}

/**
 * A file whose header is not SQLite's. `sqlite3_open` does not read the header,
 * so the handle opens cleanly and the first page read is what fails — which is
 * why detection must be an explicit probe rather than a check on the
 * constructor's result.
 */
function writeNotADatabase(path: string): void {
  writeFileSync(path, Buffer.from('this is definitely not a sqlite database file'))
}

/**
 * A real SQLite file with its b-trees damaged: valid header, corrupt pages.
 *
 * This is the shape SMI-6931 was filed for — `integrity_check` on the owner's
 * machine reported invalid page numbers, not a bad header. It matters because
 * `SELECT name FROM sqlite_master`, the WASM driver's probe, **succeeds** on
 * this file: the schema page is deliberately left intact. A fixture that only
 * produced "not a database" would have passed against that insufficient probe
 * and hidden the reported condition entirely.
 */
function writeHeaderValidPageCorrupt(path: string): void {
  const db = createBetterSqlite3Database(path)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
  const insert = db.prepare('INSERT INTO t (val) VALUES (?)')
  for (let i = 0; i < 400; i += 1) insert.run(`row-${i}`)
  db.close()

  const bytes = readFileSync(path)
  for (let offset = 4096; offset < bytes.length; offset += 1) bytes[offset] = 0xff
  writeFileSync(path, bytes)
}

/** Captures everything that must be unchanged after a refusal. */
function snapshot(dir: string, path: string) {
  return {
    bytes: readFileSync(path),
    mtimeMs: statSync(path).mtimeMs,
    entries: readdirSync(dir).sort(),
  }
}

function expectUntouched(dir: string, path: string, before: ReturnType<typeof snapshot>): void {
  expect(readFileSync(path).equals(before.bytes)).toBe(true)
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
  // No backup, no rebuild, no stray sidecar: the directory is exactly as found.
  expect(readdirSync(dir).sort()).toEqual(before.entries)
}

describeNative('createBetterSqlite3Database — corrupt-file refusal (SMI-6931)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  it('refuses a file whose header is not a database, and leaves it untouched', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeNotADatabase(dbPath)
    const before = snapshot(tempDir, dbPath)

    expect(() => createBetterSqlite3Database(dbPath)).toThrow(/is corrupt and cannot be read/)
    expectUntouched(tempDir, dbPath, before)
  })

  it('refuses a file with a valid header and corrupt pages — the reported condition', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeHeaderValidPageCorrupt(dbPath)
    const before = snapshot(tempDir, dbPath)

    expect(() => createBetterSqlite3Database(dbPath)).toThrow(/is corrupt and cannot be read/)
    expectUntouched(tempDir, dbPath, before)
  })

  it('names the path, the verdict, and a remedy covering all three WAL files', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeHeaderValidPageCorrupt(dbPath)

    let message = ''
    try {
      createBetterSqlite3Database(dbPath)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // A correct refusal the user cannot act on is its own defect, so the
    // message is asserted rather than assumed: the file, the cause, and the
    // exact move — including the sidecars, because this is a WAL database and
    // moving only the main file orphans the other two against a rebuilt file.
    expect(message).toContain(dbPath)
    expect(message).toMatch(/btreeInitPage|malformed|page/i)
    expect(message).toContain(`mv '${dbPath}'`)
    expect(message).toContain(`${dbPath}-wal`)
    expect(message).toContain(`${dbPath}-shm`)
    expect(message).toMatch(/does not repair it automatically/)
  })

  it('refuses identically under readonly — no branch, because nothing is ever written', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeNotADatabase(dbPath)
    const before = snapshot(tempDir, dbPath)

    expect(() => createBetterSqlite3Database(dbPath, { readonly: true })).toThrow(
      /is corrupt and cannot be read/
    )
    expectUntouched(tempDir, dbPath, before)
  })

  it('leaves the WAL sidecars byte-identical too, not merely the main file', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeNotADatabase(dbPath)
    const walBytes = Buffer.alloc(2048, 7)
    const shmBytes = Buffer.alloc(512, 3)
    writeFileSync(`${dbPath}-wal`, walBytes)
    writeFileSync(`${dbPath}-shm`, shmBytes)
    const before = snapshot(tempDir, dbPath)

    expect(() => createBetterSqlite3Database(dbPath)).toThrow(/is corrupt and cannot be read/)

    // This assertion was once DELETED because it failed. That was the wrong
    // call: its failure was evidence the non-mutation claim was false, not
    // evidence the test was over-reaching. A read-write open mutates on close —
    // SQLite checkpoints committed WAL content into the main file and unlinks
    // the journal files — so the only way to earn this guarantee is to probe
    // through a separate READ-ONLY connection, which cannot do either.
    //
    // It is restored, and it is the assertion that holds that design in place:
    // probe through the caller's read-write connection again and this goes red.
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    expect(readFileSync(`${dbPath}-wal`).equals(walBytes)).toBe(true)

    // The `-shm` must still EXIST but its bytes are deliberately not asserted,
    // and that narrowing is measured rather than assumed — it is the same shape
    // as a weakening that was wrong once already in this change, so it needed
    // evidence. Measured: with the `-shm` deleted outright, every committed row
    // remained readable and the `-wal` stayed byte-identical. It is SQLite's
    // shared-memory WAL index, cross-process coordination scratch holding no
    // durable data, so byte-identity on it asserts the wrong property. The
    // `-wal` above is where committed-but-uncheckpointed data lives, and that
    // one IS asserted byte-for-byte.
    expect(existsSync(`${dbPath}-shm`)).toBe(true)
    void shmBytes

    expect(readFileSync(dbPath).equals(before.bytes)).toBe(true)
    expect(statSync(dbPath).mtimeMs).toBe(before.mtimeMs)
    expect(readdirSync(tempDir).sort()).toEqual(before.entries)
  })

  it('shell-quotes the paths in its remedy and names a destination that cannot collide', () => {
    const dirWithSpace = join(tempDir, 'has space')
    mkdirSync(dirWithSpace)
    const dbPath = join(dirWithSpace, 'skills.db')
    writeNotADatabase(dbPath)

    let message = ''
    try {
      createBetterSqlite3Database(dbPath)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // These lines are instructions a user pastes into a shell. An unquoted path
    // containing a space changes what the command does, and a fixed `.corrupt`
    // destination silently overwrites an earlier diagnosis.
    expect(message).toContain(`mv '${dbPath}'`)
    expect(message).not.toMatch(/mv [^']*has space/)
    expect(message).toMatch(/\.corrupt-\d{4}-\d{2}-\d{2}T/)
    expect(message).toMatch(/stop every Skillsmith process/)
  })

  // ── Propagation controls. These are the arms a previous round of this work
  // claimed existed and did not: the difference between an operational failure
  // and a corruption verdict is the whole safety property here, and nothing
  // held it.

  it('propagates a non-corruption open failure unchanged, as its own error', () => {
    // `fileMustExist` on an absent path is SQLITE_CANTOPEN — operational, not
    // corruption. It must not be reinterpreted as a corrupt database, which
    // would tell the user to move a file that does not exist.
    const dbPath = join(tempDir, 'absent.db')

    let caught: unknown
    try {
      createBetterSqlite3Database(dbPath, { fileMustExist: true })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('SQLITE_CANTOPEN')
    expect((caught as Error).message).not.toMatch(/is corrupt and cannot be read/)
  })

  it('classifies on the SQLite result code, not on the word "malformed" in a path', () => {
    // The shared `isCorruptionError` matches the bare substring `malformed`
    // against a message, and a message can carry the file path. A healthy
    // database living at a path containing that word must still open.
    const dirName = join(tempDir, 'malformed-fixtures')
    mkdirSync(dirName)
    const dbPath = join(dirName, 'skills.db')

    const seed = createBetterSqlite3Database(dbPath)
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
    seed.prepare('INSERT INTO t (val) VALUES (?)').run('healthy')
    seed.close()

    const db = createBetterSqlite3Database(dbPath)
    expect(db.prepare<{ val: string }>('SELECT val FROM t WHERE id = 1').get()?.val).toBe('healthy')
    db.close()
  })

  // ── Known-positive controls. Both pass before the change. ───────────────────
  // Without these, a driver that refused unconditionally would satisfy every
  // arm above.

  it('opens a healthy database and leaves its contents intact', () => {
    const dbPath = join(tempDir, 'skills.db')
    const seed = createBetterSqlite3Database(dbPath)
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
    seed.prepare('INSERT INTO t (val) VALUES (?)').run('kept')
    seed.close()

    const db = createBetterSqlite3Database(dbPath)
    // The original row survives, proving the file was opened rather than replaced.
    expect(db.prepare<{ val: string }>('SELECT val FROM t WHERE id = 1').get()?.val).toBe('kept')
    db.close()
  })

  it('opens an absent path as a new database', () => {
    const dbPath = join(tempDir, 'does-not-exist-yet.db')
    const db = createBetterSqlite3Database(dbPath)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    db.close()
    expect(existsSync(dbPath)).toBe(true)
  })

  it('opens an in-memory database without probing', () => {
    const db = createBetterSqlite3Database(':memory:')
    expect(db.memory).toBe(true)
    db.close()
  })
})

describeNative('quick_check result contract (SMI-6931)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  /**
   * Detection parses `pragma('quick_check(1)')`, and an unrecognised shape is
   * treated as a **probe fault** rather than as corruption — deliberately, since
   * the corruption branch refuses to open the user's database and a dependency
   * changing its return shape must not brick every open.
   *
   * That inversion is only safe while the shape this code expects is the shape
   * the library actually returns, so the contract is pinned here. If
   * better-sqlite3 changes it, this test fails and names the cause, instead of
   * the probe silently reporting a healthy database as unreadable.
   */
  it('returns an array whose first row holds the string "ok" for a healthy database', () => {
    const dbPath = join(tempDir, 'skills.db')
    const seed = createBetterSqlite3Database(dbPath)
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')

    const rows = seed.native.pragma('quick_check(1)') as unknown

    expect(Array.isArray(rows)).toBe(true)
    const first = (rows as unknown[])[0]
    expect(first).toBeTypeOf('object')
    const verdict = Object.values(first as Record<string, unknown>)[0]
    expect(verdict).toBeTypeOf('string')
    expect(String(verdict).trim().toLowerCase()).toBe('ok')

    seed.close()
  })
})
