/**
 * Rate Limiter Constants - SMI-730, SMI-1189
 *
 * Constants for rate limiting functionality.
 */

/**
 * Maximum number of unique keys to track in queues and metrics
 * Prevents unbounded memory growth from malicious or misconfigured clients
 */
export const MAX_UNIQUE_KEYS = 10000

/**
 * Metrics TTL in milliseconds (1 hour) - metrics older than this are cleaned up
 */
export const METRICS_TTL_MS = 60 * 60 * 1000
