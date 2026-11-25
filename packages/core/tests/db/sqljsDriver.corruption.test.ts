/**
 * The WASM driver refuses a corrupt database and does not touch it (SMI-6961).
 *
 * SMI-7260: the refusal is now always `DatabaseReadUnstableError`, never the
 * corrupt verdict. sql.js cannot tell a damaged file from one a native process
 * was writing while it read, so the destructive verdict (move the file aside)
 * comes only from the native driver; each arm below has a native control on
 * the same bytes that still gets `SKILLSMITH_DB_CORRUPT`.
 *
 * This file is the test that would have caught the defect on day one, and it
 * did not exist: `grep -c -iE 'corrupt|backup|malformed'` over the two existing
 * sql.js driver test files returned **0** for both.
 *
 * What the defect was. `createSqlJsDatabase`'s corruption branch renamed the
 * user's database aside and returned a fresh empty one, and its guard never
 * consulted `options.readonly`. So a read-only `skillsmith list` — a
 * *diagnostic* command — destroyed the file it was asked to report on. Worse,
 * `close()` then skipped its save because the handle was read-only (since
 * SMI-7260 this driver never saves a file at all), so nothing was written back: the
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
import { createBetterSqlite3Database } from '../../src/db/drivers/betterSqlite3Driver.js'
import {
  sqlJsCorruptionCode,
  quickCheckVerdict,
} from '../../src/db/drivers/sqljsDriver.corruption.js'
import {
  isCorruptDatabaseError,
  DB_CORRUPT_CODE,
  DB_READ_UNSTABLE_CODE,
} from '../../src/db/db-errors.js'

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

/** The error an open rejects with, or `undefined` when it opened (and is closed again). */
async function openError(
  open: () => Promise<{ close(): void }>
): Promise<{ code?: unknown } | undefined> {
  try {
    ;(await open()).close()
    return undefined
  } catch (error) {
    return error as { code?: unknown }
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

describe('createSqlJsDatabase — corrupt-file refusal (SMI-6961, SMI-7260)', () => {
  // The three damaged fixtures, by kind. Each is refused by sql.js as
  // UNSTABLE (never corrupt, never move-aside advice) and left untouched; the
  // native control below refuses the same bytes as CORRUPT.
  const fixtures: Array<[string, () => Promise<Buffer>]> = [
    [
      'a non-database file',
      async () => Buffer.from('this is definitely not a sqlite database file'),
    ],
    [
      'a truncated database',
      async () => {
        const good = await seedBytes()
        return good.subarray(0, Math.floor(good.length / 2))
      },
    ],
    // PROBE PARITY (step 2b). A VALID header and intact schema page, with 0xff
    // over every page from 4096 on — the exact SMI-6931 condition. It PASSES
    // `SELECT name FROM sqlite_master LIMIT 1`, so only `quick_check` catches it.
    [
      'a header-valid, page-corrupt database',
      async () => {
        const damaged = Buffer.from(await seedBytes())
        for (let o = 4096; o < damaged.length; o += 1) damaged[o] = 0xff
        return damaged
      },
    ],
  ]

  // `readonly: true` is the arm that matters: it is what `skillsmith list` and
  // `manage` pass, and it is the case the old guard never consulted.
  for (const [kind, build] of fixtures) {
    it.each([
      ['readonly', { readonly: true }],
      ['read-write', undefined],
    ])(
      `refuses ${kind} as unstable, not corrupt, and leaves it untouched (%s)`,
      async (_l, options) => {
        const dbPath = join(dir, 'skills.db')
        writeFileSync(dbPath, await build())
        const before = snapshot(dbPath)

        const error = await openError(() => createSqlJsDatabase(dbPath, options))
        expect(error?.code).toBe(DB_READ_UNSTABLE_CODE)
        expect(isCorruptDatabaseError(error)).toBe(false)
        expectUntouched(dbPath, before)
      }
    )

    it(`the native driver still refuses ${kind} as corrupt (the paired control)`, async () => {
      const dbPath = join(dir, 'skills.db')
      writeFileSync(dbPath, await build())
      const before = snapshot(dbPath)

      const error = await openError(async () =>
        createBetterSqlite3Database(dbPath, { readonly: true })
      )
      expect(error?.code).toBe(DB_CORRUPT_CODE)
      expectUntouched(dbPath, before)
    })
  }

  it('never surfaces move-aside advice, in the message or through the cause chain', async () => {
    // A CorruptDatabaseError's message tells the user to `mv` the database
    // aside. A logger that prints a cause chain must not print that either.
    const dbPath = join(dir, 'skills.db')
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file'))

    const error = (await openError(() => createSqlJsDatabase(dbPath, { readonly: true }))) as
      | (Error & { code?: unknown })
      | undefined
    expect(error?.code).toBe(DB_READ_UNSTABLE_CODE)
    const chain: unknown[] = []
    for (let e: unknown = error; e instanceof Error; e = e.cause) chain.push(e)
    // Presence: the integrity verdict is still carried, as a plain cause.
    expect(chain).toHaveLength(2)
    expect((chain[1] as Error).message).toBe('file is not a database')
    // Absence: nothing in the chain is a corruption refusal or says to move the file.
    expect(chain.some((e) => isCorruptDatabaseError(e))).toBe(false)
    expect(chain.some((e) => /\bmv\b|\.corrupt-/.test((e as Error).message))).toBe(false)
  })

  it('refuses identically on a SECOND open — the file is still there to refuse', async () => {
    // THE SECOND-RUN ARM: the old code deleted the file on call 1, so call 2
    // found no database at all and the CLI reported "Up to date".
    const dbPath = join(dir, 'skills.db')
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file'))
    const before = snapshot(dbPath)

    const first = await openError(() => createSqlJsDatabase(dbPath, { readonly: true }))
    const second = await openError(() => createSqlJsDatabase(dbPath, { readonly: true }))
    expect(first?.code).toBe(DB_READ_UNSTABLE_CODE)
    expect(second?.code).toBe(DB_READ_UNSTABLE_CODE)
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

  it('treats an ABSENT file as benign — nothing is installed, so nothing is stale', async () => {
    // Absence is this contract's one benign case: nothing is installed, so
    // nothing can be out of date. The paired negative for every refusal arm
    // above — without it, a driver that refused any path without a readable
    // database would look correct while breaking every first run.
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
