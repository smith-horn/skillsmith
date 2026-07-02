/**
 * @fileoverview Journal file-layout + process session-id resolution
 *               (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/core/journal/path
 *
 * File layout: `<configDir>/journal/journal.jsonl` — JSON Lines (one JSON
 * object per line), append-only. Chosen over a single JSON array because:
 *   - Appends are O(1) — no read-modify-rewrite of the whole file, unlike
 *     `audit/namespace-overrides.ts`'s ledger (appropriate there because
 *     that file is small, mutable config, not an ever-growing log).
 *   - A line is the unit of both a write and a crash boundary: fsync'ing
 *     one appended line can't corrupt any earlier line, so a torn last
 *     write degrades to "one unreadable tail line" rather than an
 *     unparseable whole file — exactly what `reader.ts`'s
 *     "corrupt tail = report, never throw" contract needs.
 *   - It's streamable / greppable for ad-hoc forensics without a parser.
 *
 * `SKILLSMITH_JOURNAL_DIR` overrides the default, mirroring
 * `SKILLSMITH_AGENT_MARKER_DIR` (`../telemetry/agent-marker.ts`) — needed
 * because macOS `os.homedir()` resolves via `getpwuid()` and ignores
 * `process.env.HOME` mutations in tests.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getConfigDir } from '../config/index.js'

/** Env var overriding the journal directory (test isolation). */
export const JOURNAL_DIR_ENV_VAR = 'SKILLSMITH_JOURNAL_DIR'

function getJournalDir(): string {
  const override = process.env[JOURNAL_DIR_ENV_VAR]
  return override && override.length > 0 ? override : join(getConfigDir(), 'journal')
}

/** Absolute path to the journal file. Read-time resolved (not memoised) so
 * tests can flip `SKILLSMITH_JOURNAL_DIR` between cases. */
export function getJournalFilePath(): string {
  return join(getJournalDir(), 'journal.jsonl')
}

let processSessionId: string | undefined

/**
 * Process-lifetime session id shared by every journal record this server
 * process writes, and by the in-process undo stack
 * (`@skillsmith/mcp-server`'s `tools/apply-session.helpers.ts`) that keys
 * "session-scoped undo" off the same lifetime: restarting the MCP server
 * both mints a new session id here AND resets the undo stack (a fresh
 * module load), so the two always agree without explicit coordination.
 */
export function getJournalSessionId(): string {
  if (processSessionId === undefined) {
    processSessionId = randomUUID()
  }
  return processSessionId
}

/**
 * Test-only reset. The session id is memoised for the process lifetime by
 * design, but a single Vitest process runs many logically-independent
 * "sessions" (test cases) — call this in `afterEach`/`beforeEach` to avoid
 * cross-test bleed.
 */
export function resetJournalSessionIdForTests(): void {
  processSessionId = undefined
}
