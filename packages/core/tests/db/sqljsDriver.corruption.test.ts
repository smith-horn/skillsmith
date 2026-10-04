/**
 * The WASM driver refuses a corrupt database and does not touch it (SMI-6961).
 *
 * This file is the test that would have caught the defect on day one, and it
 * did not exist: `grep -c -iE 'corrupt|backup|malformed'` over the two existing
 * sql.js driver test files returned **0** for both.
 *
 * What the defect was. `createSqlJsDatabase`'s corruption branch renamed the
 * user's database aside and returned a fresh empty one, and its guard never
 * consulted `options.readonly`. So a read-only `skillsmith list` — a
 * *diagnostic* command — destroyed the file it was asked to report on. Worse,
 * `close()` skips `persist()` when read-only, so nothing was written back: the
 * path was simply **gone**, and the next run found no database and reported
 * every skill "Up to date". The false currency claim SMI-6946 removed came
 * back one run later through the absent-database path.
 *
 * Two deliberate choices about how this file is built:
 *
 * 1. **Fixtures are built by sql.js itself**, not by `better-sqlite3`. This
 *    suite must not be gated on the native module. A `describeNative`-style
 *    gate reports "skipped" when a binding is broken, which is indistinguishable
 *    from "unsupported platform" in a green run — the hazard SMI-6792 records
 *    and which cost a real false-negative on this very work (a seven-day-stale
 *    bundle produced three identical "passing" arms).
 * 2. **Every arm asserts the file is UNTOUCHED**, not merely that the open
 *    threw. A refusal that still renamed the file would satisfy a throw-only
 *    assertion, and renaming is the whole defect.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqlJsDatabase } from '../../src/db/drivers/sqljsDriver.js'
import {
  sqlJsCorruptionCode,
  quickCheckVerdict,
} from '../../src/db/drivers/sqljsDriver.corruption.js'
import { isCorruptDatabaseError, DB_CORRUPT_CODE } from '../../src/db/db-errors.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smi6961-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A real SQLite file, built by sql.js so this suite needs no native module. */
async function seedBytes(): Promise<Buffer> {
  const db = await createSqlJsDatabase(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
  const insert = db.prepare('INSERT INTO t (val) VALUES (?)')
  for (let i = 0; i < 400; i += 1) insert.run(`row-${i}`)
  insert.finalize()
  const bytes = Buffer.from(db.native.export())
  db.close()
  return bytes
}

function snapshot(path: string) {
  return {
    bytes: readFileSync(path),
    mtimeMs: statSync(path).mtimeMs,
    entries: readdirSync(dir).sort(),
  }
}

function expectUntouched(path: string, before: ReturnType<typeof snapshot>): void {
  expect(readFileSync(path).equals(before.bytes)).toBe(true)
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
  // No backup, no rebuild, no stray sibling: the directory is exactly as found.
  expect(readdirSync(dir).sort()).toEqual(before.entries)
  // Stated separately because it is the specific thing the old code did.
  expect(readdirSync(dir).filter((f) => f.includes('.corrupt'))).toHaveLength(0)
}

describe('sqlJsCorruptionCode — the message-to-code adapter', () => {
  // sql.js errors carry NO `code` (measured: undefined on every one), so the
  // message is the only verdict its engine exposes. These two strings were
  // measured against fixtures built by sql.js itself.
  it.each([
    ['file is not a database', 'SQLITE_NOTADB'],
    ['database disk image is malformed', 'SQLITE_CORRUPT'],
  ])('maps %s to %s', (message, code) => {
    expect(sqlJsCorruptionCode(new Error(message))).toBe(code)
  })

  // The paired NEGATIVE arm, and the reason this is not the substring matching
  // ADR-175 retired: the comparison is against the WHOLE message, so none of
  // these can match however corruption-shaped their text is.
  it.each([
    ['an unrelated SQLite error', 'no such table: skills'],
    ["this driver's own absent-file error", 'SQLITE_CANTOPEN: unable to open database file: /x'],
    ['a path containing the word malformed', 'unable to open /home/u/malformed/skills.db'],
    ['a wrapper that merely mentions the verdict', 'open failed: database disk image is malformed'],
    ['empty', ''],
  ])('does not classify %s as corruption', (_label, message) => {
    expect(sqlJsCorruptionCode(new Error(message))).toBeUndefined()
  })

  it('tolerates a non-Error without throwing', () => {
    expect(sqlJsCorruptionCode('file is not a database')).toBe('SQLITE_NOTADB')
    expect(sqlJsCorruptionCode(null)).toBeUndefined()
    expect(sqlJsCorruptionCode(undefined)).toBeUndefined()
  })
})

describe('quickCheckVerdict — the integrity report', () => {
  /** A stub matching only the shape the predicate needs. */
  function stub(row: unknown[] | null): { prepare: () => never } | QuickCheckableStub {
    return {
      prepare: () => ({
        step: () => row !== null,
        get: () => row ?? [],
        free: () => {},
      }),
    }
  }
  type QuickCheckableStub = {
    prepare: (sql: string) => { step(): boolean; get(): unknown[]; free(): void }
  }

  it("treats SQLite's own ok token as healthy", () => {
    expect(quickCheckVerdict(stub(['ok']) as QuickCheckableStub)).toBeUndefined()
    // Case and surrounding whitespace are not meaningful.
    expect(quickCheckVerdict(stub([' OK\n']) as QuickCheckableStub)).toBeUndefined()
  })

  it('returns the damage description verbatim when not ok', () => {
    const damage = '*** in database main ***\nTree 2 page 2: btreeInitPage() returns error code 11'
    expect(quickCheckVerdict(stub([damage]) as QuickCheckableStub)).toBe(damage)
  })

  // Both unreadable shapes are verdicts, not health. The alternative is
  // publishing a handle whose integrity was never established.
  it('treats an absent row as a verdict rather than as health', () => {
    expect(quickCheckVerdict(stub(null) as QuickCheckableStub)).toMatch(/no result/)
  })

  it('treats a non-string result as a verdict rather than as health', () => {
    expect(quickCheckVerdict(stub([42]) as QuickCheckableStub)).toMatch(/non-string/)
  })
})

describe('createSqlJsDatabase — corrupt-file refusal (SMI-6961)', () => {
  // `readonly: true` is the arm that matters: it is what `skillsmith list` and
  // `manage` pass, and it is the case the old guard never consulted.
  it.each([
    ['readonly', { readonly: true }],
    ['read-write', undefined],
  ])('refuses a non-database file and leaves it untouched (%s)', async (_label, options) => {
    const dbPath = join(dir, 'skills.db')
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file'))
    const before = snapshot(dbPath)

    await expect(createSqlJsDatabase(dbPath, options)).rejects.toThrow(
      /is corrupt and cannot be read/
    )
    expectUntouched(dbPath, before)
  })

  it.each([
    ['readonly', { readonly: true }],
    ['read-write', undefined],
  ])('refuses a truncated database and leaves it untouched (%s)', async (_label, options) => {
    const dbPath = join(dir, 'skills.db')
    const good = await seedBytes()
    writeFileSync(dbPath, good.subarray(0, Math.floor(good.length / 2)))
    const before = snapshot(dbPath)

    await expect(createSqlJsDatabase(dbPath, options)).rejects.toThrow(
      /is corrupt and cannot be read/
    )
    expectUntouched(dbPath, before)
  })

  // PROBE PARITY (step 2b). This fixture has a VALID header and intact schema
  // page, with 0xff over every page from 4096 on — the exact SMI-6931
  // condition. Measured: it PASSES `SELECT name FROM sqlite_master LIMIT 1`
  // and opens cleanly, so only `quick_check` catches it. Without the integrity
  // report this driver would not refuse the file the native driver refuses,
  // which ADR-175 § 1 forbids.
  it.each([
    ['readonly', { readonly: true }],
    ['read-write', undefined],
  ])(
    'refuses a header-valid, page-corrupt database and leaves it untouched (%s)',
    async (_label, options) => {
      const dbPath = join(dir, 'skills.db')
      const good = await seedBytes()
      const damaged = Buffer.from(good)
      for (let o = 4096; o < damaged.length; o += 1) damaged[o] = 0xff
      writeFileSync(dbPath, damaged)
      const before = snapshot(dbPath)

      await expect(createSqlJsDatabase(dbPath, options)).rejects.toThrow(
        /is corrupt and cannot be read/
      )
      expectUntouched(dbPath, before)
    }
  )

  it('carries no sqliteCode on the reported-verdict path, unlike the thrown path', async () => {
    // quick_check REPORTS; there is no thrown error to read a code from. This
    // is why ADR-175 § 7 makes `sqliteCode` optional rather than deriving it
    // from `cause` — a consumer relying on `cause` would find nothing here.
    const dbPath = join(dir, 'skills.db')
    const good = await seedBytes()
    const damaged = Buffer.from(good)
    for (let o = 4096; o < damaged.length; o += 1) damaged[o] = 0xff
    writeFileSync(dbPath, damaged)

    let error: unknown
    try {
      await createSqlJsDatabase(dbPath, { readonly: true })
    } catch (e) {
      error = e
    }
    expect(isCorruptDatabaseError(error)).toBe(true)
    const refusal = error as { sqliteCode?: string; verdict: string }
    expect(refusal.sqliteCode).toBeUndefined()
    expect(refusal.verdict).toMatch(/btreeInitPage|malformed|page/i)
  })

  it('throws the same structured refusal the native driver throws', async () => {
    const dbPath = join(dir, 'skills.db')
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file'))

    let error: unknown
    try {
      await createSqlJsDatabase(dbPath, { readonly: true })
    } catch (e) {
      error = e
    }

    // Matched on `code`, exactly as a consumer must — never `instanceof`,
    // which fails across duplicate copies of @skillsmith/core.
    expect(isCorruptDatabaseError(error)).toBe(true)
    const refusal = error as { code: string; path: string; sqliteCode?: string; verdict: string }
    expect(refusal.code).toBe(DB_CORRUPT_CODE)
    expect(refusal.path).toBe(dbPath)
    expect(refusal.sqliteCode).toBe('SQLITE_NOTADB')
    expect(refusal.verdict).toBe('file is not a database')
  })

  // THE SECOND-RUN ARM. This is the mutation a single-call byte-identity test
  // passes: the old code deleted the file on call 1, so call 2 found no
  // database at all and the CLI reported "Up to date". A fix that still deleted
  // would satisfy every assertion above on its first call.
  it('refuses identically on a SECOND open — the file is still there to refuse', async () => {
    const dbPath = join(dir, 'skills.db')
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file'))
    const before = snapshot(dbPath)

    await expect(createSqlJsDatabase(dbPath, { readonly: true })).rejects.toThrow(
      /is corrupt and cannot be read/
    )
    // The load-bearing assertion: the file survived the first refusal, so the
    // second open sees a corrupt database rather than an absent one.
    await expect(createSqlJsDatabase(dbPath, { readonly: true })).rejects.toThrow(
      /is corrupt and cannot be read/
    )
    expectUntouched(dbPath, before)
  })

  // Controls. Without these, a driver that refused unconditionally would
  // satisfy every arm above.
  it('opens a healthy database, LEAVES THE FILE INTACT, and reopens it from disk', async () => {
    // The reopen and the byte check are not decoration. A cross-family review
    // named a mutation this arm did not catch in its earlier form: after the
    // healthy integrity check, delete `path` when `options.readonly` is set.
    // Every corruption arm above still passed, because a corrupt input throws
    // before reaching that line — and this control passed too, because it only
    // read from the already-loaded WASM snapshot in memory. It never looked at
    // the file again.
    //
    // So: read the rows, close, assert the backing file is byte-identical with
    // nothing added beside it, then open it AGAIN from disk and read again.
    // The second read is what proves the bytes on disk are still a database
    // rather than merely present.
    const dbPath = join(dir, 'skills.db')
    writeFileSync(dbPath, await seedBytes())
    const before = snapshot(dbPath)

    const first = await createSqlJsDatabase(dbPath, { readonly: true })
    try {
      expect(first.prepare<{ c: number }>('SELECT count(*) AS c FROM t').get()?.c).toBe(400)
    } finally {
      first.close()
    }

    expectUntouched(dbPath, before)

    const second = await createSqlJsDatabase(dbPath, { readonly: true })
    try {
      expect(second.prepare<{ c: number }>('SELECT count(*) AS c FROM t').get()?.c).toBe(400)
    } finally {
      second.close()
    }
    expectUntouched(dbPath, before)
  })

  // A zero-byte file is its own input class, and no engine-level probe can see
  // it: SQLite accepts a zero-length file as a brand-new database, so nothing
  // throws and `quick_check` returns `ok`. Measured before the guard existed —
  // the open succeeded and a write-capable caller persisted 274,432 bytes of
  // valid empty database over the damaged artifact, reproducing the exact
  // later-invocation shape this whole issue exists to close: call one converts
  // the damage, call two succeeds against emptiness with nothing to refuse.
  //
  // Every other fixture in this file is NON-EMPTY, so none of them reach this.
  it.each([
    ['read-write', undefined],
    ['read-only', { readonly: true } as const],
  ])('refuses a zero-byte file (%s) and does not rewrite it', async (_label, options) => {
    const dbPath = join(dir, 'skills.db')
    writeFileSync(dbPath, Buffer.alloc(0))
    const before = snapshot(dbPath)
    expect(before.bytes.length).toBe(0)

    await expect(createSqlJsDatabase(dbPath, options)).rejects.toThrow(
      /is corrupt and cannot be read/
    )

    // Still zero bytes. The pre-guard behaviour wrote a full database here.
    expectUntouched(dbPath, before)
    expect(readFileSync(dbPath).length).toBe(0)
  })

  it('still treats an ABSENT file as benign — the zero-byte guard must not catch it', async () => {
    // The paired negative. Absence is this contract's one benign case: nothing
    // is installed, so nothing can be out of date. Without this arm, a guard
    // that refused every path lacking a readable database would satisfy both
    // zero-byte arms above while breaking every first run.
    const dbPath = join(dir, 'absent.db')
    expect(existsSync(dbPath)).toBe(false)

    const db = await createSqlJsDatabase(dbPath)
    try {
      expect(db.memory).toBe(false)
    } finally {
      db.close()
    }
  })

  it('opens an in-memory database without probing', async () => {
    const db = await createSqlJsDatabase(':memory:')
    try {
      expect(db.memory).toBe(true)
    } finally {
      db.close()
    }
  })

  it('propagates a non-corruption failure unchanged, as its own error', async () => {
    // `fileMustExist` on an absent path is this driver's own error, not a
    // corruption verdict, so it must not be reported as corruption.
    const absent = join(dir, 'nope', 'skills.db')
    await expect(createSqlJsDatabase(absent, { fileMustExist: true })).rejects.toThrow(
      /SQLITE_CANTOPEN/
    )
  })
})
