/**
 * SMI-5615: Shared structured JSON-line logger.
 *
 * Generalized from the dead `packages/mcp-server/src/logger.ts` (SMI-883
 * redaction) into a surface-agnostic module usable by the MCP server, CLI,
 * and VS Code extension independently — `createLogger(surface)` is a
 * factory, not a singleton, so each host process can mint its own logger
 * (optionally stamped with its own package version) while still writing to
 * per-surface files that are safe to share across processes for the same
 * surface (see `rotation.ts`).
 *
 * Call-site invariants (see
 * docs/internal/implementation/production-error-logging.md §1 and the
 * Shared-State / Coordination Audit table, F2/F3):
 *
 *   - `getCorrelationId()` is read SYNCHRONOUSLY at the call site, inside
 *     `buildRecord`, never inside an async flush/rotation callback (F3) — a
 *     deferred read could observe a different call's (or no) correlation ID
 *     once the originating call's `AsyncLocalStorage` scope has unwound.
 *   - The full JSON-line record (including the synchronously-read
 *     correlation ID and synchronously-applied redaction) is built and
 *     `JSON.stringify`'d BEFORE handing the string off to `rotation.ts`'s
 *     serialized per-surface writer (F2) — only the actual disk write may
 *     complete asynchronously; by the time it starts, the record content is
 *     already frozen.
 *   - Logger calls never throw. Any failure while assembling or persisting a
 *     record falls back to `console.error`/`console.warn` (matching level,
 *     with `info`/`debug` also routed to `console.error`) rather than being
 *     fully silent — stderr remains the safety net of last resort. This
 *     differs from the old logger's "silently fail" comment intent, which is
 *     no longer acceptable once this is the only durable failure signal.
 *   - `warn`/`error` ALWAYS mirror to `console.warn`/`console.error`,
 *     synchronously, regardless of whether the disk write succeeds — this is
 *     NOT a failure-only fallback for those two levels (only `info`/`debug`
 *     use console purely as a write-failure fallback). This is what makes
 *     `logger.error`/`logger.warn` a safe drop-in replacement for existing
 *     `console.error`/`console.warn` call sites in the MCP server and CLI —
 *     the caller-visible terminal/stderr output stays identical to today,
 *     with redacted disk persistence added on top rather than instead of it.
 */

import { getCorrelationId } from './context.js'
import { redactSensitiveData, redactSensitiveObject, stripAnsi } from './redact.js'
import { writeLogLine } from './rotation.js'
import type { LogDetails, LogLevel, LogRecord, Surface } from './types.js'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const MAX_STACK_FRAMES = 20

/**
 * Accepts `'1'`/`'true'` (case-insensitive) — matches the existing
 * `SKILLSMITH_<FEATURE>_DISABLE` convention, e.g.
 * `isInventorySyncDisabledLocally()` at
 * `packages/core/src/config/device-identity.ts:124`
 * (`SKILLSMITH_INVENTORY_DISABLE`).
 */
function isLoggingDisabled(): boolean {
  const val = process.env.SKILLSMITH_ERROR_LOG_DISABLE
  if (!val) return false
  return val === '1' || val.toLowerCase() === 'true'
}

function configuredLevel(): LogLevel {
  const raw = process.env.SKILLSMITH_LOG_LEVEL?.toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw
  }
  return 'warn'
}

function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel()]
}

/**
 * Fallback console channel for a level. `warn` mirrors to `console.warn`
 * (stderr); everything else — including `info`/`debug`, which have no
 * dedicated stderr-only console method — falls back to `console.error`
 * (stderr) so a failure never lands on stdout. MCP servers must keep stdout
 * clean for the stdio JSON-RPC transport; `console.log`/`console.info` write
 * to stdout and would corrupt it.
 *
 * Always redacts `message` before printing (Mode-B diff-audit NEW-1): this is
 * the last-resort channel when the redacted disk record couldn't be built or
 * written, so it must independently uphold the same SMI-883 guarantee — never
 * pass the raw, un-redacted message straight to `console.*`.
 */
function consoleFallback(level: LogLevel, message: string): void {
  const redacted = redactSensitiveData(message)
  if (level === 'warn') {
    console.warn(redacted)
  } else {
    console.error(redacted)
  }
}

// SMI-5615 Mode-B (Wave 2 pass): ANSI stripped BEFORE redaction on every
// disk-bound field — see `stripAnsi`'s doc comment in `redact.ts` for why
// (embedded chalk escape codes are log noise AND can defeat the redaction
// regex's leading word-boundary check).
function redactForDisk(text: string): string {
  return redactSensitiveData(stripAnsi(text))
}

function normalizeError(err: unknown): LogRecord['err'] {
  if (err instanceof Error) {
    const frames = err.stack
      ? err.stack.split('\n').slice(0, MAX_STACK_FRAMES).join('\n')
      : undefined
    return {
      name: err.name,
      message: redactForDisk(err.message),
      stack: frames ? redactForDisk(frames) : undefined,
    }
  }
  if (typeof err === 'string') {
    return { name: 'Error', message: redactForDisk(err) }
  }
  if (err && typeof err === 'object') {
    const asRecord = err as Record<string, unknown>
    const name = typeof asRecord.name === 'string' ? asRecord.name : 'Error'
    const message =
      typeof asRecord.message === 'string'
        ? asRecord.message
        : safeStringify(redactSensitiveObject(asRecord))
    return { name, message: redactForDisk(message) }
  }
  return { name: 'Error', message: redactForDisk(String(err)) }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable value]'
  }
}

