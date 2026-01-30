/**
 * Utility exports
 */
export { logger, createLogger, silentLogger, type Logger } from './logger.js'
export {
  withRetry,
  fetchWithRetry,
  isTransientError,
  isRetryableStatus,
  parseRetryAfter,
  RetryExhaustedError,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
} from './retry.js'

// SMI-1952: Version check for auto-update notifications
export {
  checkForUpdates,
  formatUpdateNotification,
  type VersionCheckResult,
} from './version-check.js'
