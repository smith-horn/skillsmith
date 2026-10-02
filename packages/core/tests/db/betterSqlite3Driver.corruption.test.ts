/**
 * SMI-6931: the native driver detects a corrupt database and self-heals
 *
 * The WASM driver has had corruption detection since SMI-4484. The native
 * driver — which `createDatabase` prefers — had none, so on any machine where
 * better-sqlite3 loads, a corrupt `skills.db` threw on every query forever.
 *
 * Two things make this driver's case different from the WASM one, and both are
 * covered here because neither is reachable from the WASM driver's own tests:
 *
 *   - `options.readonly` exists here and does not exist there. Backing a file
 *     aside is a WRITE, so a readonly caller must get a diagnosable error
 *     instead of a silently repaired database it never asked for.
 *   - WAL is enabled for the real database (`schema-sql.ts` sets
 *     `journal_mode = WAL`), so `-wal` and `-shm` sidecars exist on disk. The
 *     WASM driver never sets WAL, so `backupCorruptDbFile` only ever had to
 *     move one file.
 *
 * Every test here opens a REAL file. The sibling `betterSqlite3Driver.test.ts`
 * passes `:memory:` at all nine of its open sites, which is why the file-open
 * path reached production with no corruption handling at all.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  mkdtempSync,
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
import { backupCorruptDbFile } from '../../src/db/drivers/corruption.js'

/** These tests are meaningless without the native module; skip rather than fail. */
const describeNative = isBetterSqlite3Available() ? describe : describe.skip

function makeTempDir(): string {
  return mkdtempSync(
    join(tmpdir(), `smi6931-${Date.now()}-${Math.random().toString(36).slice(2)}-`)
  )
}

/** Files whose name marks them as a corruption backup. */
function backupsIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.corrupt-'))
}

/**
 * A file whose header is not SQLite's. `sqlite3_open` does not read the header,
 * so the handle opens cleanly and the first page read is what fails — which is
 * the whole reason detection must be an explicit probe rather than a check on
 * the constructor's result.
 */
function writeNotADatabase(path: string): void {
  writeFileSync(path, Buffer.from('this is definitely not a sqlite database file'))
}

/**
 * A real SQLite file with its b-trees damaged: valid header, corrupt pages.
 * This is the shape SMI-6931 was filed for — `integrity_check` on the owner's
 * machine reported invalid page numbers, not a bad header — so a fixture that
 * only ever produced "not a database" would leave the reported condition
 * untested.
 */
function writeHeaderValidPageCorrupt(path: string): void {
  const db = createBetterSqlite3Database(path)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
  const insert = db.prepare('INSERT INTO t (val) VALUES (?)')
  for (let i = 0; i < 400; i += 1) insert.run(`row-${i}`)
  db.close()

  const bytes = readFileSync(path)
  // Keep the first page (header + schema root) intact, shred what follows.
  for (let offset = 4096; offset < bytes.length; offset += 1) bytes[offset] = 0xff
  writeFileSync(path, bytes)
}

