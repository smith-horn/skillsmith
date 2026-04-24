/**
 * SMI-4450 Wave 1 Step 3 — SQLite instrumentation writer.
 *
 * Append-only writer for `~/.claude/projects/<encoded-cwd>/retrieval-logs.db`.
 *
 * Runs host-side only. In Docker (`IS_DOCKER=true`) this becomes a no-op per
 * SPARC §S4 "Deployment boundary". The DB is stamped with `owner_user` on
 * first write; subsequent opens compare against `os.userInfo().username`
 * and refuse to write on mismatch ($USER guard).
 *
 * DB handle is cached at module scope and held for the process lifetime —
 * matches better-sqlite3's synchronous model and the SPARC "append-only
 * module" contract. Tests call `closeRetrievalLog()` between cases.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type BetterSqlite3 from 'better-sqlite3'

import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_SQL,
  type FrontmatterLintEvent,
  type RetrievalEvent,
} from './schema.js'

// ESM-compatible require for native module (matches search.ts pattern for
// @ruvector/core and betterSqlite3Driver.ts in @skillsmith/core).
const require = createRequire(import.meta.url)

const ROW_COUNT_WARNING_THRESHOLD = 10_000

let cachedDb: BetterSqlite3.Database | null = null
let rowCountWarningEmitted = false
let dockerWarningEmitted = false
let ownerMismatchWarningEmitted = false

/**
 * Close the cached DB handle (if any). Test-only; production code never
 * calls this — the handle's lifetime matches the process.
 */
export function closeRetrievalLog(): void {
  if (cachedDb) {
    try {
      cachedDb.close()
    } catch {
      // ignore close errors — handle may already be stale
    }
    cachedDb = null
  }
  rowCountWarningEmitted = false
  dockerWarningEmitted = false
  ownerMismatchWarningEmitted = false
}

/**
 * Encode an absolute filesystem path the way Claude Code does for its
 * `~/.claude/projects/` subdirectories: replace each `/` with `-`.
 *
 * `/Users/foo/bar` → `-Users-foo-bar`
 */
