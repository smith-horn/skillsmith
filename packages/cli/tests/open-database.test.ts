/**
 * @fileoverview Tests for the shared CLI database opener.
 * @see SMI-4917 — Bug 1: `search` crashed with `no such table: cache` on a
 *   fresh DB because it used the bare `createDatabaseAsync` factory without
 *   `initializeSchema`.
 *
 * The regression guard: a DB opened via `openCliDatabase` must be fully
 * schema-initialized so `SearchService` (which queries the `cache` table) does
 * not throw on a brand-new database.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SearchService,
  SkillRepository,
  closeDatabase,
  isCorruptDatabaseError,
  type DatabaseType,
} from '@skillsmith/core'
import { openCliDatabase } from '../src/utils/open-database.js'

/**
 * Injection seam for the handle-leak arm at the bottom of this file. Off by
 * default: every other test in this file runs the real factory and the real
 * `initializeSchema` through `...actual`.
 *
 * Needed because the leak is unobservable on the corruption path — there the
 * throw originates INSIDE `createDatabaseAsync`, so `db` is never assigned and
 * no `close` is due. Only a failure AFTER a successful open reaches it.
 */
const inject = vi.hoisted(() => ({
  fakeDb: null as null | { close: () => void },
  schemaThrows: false,
}))

vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    createDatabaseAsync: async (path: string, options?: unknown) =>
      inject.fakeDb ?? (await actual.createDatabaseAsync(path, options as never)),
    initializeSchema: (db: unknown): void => {
      if (inject.schemaThrows) throw new Error('SMI-6961 injected initializeSchema failure')
      // A stub handle cannot take real DDL — `initializeSchema` calls
      // `db.exec(SCHEMA_SQL)`. So when a fake is injected, skip it. Without
      // this the F4 CONTROL arm died in `db.exec is not a function`, which is
      // a broken test rather than a finding: it never reached its assertion.
      if (inject.fakeDb) return
      actual.initializeSchema(db as never)
    },
  }
})

describe('SMI-4917 Bug 1: openCliDatabase', () => {
  const opened: DatabaseType[] = []

  afterEach(() => {
    for (const db of opened) closeDatabase(db)
    opened.length = 0
  })

  async function open(): Promise<DatabaseType> {
    const db = await openCliDatabase(':memory:')
    opened.push(db)
    return db
  }

  it('returns a fully schema-initialized database', async () => {
    const db = await open()
    // The `cache` table only exists once the schema is initialized.
    const cacheTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cache'")
      .get()
    expect(cacheTable).toBeDefined()
  })

  it('a fresh search no longer throws `no such table: cache`', async () => {
    const db = await open()
    const search = new SearchService(db)
    // Before the fix, SearchService.search() crashed here on a bare DB.
    expect(() => search.search({ query: 'mcp', limit: 10 })).not.toThrow()
  })

  it('search on a fresh DB returns an empty result set, not an error', async () => {
    const db = await open()
    const search = new SearchService(db)
    const results = search.search({ query: 'anything', limit: 10 })
    expect(results.items).toEqual([])
    expect(results.total).toBe(0)
  })

  it('the skills table is queryable on a fresh DB', async () => {
    const db = await open()
    expect(new SkillRepository(db).count()).toBe(0)
  })
})

/**
 * SMI-6961: `openCliDatabase` refuses a corrupt database and does not touch it.
 *
 * This block replaces an SMI-4484 test that asserted the OPPOSITE — that the
 * wrapper backed the file up and rebuilt. That test passed only because the
 * defect was present, and it is the shape CLAUDE.md warns about: a passing test
 * pinning the behaviour a fix must remove. Here BOTH halves encoded the defect —
 * the trigger reached its assertion through the destructive path, and the
 * assertions themselves demanded a backup and a rebuilt database — so the block
 * is replaced rather than re-pointed.
 *
 * What it asserts now is the contract ADR-175 § 1 requires of every driver.
 */
