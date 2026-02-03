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

// SMI-2171: GitHub URL parsing utilities
export { parseRepoUrl, isGitHubUrl, type ParsedRepoUrl } from './github-url.js'

// SMI-2274: Safe filesystem operations (symlink protection)
export { safeWriteFile, SymlinkError, HardlinkError } from './safe-fs.js'