function encodeProjectPath(abs: string): string {
  return abs.replace(/\//g, '-')
}

/**
 * Walk up from `start` until a directory is found that contains `.git` as
 * a directory (not a file — worktrees have `.git` as a file pointing to
 * the main repo's gitdir). Returns the first such ancestor, or `null` if
 * none is found before filesystem root.
 */
function findMainRepoRoot(start: string): string | null {
  let current = resolve(start)
  // Safety cap — git worktrees live inside the main repo, so depth is small.
  for (let i = 0; i < 64; i += 1) {
    const gitPath = join(current, '.git')
    if (existsSync(gitPath)) {
      try {
        const st = statSync(gitPath)
        if (st.isDirectory()) return current
      } catch {
        // unreadable — treat as missing, keep walking
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/**
 * Resolve the canonical project dir for the DB path. For worktrees inside
 * `<repo>/.worktrees/<name>/`, this returns `<repo>` (the main repo) so
 * all worktrees on the same project share one `retrieval-logs.db`.
 *
 * Falls back to `process.cwd()` if no main repo ancestor is found.
 */
function resolveProjectDir(): string {
  const cwd = process.cwd()
  const mainRepo = findMainRepoRoot(cwd)
  return mainRepo ?? cwd
}

/**
 * `~/.claude/projects/<encoded-cwd>/retrieval-logs.db`.
 *
 * Test-only override: `RETRIEVAL_LOG_DIR_OVERRIDE`, if set, is used as the
 * final DB directory verbatim (no encoding, no HOME prefix). Ignored in
 * production (`NODE_ENV === 'production'`) to prevent env-var redirection.
 */
function resolveDbPath(): { dir: string; dbPath: string } {
  const override = process.env.RETRIEVAL_LOG_DIR_OVERRIDE
  if (override && process.env.NODE_ENV !== 'production') {
    const dir = resolve(override)
    return { dir, dbPath: join(dir, 'retrieval-logs.db') }
  }
  const project = resolveProjectDir()
  const encoded = encodeProjectPath(project)
  const dir = join(homedir(), '.claude', 'projects', encoded)
  return { dir, dbPath: join(dir, 'retrieval-logs.db') }
}

/**
 * Returns true if the caller is running inside the Skillsmith Docker dev
 * container. SPARC §S4 requires the writer to no-op in that case.
 */
function isDocker(): boolean {
  return process.env.IS_DOCKER === 'true'
}

/**
 * Lazy-open (or return cached) DB handle. Performs:
 *   1. Docker guard (returns null → caller no-ops).
 *   2. mkdir -p with mode 0700 on the project dir.
 *   3. Runs SCHEMA_SQL (idempotent — IF NOT EXISTS).
 *   4. On first open: stamps `meta` rows (schema_version, owner_user, created_at).
 *   5. On subsequent opens: compares `meta.owner_user` to current $USER;
 *      mismatch → emit console.warn, return null, caller no-ops.
 *
 * Returns null on any error so callers (logRetrievalEvent, logFrontmatterLintEvent)
 * degrade to a silent no-op rather than throwing into instrumentation callers.
 */
function openDb(): BetterSqlite3.Database | null {
  if (cachedDb) return cachedDb

  if (isDocker()) {
    if (!dockerWarningEmitted) {
      console.warn('[retrieval-logs] running in Docker; skipping write')
      dockerWarningEmitted = true
    }
    return null
  }

  try {
    const { dir, dbPath } = resolveDbPath()

    // mode 0700 — user-scoped, private log store (SPARC §S4).
    mkdirSync(dir, { recursive: true, mode: 0o700 })

    const isFreshFile = !existsSync(dbPath)

    // better-sqlite3 is CJS; createRequire keeps the module.exports shape.
    const Database = require('better-sqlite3') as typeof BetterSqlite3
    const db = new Database(dbPath)

    db.exec(SCHEMA_SQL)

    const currentUser = userInfo().username

    if (isFreshFile) {
      const insertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      const stampTx = db.transaction(() => {
        insertMeta.run('schema_version', String(CURRENT_SCHEMA_VERSION))
        insertMeta.run('owner_user', currentUser)
        insertMeta.run('created_at', new Date().toISOString())
      })
      stampTx()
    } else {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'owner_user'").get() as
        | { value: string }
        | undefined
      const stampedOwner = row?.value
      if (stampedOwner && stampedOwner !== currentUser) {
        if (!ownerMismatchWarningEmitted) {
          console.warn('[retrieval-logs] owner mismatch; refusing to write')
          ownerMismatchWarningEmitted = true
        }
        try {
          db.close()
        } catch {
          // ignore close errors
        }
        return null
      }
    }

    cachedDb = db
    return db
  } catch (err) {
    console.warn('[retrieval-logs] failed to open DB; writes will be skipped:', err)
    return null
  }
}

/**
 * Emit a one-shot warning if `retrieval_events` has crossed the
 * ROW_COUNT_WARNING_THRESHOLD. Wave 1 does not auto-truncate — Wave 3
 * ships a rotation policy (SPARC §S4 "Rotation / pruning").
 */
function maybeWarnRowCount(db: BetterSqlite3.Database): void {
  if (rowCountWarningEmitted) return
  const row = db.prepare('SELECT COUNT(*) AS c FROM retrieval_events').get() as { c: number }
  if (row.c > ROW_COUNT_WARNING_THRESHOLD) {
    console.warn('[retrieval-logs] DB has >10k rows; consider Wave 3 rotation')
    rowCountWarningEmitted = true
  }
}

/**
 * Append a single row to `retrieval_events`.
 *
 * No-ops (with a console.warn) when running in Docker or when the DB's
 * stamped `owner_user` does not match the current $USER.
 */
export function logRetrievalEvent(evt: RetrievalEvent): void {
  const db = openDb()
  if (!db) return

  try {
    const stmt = db.prepare(
      `INSERT INTO retrieval_events (
        session_id, ts, trigger, query, top_k_results, cited_in_output,
        tokens_before, tokens_after, hook_outcome, downstream_artifact_id, outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    stmt.run(
      evt.sessionId,
      evt.ts,
      evt.trigger,
      evt.query,
      evt.topKResults,
      evt.citedInOutput ?? null,
      evt.tokensBefore ?? null,
      evt.tokensAfter ?? null,
      evt.hookOutcome ?? null,
      evt.downstreamArtifactId ?? null,
      evt.outcome ?? null
    )

    maybeWarnRowCount(db)
  } catch (err) {
    console.warn('[retrieval-logs] logRetrievalEvent failed:', err)
  }
}

/**
 * Append a single row to `frontmatter_lint_events`.
 *
 * No-ops (with a console.warn) when running in Docker or when the DB's
 * stamped `owner_user` does not match the current $USER.
 */
export function logFrontmatterLintEvent(evt: FrontmatterLintEvent): void {
  const db = openDb()
  if (!db) return

  try {
    const stmt = db.prepare(
      `INSERT INTO frontmatter_lint_events (ts, retro_path, outcome) VALUES (?, ?, ?)`
    )
    stmt.run(evt.ts, evt.retroPath, evt.outcome)

    maybeWarnRowCount(db)
  } catch (err) {
    console.warn('[retrieval-logs] logFrontmatterLintEvent failed:', err)
  }
}
