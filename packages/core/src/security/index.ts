/**
 * SMI-587: Security module exports
 * SMI-685: Enhanced with severity scoring types
 * SMI-730: Rate limiting with token bucket algorithm
 * SMI-732: Input sanitization functions
 * SMI-733: Audit logging system
 * SMI-898: Path traversal protection for database paths
 * SMI-1189: Split into modular subpackages
 */

// Scanner module
export { SecurityScanner } from './scanner/index.js'
export type {
  SecurityFinding,
  SecurityFindingType,
  SecuritySeverity,
  ScanReport,
  ScannerOptions,
  RiskScoreBreakdown,
} from './scanner/index.js'

// Sanitization
export {
  sanitizeHtml,
  sanitizeFileName,
  sanitizePath,
  sanitizeUrl,
  sanitizeText,
} from './sanitization.js'

// Path validation
export {
  validateDbPath,
  validateDbPathOrThrow,
  isPathSafe,
  DEFAULT_ALLOWED_DIRS,
} from './pathValidation.js'
export type { PathValidationOptions, PathValidationResult } from './pathValidation.js'

// Audit logger
export { AuditLogger } from './AuditLogger.js'
export type {
  AuditLogEntry,
  AuditEventType,
  AuditActor,
  AuditResult,
  AuditQueryFilter,
  AuditStats,
} from './AuditLogger.js'

// Rate limiter module
export {
  RateLimiter,
  InMemoryRateLimitStorage,
  RATE_LIMIT_PRESETS,
  createRateLimiterFromPreset,
  RateLimitQueueTimeoutError,
  RateLimitQueueFullError,
} from './rate-limiter/index.js'
export type {
  RateLimitConfig,
  RateLimitResult,
  RateLimitStorage,
  RateLimitMetrics,
} from './rate-limiter/index.js'
