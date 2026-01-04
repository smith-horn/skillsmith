/**
 * Retry Utility Tests - SMI-880
 *
 * Tests for exponential backoff retry logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  withRetry,
  fetchWithRetry,
  isTransientError,
  isRetryableStatus,
  parseRetryAfter,
  RetryExhaustedError,
  DEFAULT_RETRY_CONFIG,
} from '../src/utils/retry.js'

describe('Retry Utility', () => {
  // Note: Some tests use real timers with short delays for simplicity
  // Complex timer tests are avoided due to vitest fake timer limitations

  describe('isTransientError', () => {
    it('should identify ETIMEDOUT as transient', () => {
      const error = new Error('Connection timed out') as NodeJS.ErrnoException
      error.code = 'ETIMEDOUT'
      expect(isTransientError(error)).toBe(true)
    })

    it('should identify ECONNRESET as transient', () => {
      const error = new Error('Connection reset') as NodeJS.ErrnoException
      error.code = 'ECONNRESET'
      expect(isTransientError(error)).toBe(true)
    })

    it('should identify ECONNREFUSED as transient', () => {
      const error = new Error('Connection refused') as NodeJS.ErrnoException
      error.code = 'ECONNREFUSED'
      expect(isTransientError(error)).toBe(true)
    })

    it('should identify AbortError as transient', () => {
      const error = new Error('Request aborted')
      error.name = 'AbortError'
      expect(isTransientError(error)).toBe(true)
    })

    it('should identify network errors by message', () => {
      expect(isTransientError(new Error('network error'))).toBe(true)
      expect(isTransientError(new Error('fetch failed'))).toBe(true)
    })

    it('should not identify regular errors as transient', () => {
      expect(isTransientError(new Error('Not found'))).toBe(false)
      expect(isTransientError(new Error('Invalid input'))).toBe(false)
    })

    it('should handle non-Error values', () => {
      expect(isTransientError('string error')).toBe(false)
      expect(isTransientError(null)).toBe(false)
      expect(isTransientError(undefined)).toBe(false)
    })
  })

  describe('isRetryableStatus', () => {
    it('should identify 5xx errors as retryable', () => {
      expect(isRetryableStatus(500)).toBe(true)
      expect(isRetryableStatus(502)).toBe(true)
      expect(isRetryableStatus(503)).toBe(true)
      expect(isRetryableStatus(504)).toBe(true)
    })

    it('should identify 429 as retryable', () => {
      expect(isRetryableStatus(429)).toBe(true)
    })

    it('should identify 408 as retryable', () => {
      expect(isRetryableStatus(408)).toBe(true)
    })

    it('should not identify 4xx client errors as retryable', () => {
      expect(isRetryableStatus(400)).toBe(false)
      expect(isRetryableStatus(401)).toBe(false)
      expect(isRetryableStatus(403)).toBe(false)
      expect(isRetryableStatus(404)).toBe(false)
    })

    it('should not identify 2xx success as retryable', () => {
      expect(isRetryableStatus(200)).toBe(false)
      expect(isRetryableStatus(201)).toBe(false)
      expect(isRetryableStatus(204)).toBe(false)
    })
  })

  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success')

      const result = await withRetry(fn)

      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('should retry on transient error and succeed', async () => {
      const error = new Error('network error')
      const fn = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success')

      // Use very short delays for real timer test
      const result = await withRetry(fn, {
        maxRetries: 3,
        initialDelayMs: 10,
        jitter: false,
      })

      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('should throw after max retries exceeded', async () => {
      const error = new Error('network error')
      const fn = vi.fn().mockRejectedValue(error)

      await expect(
        withRetry(fn, { maxRetries: 2, initialDelayMs: 10, jitter: false })
      ).rejects.toThrow('network error')

      expect(fn).toHaveBeenCalledTimes(3) // Initial + 2 retries
    })

    it('should not retry non-transient errors', async () => {
      const error = new Error('Invalid input')
      const fn = vi.fn().mockRejectedValue(error)

      await expect(withRetry(fn)).rejects.toThrow('Invalid input')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('should use custom isRetryable function', async () => {
      const error = new Error('Custom retryable')
      const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('success')

      const result = await withRetry(fn, {
        maxRetries: 2,
        initialDelayMs: 10,
        jitter: false,
        isRetryable: (e) => e instanceof Error && e.message.includes('Custom'),
      })

      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('should call onRetry callback', async () => {
      const error = new Error('network error')
      const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('success')
      const onRetry = vi.fn()

      await withRetry(fn, {
        maxRetries: 2,
        initialDelayMs: 10,
        jitter: false,
        onRetry,
      })

      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledWith(1, error, expect.any(Number))
    })

    it('should respect maxDelayMs', async () => {
      // Create a transient error (network error pattern)
      const error = new Error('fetch failed: network error')
      const fn = vi.fn().mockRejectedValue(error)
      const delays: number[] = []

      // Use small delays for real timer test
      await expect(
        withRetry(fn, {
          maxRetries: 2,
          initialDelayMs: 100,
          maxDelayMs: 50, // Cap below initial
          backoffMultiplier: 2,
          jitter: false,
          onRetry: (_attempt, _err, delayMs) => {
            delays.push(delayMs)
          },
        })
      ).rejects.toThrow()

      // All delays should be capped at maxDelayMs (50)
      expect(delays.length).toBe(2)
      delays.forEach((delay) => {
        expect(delay).toBe(50) // Exactly maxDelayMs since jitter is false
      })
    })
  })

  describe('DEFAULT_RETRY_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3)
      expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBe(1000)
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(30000)
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2)
      expect(DEFAULT_RETRY_CONFIG.jitter).toBe(true)
    })
  })

  describe('RetryExhaustedError', () => {
    it('should preserve error information', () => {
      const lastError = new Error('Last failure')
      const error = new RetryExhaustedError('All retries exhausted', 3, lastError)

      expect(error.name).toBe('RetryExhaustedError')
      expect(error.message).toBe('All retries exhausted')
      expect(error.attempts).toBe(3)
      expect(error.lastError).toBe(lastError)
      expect(error.cause).toBe(lastError)
    })
  })

  describe('parseRetryAfter', () => {
    it('should parse valid integer seconds', () => {
      expect(parseRetryAfter('120')).toBe(120000) // 120 seconds = 120000ms
      expect(parseRetryAfter('1')).toBe(1000)
      expect(parseRetryAfter('60')).toBe(60000)
    })

    it('should parse valid HTTP-date format', () => {
      // Use a date 10 seconds in the future
      const futureDate = new Date(Date.now() + 10000)
      const httpDate = futureDate.toUTCString()
      const result = parseRetryAfter(httpDate)

      // Should be approximately 10000ms (allow some tolerance for test execution time)
      expect(result).not.toBeNull()
      expect(result).toBeGreaterThan(9000)
      expect(result).toBeLessThan(11000)
    })

    it('should return null for invalid/malformed values', () => {
      expect(parseRetryAfter('invalid')).toBeNull()
      expect(parseRetryAfter('abc123')).toBeNull()
      expect(parseRetryAfter('')).toBeNull()
      expect(parseRetryAfter('12.5')).toBeNull() // Not a valid integer string
    })

    it('should return null for negative values', () => {
      expect(parseRetryAfter('-1')).toBeNull()
      expect(parseRetryAfter('-100')).toBeNull()
    })

    it('should return 0 for zero value', () => {
      expect(parseRetryAfter('0')).toBe(0)
    })

    it('should return null for null input', () => {
      expect(parseRetryAfter(null)).toBeNull()
    })
  })

  describe('fetchWithRetry', () => {
    let originalFetch: typeof global.fetch

    beforeEach(() => {
      originalFetch = global.fetch
    })

    afterEach(() => {
      global.fetch = originalFetch
      vi.restoreAllMocks()
    })

    it('should return response on successful first request', async () => {
      const mockResponse = new Response(JSON.stringify({ data: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      global.fetch = vi.fn().mockResolvedValue(mockResponse)

      const response = await fetchWithRetry('https://api.example.com/test', undefined, {
        maxRetries: 3,
        initialDelayMs: 10,
        jitter: false,
      })

      expect(response.status).toBe(200)
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('should retry on HTTP 429 with Retry-After header (seconds format)', async () => {
      const rateLimitResponse = new Response('Rate limited', {
        status: 429,
        headers: { 'Retry-After': '1' }, // 1 second
      })
      const successResponse = new Response(JSON.stringify({ data: 'success' }), {
        status: 200,
      })

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValue(successResponse)

      const startTime = Date.now()
      const response = await fetchWithRetry('https://api.example.com/test', undefined, {
        maxRetries: 3,
        initialDelayMs: 10,
        jitter: false,
      })
      const elapsed = Date.now() - startTime

      expect(response.status).toBe(200)
      expect(global.fetch).toHaveBeenCalledTimes(2)
      // Should have waited at least 1000ms for Retry-After
      expect(elapsed).toBeGreaterThanOrEqual(1000)
    })

    it('should retry on HTTP 503 Service Unavailable and succeed', async () => {
      const unavailableResponse = new Response('Service Unavailable', {
        status: 503,
      })
      const successResponse = new Response(JSON.stringify({ data: 'recovered' }), {
        status: 200,
      })

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(unavailableResponse)
        .mockResolvedValue(successResponse)

      const response = await fetchWithRetry('https://api.example.com/test', undefined, {
        maxRetries: 3,
        initialDelayMs: 10,
        jitter: false,
      })

      expect(response.status).toBe(200)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('should retry on network error and succeed', async () => {
      const networkError = new Error('fetch failed: network error')
      const successResponse = new Response(JSON.stringify({ data: 'success' }), {
        status: 200,
      })

      global.fetch = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValue(successResponse)

      const response = await fetchWithRetry('https://api.example.com/test', undefined, {
        maxRetries: 3,
        initialDelayMs: 10,
        jitter: false,
      })

      expect(response.status).toBe(200)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('should throw after max retries exceeded with HTTP error', async () => {
      const serverErrorResponse = new Response('Internal Server Error', {
        status: 500,
      })

      global.fetch = vi.fn().mockResolvedValue(serverErrorResponse)

      await expect(
        fetchWithRetry('https://api.example.com/test', undefined, {
          maxRetries: 2,
          initialDelayMs: 10,
          jitter: false,
        })
      ).rejects.toThrow('HTTP 500 - retryable')

      // Initial + 2 retries = 3 total calls
      expect(global.fetch).toHaveBeenCalledTimes(3)
    })
  })
})
