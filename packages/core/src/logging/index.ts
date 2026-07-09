/**
 * SMI-5615: Logging Module Exports
 *
 * Shared structured JSON-line error logging (`~/.skillsmith/logs/`) with
 * SMI-883 redaction, per-surface write serialization, and correlation-ID
 * threading with `@skillsmith/core/telemetry`'s `withTelemetry`. Consumed by
 * the MCP server and CLI via the `"./logging"` package export.
 */

export { createLogger, getLogger, type CreateLoggerOptions, type Logger } from './logger.js'

export { runWithCorrelationId, getCorrelationId } from './context.js'

export { redactSensitiveData, redactSensitiveObject } from './redact.js'

export type { LogLevel, Surface, LogRecord, LogRecordError, LogDetails } from './types.js'
