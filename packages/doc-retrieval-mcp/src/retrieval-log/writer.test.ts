import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import type BetterSqlite3 from 'better-sqlite3'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof BetterSqlite3

/**
 * The writer caches a `Database` handle at module scope. Each test needs an
 * isolated scratch dir AND a fresh module instance, so we `vi.resetModules()`
 * + re-import inside each case. `RETRIEVAL_LOG_DIR_OVERRIDE` points the
 * project-dir resolver at the scratch dir so HOME is never touched.
 */
async function freshWriter(): Promise<typeof import('./writer.js')> {
  vi.resetModules()
  return import('./writer.js')
}

let scratch: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'retrieval-log-'))
  process.env.RETRIEVAL_LOG_DIR_OVERRIDE = scratch
  delete process.env.IS_DOCKER
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  const { closeRetrievalLog } = await import('./writer.js')
  closeRetrievalLog()
  warnSpy.mockRestore()
  delete process.env.RETRIEVAL_LOG_DIR_OVERRIDE
  delete process.env.IS_DOCKER
  rmSync(scratch, { recursive: true, force: true })
})

describe('logRetrievalEvent', () => {
  it('writes a row with all columns matching input', async () => {
    const { logRetrievalEvent } = await freshWriter()
    logRetrievalEvent({
      sessionId: 'sess-1',
      ts: '2026-04-24T12:00:00Z',
      trigger: 'skill_docs_search',
      query: 'hello',
      topKResults: '[{"id":1}]',
      tokensBefore: 100,
      tokensAfter: 120,
      hookOutcome: 'primed',
    })

    const db = new Database(join(scratch, 'retrieval-logs.db'), { readonly: true })
    const rows = db.prepare('SELECT * FROM retrieval_events').all() as Array<{
      session_id: string
      ts: string
      trigger: string
      query: string
      top_k_results: string
      tokens_before: number
      tokens_after: number
      hook_outcome: string
      cited_in_output: string | null
      downstream_artifact_id: string | null
      outcome: string | null
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0].session_id).toBe('sess-1')
    expect(rows[0].trigger).toBe('skill_docs_search')
    expect(rows[0].query).toBe('hello')
    expect(rows[0].top_k_results).toBe('[{"id":1}]')
    expect(rows[0].tokens_before).toBe(100)
    expect(rows[0].hook_outcome).toBe('primed')
    expect(rows[0].cited_in_output).toBeNull()
    expect(rows[0].outcome).toBeNull()
    db.close()
  })
})