/**
 * Builds the complete, already-redacted `LogRecord` synchronously — this is
 * the F2/F3 boundary: everything below runs on the calling stack, before any
 * async write is even scheduled.
 */
function buildRecord(
  surface: Surface,
  level: LogLevel,
  version: string,
  message: string,
  details?: LogDetails
): LogRecord {
  // F3: correlation ID read synchronously, at the call site — never deferred.
  const correlationId = getCorrelationId()
  const { event, err, toolOrCommand, skillId, ...rest } = details ?? {}

  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    surface,
    event: typeof event === 'string' && event.length > 0 ? event : level,
    msg: redactForDisk(message),
    version,
    pid: process.pid,
  }

  if (correlationId) record.correlationId = correlationId
  if (typeof toolOrCommand === 'string') record.toolOrCommand = toolOrCommand
  if (typeof skillId === 'string') record.skillId = skillId
  if (err !== undefined) record.err = normalizeError(err)
  if (Object.keys(rest).length > 0) {
    record.details = redactSensitiveObject(rest) as Record<string, unknown>
  }

  return record
}

/**
 * Hands the fully-built record off to `rotation.ts`, AND mirrors `warn`/
 * `error` to console UNCONDITIONALLY (not only on a write failure) — per
 * plan §1: "the logger writes to disk AND still emits to stderr for warn/
 * error". This is the mechanism that lets `packages/mcp-server/src/index.ts`
 * and `packages/cli/src` replace their scattered `console.error`/`warn`
 * calls with `logger.error`/`warn` as a drop-in swap: the caller-visible
 * terminal/stderr output must be identical to today, with disk persistence
 * added on top — not replaced by it. `info`/`debug` are disk-only by design
 * (routine/diagnostic detail, not something every caller needs to see live);
 * they still reach console as a write-failure fallback like before, via the
 * `catch` paths below, so a failure is never fully silent at any level.
 */
function persistRecord(
  surface: Surface,
  level: LogLevel,
  message: string,
  record: LogRecord
): void {
  if (level === 'warn' || level === 'error') {
    consoleFallback(level, message)
  }
  try {
    const line = safeStringifyRecord(record, message)
    writeLogLine(surface, line).catch(() => {
      if (level !== 'warn' && level !== 'error') consoleFallback(level, message)
    })
  } catch {
    // Synchronous failure calling into rotation.ts (should be effectively
    // unreachable — `writeLogLine` itself only throws via its returned
    // Promise — but the invariant is "never throws", full stop).
    if (level !== 'warn' && level !== 'error') consoleFallback(level, message)
  }
}

function safeStringifyRecord(record: LogRecord, fallbackMessage: string): string {
  try {
    return JSON.stringify(record)
  } catch {
    // Circular reference or similar inside `details`/`err` — degrade to a
    // minimal, definitely-serializable record rather than losing the
    // message and metadata entirely.
    const { details: _details, err: _err, ...safe } = record
    return JSON.stringify({
      ...safe,
      msg: `${redactForDisk(fallbackMessage)} [unserializable details/err omitted]`,
    })
  }
}

export interface CreateLoggerOptions {
  /**
   * Package/CLI version stamped on every record from this logger instance.
   * Defaults to `'unknown'` — pass each host package's own `version` (e.g.
   * from its own `package.json`) at its entrypoint for an accurate value.
   */
  version?: string
}

export interface Logger {
  info(message: string, details?: LogDetails): void
  warn(message: string, details?: LogDetails): void
  error(message: string, details?: LogDetails): void
  debug(message: string, details?: LogDetails): void
}

/**
 * Creates a logger bound to `surface`. Independent instances for different
 * surfaces (or the same surface with different `version` stamps) are safe to
 * create concurrently — they only share state at the `rotation.ts` layer,
 * which is itself safe for concurrent writers to the same surface (F2).
 */
export function createLogger(surface: Surface, options: CreateLoggerOptions = {}): Logger {
  const version = options.version ?? 'unknown'

  function log(level: LogLevel, message: string, details?: LogDetails): void {
    try {
      if (isLoggingDisabled()) return
      if (!isLevelEnabled(level)) return
      const record = buildRecord(surface, level, version, message, details)
      persistRecord(surface, level, message, record)
    } catch {
      // Absolute last resort — never let a logging call throw into the
      // caller, regardless of what went wrong above.
      try {
        consoleFallback(level, message)
      } catch {
        // Truly nothing left to do.
      }
    }
  }

  return {
    info: (message, details) => log('info', message, details),
    warn: (message, details) => log('warn', message, details),
    error: (message, details) => log('error', message, details),
    debug: (message, details) => log('debug', message, details),
  }
}

const memoizedLoggers = new Map<Surface, Logger>()

/**
 * Memoized per-surface logger created with default options
 * (`version: 'unknown'`). Prefer calling `createLogger(surface, { version })`
 * once at each package's entrypoint so records carry that package's real
 * version; `getLogger` is a convenience for call sites that don't need a
 * custom version stamp and want a single shared instance per surface.
 */
export function getLogger(surface: Surface): Logger {
  let logger = memoizedLoggers.get(surface)
  if (!logger) {
    logger = createLogger(surface)
    memoizedLoggers.set(surface, logger)
  }
  return logger
}
