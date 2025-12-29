/**
 * Logger Utility (SMI-724)
 *
 * Simple logger abstraction for consistent logging across adapters.
 * Provides environment-aware logging with different verbosity levels.
 */

/**
 * Logger interface for dependency injection
 */
export interface Logger {
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  debug: (message: string, ...args: unknown[]) => void
}

/**
 * Default logger implementation
 *
 * - warn: Suppressed in test environment
 * - error: Always outputs
 * - info: Only outputs when DEBUG env var is set
 * - debug: Only outputs when DEBUG env var is set
 */
export const logger: Logger = {
  warn: (message: string, ...args: unknown[]) => {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[skillsmith] ${message}`, ...args)
    }
  },
  error: (message: string, ...args: unknown[]) => {
    console.error(`[skillsmith] ${message}`, ...args)
  },
  info: (message: string, ...args: unknown[]) => {
    if (process.env.DEBUG) {
      console.info(`[skillsmith] ${message}`, ...args)
    }
  },
  debug: (message: string, ...args: unknown[]) => {
    if (process.env.DEBUG) {
      console.debug(`[skillsmith] ${message}`, ...args)
    }
  },
}

/**
 * Create a namespaced logger
 *
 * @param namespace - The namespace prefix for log messages
 * @returns A Logger instance with namespaced messages
 *
 * @example
 * ```typescript
 * const log = createLogger('GitLabAdapter')
 * log.warn('Rate limit exceeded') // [skillsmith:GitLabAdapter] Rate limit exceeded
 * ```
 */
export function createLogger(namespace: string): Logger {
  return {
    warn: (message: string, ...args: unknown[]) => {
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[skillsmith:${namespace}] ${message}`, ...args)
      }
    },
    error: (message: string, ...args: unknown[]) => {
      console.error(`[skillsmith:${namespace}] ${message}`, ...args)
    },
    info: (message: string, ...args: unknown[]) => {
      if (process.env.DEBUG) {
        console.info(`[skillsmith:${namespace}] ${message}`, ...args)
      }
    },
    debug: (message: string, ...args: unknown[]) => {
      if (process.env.DEBUG) {
        console.debug(`[skillsmith:${namespace}] ${message}`, ...args)
      }
    },
  }
}

/**
 * No-op logger for testing or silent operation
 */
export const silentLogger: Logger = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
}