describe('logFrontmatterLintEvent', () => {
  it('writes a row', async () => {
    const { logFrontmatterLintEvent } = await freshWriter()
    logFrontmatterLintEvent({
      ts: '2026-04-24T12:00:00Z',
      retroPath: 'docs/internal/retros/foo.md',
      outcome: 'complete',
    })

    const db = new Database(join(scratch, 'retrieval-logs.db'), { readonly: true })
    const rows = db.prepare('SELECT * FROM frontmatter_lint_events').all() as Array<{
      retro_path: string
      outcome: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('complete')
    db.close()
  })
})

describe('$USER guard', () => {
  it('refuses to write when owner_user mismatches current $USER', async () => {
    // Pre-create the DB with a foreign owner_user stamp.
    const { SCHEMA_SQL } = await import('./schema.js')
    const dbPath = join(scratch, 'retrieval-logs.db')
    const seed = new Database(dbPath)
    seed.exec(SCHEMA_SQL)
    seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('owner_user', 'not-really-me')
    seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
    seed.close()
    // Sanity: we must not accidentally match the real $USER.
    expect(userInfo().username).not.toBe('not-really-me')

    const { logRetrievalEvent } = await freshWriter()
    logRetrievalEvent({
      sessionId: 's',
      ts: '2026-04-24T12:00:00Z',
      trigger: 'other',
      query: 'q',
      topKResults: '[]',
    })

    expect(warnSpy).toHaveBeenCalledWith('[retrieval-logs] owner mismatch; refusing to write')
    // No row should have been appended.
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare('SELECT COUNT(*) AS c FROM retrieval_events').get() as { c: number }
    expect(row.c).toBe(0)
    db.close()
  })
})

describe('Docker guard', () => {
  it('skips DB creation when IS_DOCKER=true', async () => {
    process.env.IS_DOCKER = 'true'
    const { logRetrievalEvent } = await freshWriter()
    logRetrievalEvent({
      sessionId: 's',
      ts: '2026-04-24T12:00:00Z',
      trigger: 'other',
      query: 'q',
      topKResults: '[]',
    })

    expect(warnSpy).toHaveBeenCalledWith('[retrieval-logs] running in Docker; skipping write')
    expect(existsSync(join(scratch, 'retrieval-logs.db'))).toBe(false)
  })
})

describe('schema idempotency', () => {
  it('second write does not re-insert meta rows', async () => {
    const { logRetrievalEvent } = await freshWriter()
    logRetrievalEvent({
      sessionId: 's',
      ts: '2026-04-24T12:00:00Z',
      trigger: 'other',
      query: 'q',
      topKResults: '[]',
    })
    logRetrievalEvent({
      sessionId: 's',
      ts: '2026-04-24T12:00:01Z',
      trigger: 'other',
      query: 'q',
      topKResults: '[]',
    })

    const db = new Database(join(scratch, 'retrieval-logs.db'), { readonly: true })
    const metaCount = db.prepare('SELECT COUNT(*) AS c FROM meta').get() as { c: number }
    // Exactly 3 meta rows: schema_version, owner_user, created_at.
    expect(metaCount.c).toBe(3)
    const eventCount = db.prepare('SELECT COUNT(*) AS c FROM retrieval_events').get() as {
      c: number
    }
    expect(eventCount.c).toBe(2)
    db.close()
  })
})

describe('row-count warning', () => {
  it('emits once when retrieval_events exceeds 10k rows', async () => {
    const { logRetrievalEvent } = await freshWriter()
    // First insert opens+stamps the DB.
    logRetrievalEvent({
      sessionId: 's',
      ts: '2026-04-24T12:00:00Z',
      trigger: 'other',
      query: 'q',
      topKResults: '[]',
    })

    // Bulk-insert the remaining rows directly via a raw handle — transaction
    // for speed — bypassing the writer to avoid re-running the COUNT() check
    // on every row.
    const dbPath = join(scratch, 'retrieval-logs.db')
    const raw = new Database(dbPath)
    const ins = raw.prepare(
      'INSERT INTO retrieval_events (session_id, ts, trigger, query, top_k_results) VALUES (?, ?, ?, ?, ?)'
    )
    const bulk = raw.transaction((n: number) => {
      for (let i = 0; i < n; i += 1) {
        ins.run('s', '2026-04-24T12:00:00Z', 'other', 'q', '[]')
      }
    })
    // Seed to exactly 10_000 so the next writer call brings total to 10_001.
    bulk(9_999)
    raw.close()

    // Now trigger another writer call — count becomes 10_001 > threshold.
    logRetrievalEvent({
      sessionId: 's',
      ts: '2026-04-24T12:00:02Z',
      trigger: 'other',
      query: 'q',
      topKResults: '[]',
    })
    // And one more to prove it only fires once.
    logRetrievalEvent({
      sessionId: 's',
      ts: '2026-04-24T12:00:03Z',
      trigger: 'other',
      query: 'q',
      topKResults: '[]',
    })

    const rowCountCalls = warnSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('>10k rows')
    )
    expect(rowCountCalls).toHaveLength(1)
  })
})

