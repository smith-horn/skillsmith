/**
 * SMI-5615: Shared types for the production error-logging module
 * (`packages/core/src/logging/`).
 *
 * Field list and shape verified against
 * docs/internal/implementation/production-error-logging.md §1.
 */

/** Log severity, ordered `debug < info < warn < error`. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Which invocation surface produced a record — one JSONL file per surface.
 * `'doc-retrieval'` (SMI-5793) is the fire-and-forget `.husky/post-commit`
 * reindex CLI (`packages/doc-retrieval-mcp/src/cli.ts`) — kept distinct from
 * `'cli'` so its `skillsmith-doc-retrieval-<date>.jsonl` file never
 * interleaves with `@skillsmith/cli`'s own records.
 */
export type Surface = 'mcp' | 'cli' | 'vscode' | 'doc-retrieval'

/** Normalized, already-redacted error shape embedded in a `LogRecord`. */
export interface LogRecordError {
  name: string
  message: string
  /** Redacted, capped to the first 20 frames. */
  stack?: string
}

/**
 * One JSON-line record written to
 * `~/.skillsmith/logs/skillsmith-<surface>-<YYYY-MM-DD>.jsonl`.
 *
 * Field order mirrors the plan's listing (ts, level, surface, event, msg,
 * err, correlationId, toolOrCommand, skillId, version, pid) — `logger.ts`
 * constructs records in this order so `JSON.stringify` output (insertion
 * order for string keys) reads consistently on disk.
 */
export interface LogRecord {
  ts: string
  level: LogLevel
  surface: Surface
  /** Short machine-readable event/category tag. Defaults to `level` when omitted. */
  event: string
  /** Redacted human-readable message. */
  msg: string
  err?: LogRecordError
  correlationId?: string
  toolOrCommand?: string
  skillId?: string
  version: string
  pid: number
  /**
   * Additional structured context beyond the plan's core field list —
   * carries forward the old (dead) `mcp-server/src/logger.ts`'s freeform
   * `details` capability so callers don't lose arbitrary context. Redacted
   * via `redactSensitiveObject` like every other field. Omitted entirely
   * when the caller passes no extra keys.
   */
  details?: Record<string, unknown>
}

/**
 * The `details` argument accepted by every `Logger` method. Recognized keys
 * are lifted into their own `LogRecord` fields; anything else is folded into
 * `LogRecord.details` (redacted). Matches the old logger's
 * `(message: string, details?: unknown)` call shape while giving structure to
 * the fields the new record format cares about.
 */
export interface LogDetails {
  /** Short machine-readable event/category tag for this record. */
  event?: string
  /** Raw error to normalize into `LogRecord.err` (redacted). */
  err?: unknown
  /** MCP tool name or CLI command name associated with this record. */
  toolOrCommand?: string
  /** Skill ID associated with this record, when applicable. */
  skillId?: string
  [key: string]: unknown
}