describe('SMI-6961: openCliDatabase refuses a corrupt database', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  function corruptFixture(): string {
    tempDir = mkdtempSync(
      join(tmpdir(), `smi6961-cli-${Date.now()}-${Math.random().toString(36).slice(2)}-`)
    )
    const dbPath = join(tempDir, 'skills.db')
    writeFileSync(dbPath, Buffer.from('not a sqlite database — corrupt on-disk file'))
    return dbPath
  }

  it('rejects with the structured refusal and leaves the file untouched', async () => {
    const dbPath = corruptFixture()
    const before = readFileSync(dbPath)

    let error: unknown
    try {
      await openCliDatabase(dbPath)
    } catch (e) {
      error = e
    }

    // Matched on `code`, as a consumer must — never `instanceof`, which fails
    // across duplicate copies of @skillsmith/core between CLI and MCP server.
    expect(isCorruptDatabaseError(error)).toBe(true)
    expect((error as { path: string }).path).toBe(dbPath)

    // The file survived, and nothing was left beside it. The old behaviour
    // renamed the MAIN FILE ONLY, orphaning any `-wal` against a rebuilt
    // database — which is what ADR-175 § 1 forbids.
    expect(readFileSync(dbPath).equals(before)).toBe(true)
    expect(readdirSync(tempDir).filter((f) => f.includes('.corrupt'))).toHaveLength(0)
    expect(readdirSync(tempDir).sort()).toEqual(['skills.db'])
  })

  it('refuses identically on a SECOND open — the file is still there to refuse', async () => {
    // The arm a single-call assertion cannot replace. The old code deleted or
    // renamed on call 1, so call 2 saw an ABSENT database and succeeded — which
    // is how `list` came to report "Up to date" for every skill one run after
    // the refusal SMI-6946 added. State diverged only on the later invocation.
    const dbPath = corruptFixture()

    await expect(openCliDatabase(dbPath)).rejects.toThrow(/is corrupt and cannot be read/)
    await expect(openCliDatabase(dbPath)).rejects.toThrow(/is corrupt and cannot be read/)
    expect(existsSync(dbPath)).toBe(true)
  })

  it('still opens a healthy database, and REOPENS an existing one — the control', async () => {
    // Two properties, because the first alone is not enough. A review mutation
    // measured this: replacing the whole wrapper body with an unconditional
    // `throw corruptDatabaseError(...)` gated on `existsSync(path)` passed all
    // seven arms in this file, because no arm opened a pre-existing HEALTHY
    // on-disk database. The refusal arms use a corrupt file and the old control
    // used an ABSENT path, so nothing distinguished "this file is corrupt" from
    // "this file exists". The removed SMI-4484 block held this file's only
    // on-disk reopen; that coverage went with it.
    //
    // So: create, close, then reopen the SAME populated path. The reopen is the
    // discriminator, and it also exercises `initializeSchema` against a file
    // that already has a schema — the wrapper's actual documented job.
    tempDir = mkdtempSync(join(tmpdir(), `smi6961-ok-${Date.now()}-`))
    const dbPath = join(tempDir, 'skills.db')

    const first = await openCliDatabase(dbPath)
    try {
      expect(new SkillRepository(first).count()).toBe(0)
    } finally {
      closeDatabase(first)
    }

    expect(existsSync(dbPath)).toBe(true)

    const second = await openCliDatabase(dbPath)
    try {
      expect(new SkillRepository(second).count()).toBe(0)
    } finally {
      closeDatabase(second)
    }
  })
})

/**
 * SMI-6961 review F4: the handle is closed on EVERY failure path.
 *
 * The step-3 commit led with this fix — the previous version closed the handle
 * only on the branch that went on to rebuild, so a non-corruption failure
 * leaked it. Nothing constrained it. A review mutation measured the gap:
 * deleting the close block entirely left all seven arms above green, because
 * every one of them fails inside `createDatabaseAsync`, before a handle exists.
 *
 * This arm is the only one that opens successfully and THEN fails, which is the
 * single shape where a close is owed.
 */
describe('SMI-6961 F4: openCliDatabase closes the handle when initializeSchema fails', () => {
  afterEach(() => {
    inject.fakeDb = null
    inject.schemaThrows = false
  })

  it('closes the opened handle and still propagates the error', async () => {
    let closes = 0
    inject.fakeDb = {
      close: () => {
        closes += 1
      },
    }
    inject.schemaThrows = true

    await expect(openCliDatabase('/tmp/smi6961-f4-unused.db')).rejects.toThrow(
      /injected initializeSchema failure/
    )

    // The load-bearing assertion. The error propagates with or without the
    // close block, so only this distinguishes the fixed code from the leak.
    expect(closes).toBe(1)
  })

  it('does not close anything when the open itself succeeds — the control', async () => {
    // Without this, a wrapper that closed the handle unconditionally (breaking
    // every healthy caller) would satisfy the arm above.
    let closes = 0
    inject.fakeDb = {
      close: () => {
        closes += 1
      },
    }
    inject.schemaThrows = false

    const db = await openCliDatabase('/tmp/smi6961-f4-unused.db')

    expect(db).toBe(inject.fakeDb)
    expect(closes).toBe(0)
  })
})