describe('RETRIEVAL_LOG_DIR_OVERRIDE production guard', () => {
  it('ignores the override and falls through to real resolver when NODE_ENV=production', async () => {
    // Set NODE_ENV=production — override must be ignored.
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    // The override env var is still set (from beforeEach) but must be ignored.
    // Redirect HOME to scratch so we don't touch the real ~/.claude/projects.
    const fakeHome = join(scratch, 'home-prod')
    mkdirSync(fakeHome, { recursive: true })
    const originalHome = process.env.HOME
    process.env.HOME = fakeHome

    // We also need to redirect cwd so the project-dir resolver doesn't walk up
    // to the real repo root (which has a .git dir) and write to the real home.
    // Spy on cwd to return a leaf with no .git ancestor inside fakeHome.
    const fakeProject = join(fakeHome, 'project')
    mkdirSync(fakeProject, { recursive: true })
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fakeProject)

    try {
      const { logRetrievalEvent } = await freshWriter()
      logRetrievalEvent({
        sessionId: 's',
        ts: '2026-04-24T12:00:00Z',
        trigger: 'other',
        query: 'q',
        topKResults: '[]',
      })

      // The DB must NOT be in the scratch override dir.
      expect(existsSync(join(scratch, 'retrieval-logs.db'))).toBe(false)
      // The DB must be under fakeHome/.claude/projects/ instead.
      const encoded = fakeProject.replace(/\//g, '-')
      const expectedPath = join(fakeHome, '.claude', 'projects', encoded, 'retrieval-logs.db')
      expect(existsSync(expectedPath)).toBe(true)
    } finally {
      cwdSpy.mockRestore()
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
    }
  })
})

describe('write error resilience', () => {
  it('emits console.warn and does not throw when the DB insert fails', async () => {
    // Open the DB normally first so cachedDb is populated.
    const { logRetrievalEvent, closeRetrievalLog: close } = await freshWriter()
    logRetrievalEvent({
      sessionId: 's',
      ts: '2026-04-24T12:00:00Z',
      trigger: 'other',
      query: 'q',
      topKResults: '[]',
    })

    // Close the DB handle so the next call re-opens — but corrupt the file
    // first so open fails, exercising the openDb() catch branch.
    close()
    // Overwrite the DB with garbage so better-sqlite3 throws on open.
    const { writeFileSync: wf } = await import('node:fs')
    wf(join(scratch, 'retrieval-logs.db'), Buffer.from('not-a-sqlite-db'))

    // This must not throw.
    expect(() => {
      logRetrievalEvent({
        sessionId: 's2',
        ts: '2026-04-24T12:00:01Z',
        trigger: 'other',
        query: 'q',
        topKResults: '[]',
      })
    }).not.toThrow()

    expect(
      warnSpy.mock.calls.some(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('failed to open DB')
      )
    ).toBe(true)
  })
})

describe('worktree path canonicalization', () => {
  it('uses main repo path (dir .git) not worktree path (file .git)', async () => {
    // Build a fake repo + worktree under the scratch tmpdir.
    const mainRepo = join(scratch, 'main-repo')
    const worktree = join(mainRepo, '.worktrees', 'feat-x')
    mkdirSync(join(mainRepo, '.git'), { recursive: true }) // real .git DIR
    mkdirSync(worktree, { recursive: true })
    // Worktrees have .git as a FILE pointing at the main gitdir.
    writeFileSync(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/feat-x\n')

    // Point override at a location that will NOT match the chosen path, so
    // we force the writer onto its real resolver. The writer checks the env
    // var first and short-circuits — so for this test we must NOT set it.
    delete process.env.RETRIEVAL_LOG_DIR_OVERRIDE

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(worktree)

    // Redirect HOME so the test doesn't touch the real ~/.claude/projects.
    const fakeHome = join(scratch, 'home')
    mkdirSync(fakeHome, { recursive: true })
    const originalHome = process.env.HOME
    process.env.HOME = fakeHome

    try {
      const { logRetrievalEvent } = await freshWriter()
      logRetrievalEvent({
        sessionId: 's',
        ts: '2026-04-24T12:00:00Z',
        trigger: 'other',
        query: 'q',
        topKResults: '[]',
      })

      // Expected encoded path uses mainRepo, NOT worktree.
      const encoded = mainRepo.replace(/\//g, '-')
      const expectedDir = join(fakeHome, '.claude', 'projects', encoded)
      expect(existsSync(join(expectedDir, 'retrieval-logs.db'))).toBe(true)

      // The worktree path must NOT be the one used.
      const worktreeEncoded = worktree.replace(/\//g, '-')
      expect(existsSync(join(fakeHome, '.claude', 'projects', worktreeEncoded))).toBe(false)
    } finally {
      cwdSpy.mockRestore()
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })
})
