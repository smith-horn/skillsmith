/**
 * Retry Utility - SMI-880
 *
 * Exponential backoff retry logic for transient network failures.
 * Handles ETIMEDOUT, ECONNRESET, and 5xx HTTP errors.
 */

import { createLogger } from './logger.js'

const log = createLogger('RetryUtil')

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number
  /** Add jitter to prevent thundering herd (default: true) */
  jitter?: boolean
  /** Custom function to determine if error is retryable */
  isRetryable?: (error: unknown) => boolean
  /** Callback on each retry attempt */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Required<Omit<RetryConfig, 'isRetryable' | 'onRetry'>> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
}

/**
 * Error codes that indicate transient network failures
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
])

/**
 * HTTP status codes that are retryable
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
])

/**
 * Determines if an error is a transient network error
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    // Check for Node.js network error codes
    const code = (error as NodeJS.ErrnoException).code
    if (code && TRANSIENT_ERROR_CODES.has(code)) {
      return true
    }

    // Check for fetch abort errors (timeout)
    if (error.name === 'AbortError') {
      return true
    }

    // Check for network errors in fetch
    if (error.message.includes('network') || error.message.includes('fetch failed')) {
      return true
    }
  }

  return false
}

/**
 * Determines if an HTTP response status is retryable
 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status)
}

/**
 * Error class for retry exhaustion.
 *
 * Note: This class is exported for use by external callers who may want to
 * wrap retry failures in a structured error type. The withRetry function
 * itself throws the original error when retries are exhausted, allowing
 * callers to handle the specific error type rather than a generic wrapper.
 */
export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: unknown
  ) {
    super(message)
    this.name = 'RetryExhaustedError'
    // Preserve cause chain
    if (lastError instanceof Error) {
      this.cause = lastError
    }
  }
}

/**
 * Calculate delay with exponential backoff and optional jitter
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
  jitter: boolean
): number {
  // Exponential backoff: initialDelay * (multiplier ^ attempt)
  let delay = initialDelayMs * Math.pow(backoffMultiplier, attempt)

  // Cap at max delay
  delay = Math.min(delay, maxDelayMs)

  // Add jitter (±25%) to prevent thundering herd
  if (jitter) {
    const jitterFactor = 0.75 + Math.random() * 0.5 // 0.75 to 1.25
    delay = Math.floor(delay * jitterFactor)
  }

  return delay
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - Async function to retry
 * @param config - Retry configuration
 * @returns Result of the function
 * @throws The original error when retries are exhausted or error is not retryable
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetch('https://api.example.com/data'),
 *   { maxRetries: 3, initialDelayMs: 1000 }
 * )
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, config: RetryConfig = {}): Promise<T> {
  const {
    maxRetries = DEFAULT_RETRY_CONFIG.maxRetries,
    initialDelayMs = DEFAULT_RETRY_CONFIG.initialDelayMs,
    maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs,
    backoffMultiplier = DEFAULT_RETRY_CONFIG.backoffMultiplier,
    jitter = DEFAULT_RETRY_CONFIG.jitter,
    isRetryable = isTransientError,
    onRetry,
  } = config

  let _lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      _lastError = error

      // Check if we should retry
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error
      }

      // Calculate delay for this attempt
      const delayMs = calculateDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier, jitter)

      // Log retry attempt
      log.debug(`Retry attempt ${attempt + 1}/${maxRetries}`, {
        error: error instanceof Error ? error.message : String(error),
        delayMs,
      })

      // Call retry callback if provided
      if (onRetry) {
        onRetry(attempt + 1, error, delayMs)
      }

      // Wait before retrying
      await sleep(delayMs)
    }
  }

  // This point is unreachable: the loop always exits via return (on success)
  // or throw (when retries exhausted or error not retryable). The loop runs
  // attempt from 0 to maxRetries inclusive. On the final iteration
  // (attempt === maxRetries), if fn() throws, the condition `attempt >= maxRetries`
  // is true, causing the original error to be thrown immediately.
  throw new Error('Unreachable: loop invariant violated')
}

/**
 * Retry a fetch request with exponential backoff
 *
 * Automatically retries on:
 * - Network errors (ETIMEDOUT, ECONNRESET, etc.)
 * - 5xx HTTP errors
 * - 429 Too Many Requests (with Retry-After header support)
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @param retryConfig - Retry configuration
 * @returns Fetch Response
 *
 * @example
 * ```typescript
 * const response = await fetchWithRetry(
 *   'https://api.github.com/repos/owner/repo',
 *   { headers: { Authorization: 'token xxx' } },
 *   { maxRetries: 3 }
 * )
 * ```
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryConfig: RetryConfig = {}
): Promise<Response> {
  const config: RetryConfig = {
    ...retryConfig,
    isRetryable: (error) => {
      // Check for network errors
      if (isTransientError(error)) {
        return true
      }

      // Check for HTTP response errors (from our custom throw below)
      if (error instanceof HttpRetryableError) {
        return true
      }

      return false
    },
  }

  return withRetry(async () => {
    const response = await fetch(url, options)

    // Check if we should retry based on status code
    if (isRetryableStatus(response.status)) {
      // Check for Retry-After header
      const retryAfter = response.headers.get('Retry-After')
      const retryAfterMs = parseRetryAfter(retryAfter)
      if (retryAfterMs !== null && retryAfterMs > 0) {
        // SMI-1029: Double-delay behavior is intentional
        // We sleep here for the Retry-After duration, then throw HttpRetryableError.
        // When withRetry catches this error, it will apply its own exponential backoff
        // delay before the next attempt. This results in a total delay of:
        //   Retry-After + exponential backoff
        //
        // This is by design for two reasons:
        // 1. Safety margin: The server's Retry-After is a minimum; adding backoff
        //    provides buffer for clock skew and processing time.
        // 2. Thundering herd prevention: If many clients received the same Retry-After,
        //    the additional jittered backoff spreads out retry attempts.
        await sleep(retryAfterMs)
      }

      throw new HttpRetryableError(response.status, `HTTP ${response.status} - retryable`)
    }

    return response
  }, config)
}

/**
 * Error thrown for HTTP responses that should be retried
 */
class HttpRetryableError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpRetryableError'
  }
}

/**
 * Parse Retry-After header value
 * @param value - Retry-After header value (seconds or HTTP-date)
 * @returns Delay in milliseconds, or null if invalid
 */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null
  }

  const trimmed = value.trim()

  // Try parsing as seconds (must be non-negative integer string)
  // Matches only pure integer strings like "120", not "12.5" or "12abc"
  if (/^-?\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10)
    if (seconds < 0) {
      return null
    }
    return seconds * 1000
  }

  // Try parsing as HTTP-date (must contain letters, e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
  // This prevents numeric-like strings like "12.5" from being parsed as dates
  if (/[a-zA-Z]/.test(trimmed)) {
    const date = Date.parse(trimmed)
    if (!isNaN(date)) {
      return Math.max(0, date - Date.now())
    }
  }

  return null
}
