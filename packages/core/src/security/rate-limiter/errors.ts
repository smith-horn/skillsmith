/**
 * Rate Limiter Errors - SMI-1013, SMI-1189
 *
 * Error classes for rate limiting queue functionality.
 */

/**
 * Error thrown when queue timeout is exceeded (SMI-1013)
 */
export class RateLimitQueueTimeoutError extends Error {
  constructor(
    public readonly key: string,
    public readonly timeoutMs: number
  ) {
    super(`Rate limit queue timeout exceeded for key '${key}' after ${timeoutMs}ms`)
    this.name = 'RateLimitQueueTimeoutError'
  }
}

/**
 * Error thrown when queue is full (SMI-1013)
 */
export class RateLimitQueueFullError extends Error {
  constructor(
    public readonly key: string,
    public readonly maxQueueSize: number
  ) {
    super(`Rate limit queue full for key '${key}' (max: ${maxQueueSize})`)
    this.name = 'RateLimitQueueFullError'
  }
}
