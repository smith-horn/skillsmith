/**
 * SMI-4450 Wave 1 Step 3 — SQLite instrumentation schema.
 *
 * Pure constants + types for the `retrieval-logs.db` file under
 * `~/.claude/projects/<encoded-cwd>/`. Consumed by ./writer.ts.
 *
 * See docs/internal/implementation/smi-4450-sparc-research.md §S4 for the
 * authoritative spec: deployment boundary, $USER guard, future-proofing
 * (PRAGMA user_version bump to 2 in Wave 2), and rotation policy.
 */

export const CURRENT_SCHEMA_VERSION = 1 as const

/**
 * Allowed values for `retrieval_events.trigger` (SQL CHECK constraint).
 */
export type RetrievalTrigger = 'session_start_priming' | 'skill_docs_search' | 'other'

/**
 * Allowed values for `retrieval_events.hook_outcome` (SQL CHECK constraint).
 * Populated by the SessionStart hook on every priming event; required for
 * the Step 7b soak gate (<2% partial_failure/timeout over ≥20 events).
 */
export type RetrievalHookOutcome =
  | 'primed'
  | 'skipped_branch'
  | 'skipped_source'
  | 'partial_failure'
  | 'timeout'
  | 'disabled'

/**
 * Allowed values for `retrieval_events.outcome` (Wave 2 field, nullable in
 * Wave 1).
 */
export type RetrievalOutcome = 'merged' | 'reverted' | 'abandoned' | 'wip'

/**
 * Allowed values for `frontmatter_lint_events.outcome` (SQL CHECK constraint).
 */
export type FrontmatterLintOutcome = 'complete' | 'incomplete' | 'bypassed_no_verify'

/**
 * Shape of a single `retrieval_events` row when inserted by the writer.
 *
 * `id` is omitted — SQLite auto-assigns via `INTEGER PRIMARY KEY
 * AUTOINCREMENT`. `top_k_results` and `cited_in_output` are JSON-encoded
 * strings (the writer does not marshal them — callers supply the encoded
 * text to keep the writer schema-agnostic).
 */
export interface RetrievalEvent {
  sessionId: string
  ts: string // ISO-8601 UTC
  trigger: RetrievalTrigger
  query: string // truncated to 4 KB by caller
  topKResults: string // JSON: [{chunk_id, file_path, line_range, score}]
  citedInOutput?: string | null // JSON or null; Wave 2 populates
  tokensBefore?: number | null
  tokensAfter?: number | null
  hookOutcome?: RetrievalHookOutcome | null
  downstreamArtifactId?: string | null // Wave 2
  outcome?: RetrievalOutcome | null // Wave 2
}

/**
 * SMI-4549 Wave 2 — outage marker payload (`<projectDir>/retrieval-log.outage.json`).
 *
 * Written by `writer.ts` openDb() when the writer enters a no-op branch that
 * the user is expected to remediate (binding load failure, owner mismatch).
 * NOT written for the Docker no-op branch — Docker is the documented "I don't
 * write" mode, not an outage. Cleared on the next successful open. The probe
 * (`probe.ts`) reads this without ever importing better-sqlite3 so a host
 * with a broken binding still surfaces a banner.
 */
export interface RetrievalLogOutageMarker {
  ts: string // ISO-8601 UTC of the failed open attempt
  reason: 'binding_unavailable' | 'owner_mismatch'
  error: string // truncated stringified error (≤500 chars)
  hint: string // remediation pointer surfaced in the priming banner
}

/**
 * Shape of a single `frontmatter_lint_events` row when inserted by the writer.
 */
export interface FrontmatterLintEvent {
  ts: string // ISO-8601 UTC
  retroPath: string
  outcome: FrontmatterLintOutcome
}

/**
 * Standalone DDL fragment for `frontmatter_lint_events` (SMI-4450 Step 5).
 * Exported so the Step-5 test suite can runtime-introspect column layout
 * via `PRAGMA table_info(frontmatter_lint_events)` and compare against
 * expected columns. The writer does NOT execute this fragment standalone —
 * `SCHEMA_SQL` is the single execution path. This constant is documentation
 * + test reference only. The test `SCHEMA_SQL.includes(FRONTMATTER_LINT_EVENTS_DDL)`
 * enforces that edits to one also land in the other.
 */
export const FRONTMATTER_LINT_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS frontmatter_lint_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  retro_path TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'incomplete', 'bypassed_no_verify'))
);`

/**
 * Full DDL for a fresh `retrieval-logs.db`. Idempotent (all CREATE statements
 * use `IF NOT EXISTS`). Run via `db.exec(SCHEMA_SQL)` on first open.
 *
 * Matches SPARC research §S4 exactly. Do not drift this string without
 * bumping CURRENT_SCHEMA_VERSION and adding a migration path in writer.ts.
 */
export const SCHEMA_SQL = `PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('session_start_priming', 'skill_docs_search', 'other')),
  query TEXT NOT NULL,
  top_k_results TEXT NOT NULL,
  cited_in_output TEXT,
  tokens_before INTEGER,
  tokens_after INTEGER,
  hook_outcome TEXT CHECK (hook_outcome IS NULL OR hook_outcome IN
    ('primed', 'skipped_branch', 'skipped_source', 'partial_failure', 'timeout', 'disabled')),
  downstream_artifact_id TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('merged', 'reverted', 'abandoned', 'wip'))
);

CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_events(session_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_ts ON retrieval_events(ts);
CREATE INDEX IF NOT EXISTS idx_retrieval_trigger ON retrieval_events(trigger);

CREATE TABLE IF NOT EXISTS frontmatter_lint_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  retro_path TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'incomplete', 'bypassed_no_verify'))
);

CREATE INDEX IF NOT EXISTS idx_frontmatter_ts ON frontmatter_lint_events(ts);
`
