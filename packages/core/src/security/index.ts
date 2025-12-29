/**
 * SMI-587: Security module exports
 * SMI-685: Enhanced with severity scoring types
 * SMI-730: Rate limiting with token bucket algorithm
 * SMI-732: Input sanitization functions
 * SMI-733: Audit logging system
 */

export { SecurityScanner } from './scanner.js'
export type {
  SecurityFinding,
  SecurityFindingType,
  SecuritySeverity,
  ScanReport,
  ScannerOptions,
  RiskScoreBreakdown,
} from './scanner.js'

export {
  sanitizeHtml,
  sanitizeFileName,
  sanitizePath,
  sanitizeUrl,
  sanitizeText,
} from './sanitization.js'

export { AuditLogger } from './AuditLogger.js'
export type {
  AuditLogEntry,
  AuditEventType,
  AuditActor,
  AuditResult,
  AuditQueryFilter,
  AuditStats,
} from './AuditLogger.js'

export {
  RateLimiter,
  InMemoryRateLimitStorage,
  RATE_LIMIT_PRESETS,
  createRateLimiterFromPreset,
} from './RateLimiter.js'
export type {
  RateLimitConfig,
  RateLimitResult,
  RateLimitStorage,
} from './RateLimiter.js'
