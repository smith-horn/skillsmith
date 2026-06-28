#!/usr/bin/env node
/**
 * SMI-4450 Wave 1 Step 5 — audit-standards bridge to retrieval-logs.db.
 *
 * Called by `scripts/lib/retro-frontmatter.mjs` once per retro file during
 * pre-commit lint. Purpose: append rows to `frontmatter_lint_events` without
 * the ~300ms tsx startup cost of calling into writer.ts.
 *
 * Contract (SPARC addendum §S2 option C):
 * - INSERT-only. Does NOT create schema. If the table doesn't exist (writer.ts
 *   never ran), warn to stderr and exit 0 — telemetry is best-effort.
 * - No-ops when IS_DOCKER=true per SPARC §S4 deployment boundary.
 * - $USER guard defers to writer.ts's meta-table stamp. If owner mismatches,
 *   the prepared INSERT fails at the better-sqlite3 layer and we silently
 *   exit 0.
 * - Silent on DB missing (writer.ts has never run). Priming via
 *   `npm run retrieval-log:prime` or any MCP search will bootstrap.
 *
 * Usage:
 *   node scripts/retrieval-log-cli.mjs frontmatter-lint <outcome> <retro-path>
 *   outcome ∈ {complete, incomplete, bypassed_no_verify}
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { resolveTelemetryProjectDir } from './lib/project-dir.mjs'

const ALLOWED_OUTCOMES = ['complete', 'incomplete', 'bypassed_no_verify']

function main() {
  if (process.env.IS_DOCKER === 'true') return 0

  const [, , subcommand, outcome, retroPath] = process.argv

  if (subcommand !== 'frontmatter-lint') {
    console.error(`[retrieval-log-cli] Unknown subcommand: ${subcommand ?? '<empty>'}`)
    console.error(
      'Usage: retrieval-log-cli.mjs frontmatter-lint <complete|incomplete|bypassed_no_verify> <retro-path>'
    )
    return 2
  }

  if (!ALLOWED_OUTCOMES.includes(outcome)) {
    console.error(`[retrieval-log-cli] Invalid outcome: ${outcome ?? '<empty>'}`)
    return 2
  }

  if (!retroPath || retroPath.length === 0) {
    console.error('[retrieval-log-cli] retro-path is required')
    return 2
  }

  const dbPath = resolveDbPath()
  if (!dbPath || !existsSync(dbPath)) return 0

  let db = null
  try {
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    db = new Database(dbPath)
    db.prepare(
      'INSERT INTO frontmatter_lint_events (ts, retro_path, outcome) VALUES (?, ?, ?)'
    ).run(new Date().toISOString(), retroPath, outcome)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[retrieval-log-cli] insert failed: ${msg}`)
  } finally {
    try {
      db?.close()
    } catch {
      /* already-closed handles are fine to ignore */
    }
  }

  return 0
}

/**
 * Resolve the DB path via the shared resolver so this CLI writes to the SAME
 * telemetry DB as writer.ts. SMI-5419 fixed a prior bug here: it encoded the raw
 * cwd (not the MAIN repo root), so in any worktree it wrote frontmatter_lint_events
 * to a DIFFERENT DB than the writer — silently splitting the feed.
 *   1. `RETRIEVAL_LOG_DIR_OVERRIDE` (test-only; ignored in production NODE_ENV).
 *   2. `resolveTelemetryProjectDir()` — main-repo root, casing reconciled.
 */
function resolveDbPath() {
  const override = process.env.RETRIEVAL_LOG_DIR_OVERRIDE
  if (override && process.env.NODE_ENV !== 'production') {
    return join(override, 'retrieval-logs.db')
  }
  return join(resolveTelemetryProjectDir().dir, 'retrieval-logs.db')
}

process.exit(main())