describeNative('createBetterSqlite3Database — corrupt-file handling (SMI-6931)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  // ── Arm A: the probe fires at all ───────────────────────────────────────────
  // Against the unprobed driver this fails on the backup count, because
  // `new Database()` succeeds on a corrupt file and nothing ever reads a page.

  it('backs aside a file whose header is not a database, and returns a usable empty DB', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeNotADatabase(dbPath)

    const db = createBetterSqlite3Database(dbPath)

    expect(backupsIn(tempDir)).toHaveLength(1)

    // The rebuilt database is usable, which is the point of self-healing.
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    db.prepare('INSERT INTO t (name) VALUES (?)').run('hello')
    expect(db.prepare<{ name: string }>('SELECT name FROM t WHERE id = 1').get()?.name).toBe(
      'hello'
    )
    db.close()
  })

  it('backs aside a file with a valid header and corrupt pages — the reported condition', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeHeaderValidPageCorrupt(dbPath)

    const db = createBetterSqlite3Database(dbPath)

    expect(backupsIn(tempDir)).toHaveLength(1)
    db.close()
  })

  // ── Arm B: the WAL sidecars travel with the main file ───────────────────────
  // Against the unextended helper this fails because `skills.db-wal` is still
  // sitting at its original path beside a freshly rebuilt database.

  it('moves the -wal and -shm sidecars with the main file, leaving no orphan', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeNotADatabase(dbPath)
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(2048, 7))
    writeFileSync(`${dbPath}-shm`, Buffer.alloc(512, 3))

    const db = createBetterSqlite3Database(dbPath)
    db.close()

    // Nothing belonging to the old database may remain at the live paths.
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)

    // And the backup must be a complete, self-consistent triple — named so that
    // the moved sidecars still associate with the moved database, which is what
    // makes the backup recoverable rather than merely preserved.
    const backups = backupsIn(tempDir)
    const main = backups.find((f) => !f.endsWith('-wal') && !f.endsWith('-shm'))
    expect(main).toBeDefined()
    expect(backups).toContain(`${main}-wal`)
    expect(backups).toContain(`${main}-shm`)
    expect(backups).toHaveLength(3)
  })

  // ── Arm C: readonly refuses rather than repairs ─────────────────────────────
  // Against the unguarded driver this fails on "expected to throw", since there
  // is no probe and therefore no error.

  it('refuses a corrupt file under readonly instead of repairing it', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeNotADatabase(dbPath)
    const before = readFileSync(dbPath)
    const mtimeBefore = statSync(dbPath).mtimeMs

    expect(() => createBetterSqlite3Database(dbPath, { readonly: true })).toThrow(/corrupt/i)

    // The discriminating assertion: a readonly caller asked not to mutate, so
    // the bytes must be untouched and nothing may have been backed aside.
    expect(readFileSync(dbPath).equals(before)).toBe(true)
    expect(statSync(dbPath).mtimeMs).toBe(mtimeBefore)
    expect(backupsIn(tempDir)).toHaveLength(0)
  })

  // ── Arm D: known-positive control ───────────────────────────────────────────
  // Passes before the fix. Without it, a driver that backs aside
  // unconditionally would satisfy every arm above.

  it('leaves a healthy database alone and backs nothing aside', () => {
    const dbPath = join(tempDir, 'skills.db')
    const seed = createBetterSqlite3Database(dbPath)
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
    seed.prepare('INSERT INTO t (val) VALUES (?)').run('kept')
    seed.close()

    const db = createBetterSqlite3Database(dbPath)

    expect(backupsIn(tempDir)).toHaveLength(0)
    // The original row survives — proving the file was opened, not rebuilt.
    expect(db.prepare<{ val: string }>('SELECT val FROM t WHERE id = 1').get()?.val).toBe('kept')
    db.close()
  })

  it('opens an absent path as a new database without backing anything aside', () => {
    const dbPath = join(tempDir, 'does-not-exist-yet.db')
    const db = createBetterSqlite3Database(dbPath)
    expect(backupsIn(tempDir)).toHaveLength(0)
    db.close()
  })
})

describe('backupCorruptDbFile — sidecar handling (SMI-6931)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  // ── Arm E: no-sidecar no-op ─────────────────────────────────────────────────
  // Passes before the fix, and protects the existing sql.js caller, which never
  // has sidecars because that driver does not set WAL. `corruption.test.ts`
  // asserts exactly one backup for that path, so the extension must create
  // nothing when a sidecar source is absent.

  it('creates exactly one backup when no sidecars exist', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeFileSync(dbPath, 'garbage')

    const backupPath = backupCorruptDbFile(dbPath)

    expect(backupPath).toMatch(/skills\.db\.corrupt-/)
    expect(readdirSync(tempDir).filter((f) => f.includes('.corrupt-'))).toHaveLength(1)
  })

  it('returns the MAIN backup path, not a sidecar path', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeFileSync(dbPath, 'garbage')
    writeFileSync(`${dbPath}-wal`, 'wal bytes')

    const backupPath = backupCorruptDbFile(dbPath)

    // The return contract is unchanged: callers log this path to the user.
    expect(backupPath.endsWith('-wal')).toBe(false)
    expect(backupPath.endsWith('-shm')).toBe(false)
    expect(existsSync(backupPath)).toBe(true)
    expect(existsSync(`${backupPath}-wal`)).toBe(true)
  })

  it('moves a -wal present without a -shm, and does not invent the missing one', () => {
    const dbPath = join(tempDir, 'skills.db')
    writeFileSync(dbPath, 'garbage')
    writeFileSync(`${dbPath}-wal`, 'wal bytes')

    const backupPath = backupCorruptDbFile(dbPath)

    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${backupPath}-wal`)).toBe(true)
    expect(existsSync(`${backupPath}-shm`)).toBe(false)
    expect(readdirSync(tempDir).filter((f) => f.includes('.corrupt-'))).toHaveLength(2)
  })

  it('preserves sidecar contents byte-for-byte across the move', () => {
    const dbPath = join(tempDir, 'skills.db')
    const walBytes = Buffer.alloc(1024, 0x5a)
    writeFileSync(dbPath, 'garbage')
    writeFileSync(`${dbPath}-wal`, walBytes)

    const backupPath = backupCorruptDbFile(dbPath)

    // A backup that silently truncated the WAL would pass every existence
    // check above while losing the committed pages the WAL may still hold.
    expect(readFileSync(`${backupPath}-wal`).equals(walBytes)).toBe(true)
  })
})
