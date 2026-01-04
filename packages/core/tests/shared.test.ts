/**
 * Shared Source Adapter Utilities Tests - SMI-1026
 *
 * Unit tests for shared utility functions used across source adapters.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  decodeBase64Content,
  isRateLimitStatus,
  isServerError,
  isNotFoundStatus,
  handleApiError,
  assertResponseOk,
  parseRateLimitHeaders,
  extractDefaultBranch,
  buildPaginationParams,
  parseJsonResponse,
  SKILL_FILE_PATHS,
} from '../src/sources/shared.js'
import { ApiError } from '../src/errors/SkillsmithError.js'

/**
 * Helper to create a mock Response object
 */
function createMockResponse(options: {
  status?: number
  ok?: boolean
  statusText?: string
  headers?: Record<string, string>
  body?: string | object
}): Response {
  const {
    status = 200,
    ok = status >= 200 && status < 300,
    statusText = 'OK',
    headers = {},
    body = '',
  } = options

  const headerMap = new Map(Object.entries(headers))

  return {
    status,
    ok,
    statusText,
    headers: {
      get: (name: string) => headerMap.get(name) ?? null,
      has: (name: string) => headerMap.has(name),
      entries: () => headerMap.entries(),
      keys: () => headerMap.keys(),
      values: () => headerMap.values(),
      forEach: (callback: (value: string, key: string) => void) => headerMap.forEach(callback),
    } as Headers,
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    json: vi.fn().mockImplementation(async () => {
      if (typeof body === 'object') {
        return body
      }
      try {
        return JSON.parse(body)
      } catch {
        throw new SyntaxError('Unexpected token')
      }
    }),
  } as unknown as Response
}

describe('Shared Source Utilities (SMI-1026)', () => {
  describe('SKILL_FILE_PATHS', () => {
    it('should export standard skill file paths', () => {
      expect(SKILL_FILE_PATHS).toBeDefined()
      expect(Array.isArray(SKILL_FILE_PATHS)).toBe(true)
      expect(SKILL_FILE_PATHS).toContain('SKILL.md')
      expect(SKILL_FILE_PATHS).toContain('skill.md')
      expect(SKILL_FILE_PATHS).toContain('.claude/SKILL.md')
    })
  })

  describe('decodeBase64Content', () => {
    it('should decode base64 encoded content', () => {
      const encoded = Buffer.from('Hello, World!').toString('base64')
      const result = decodeBase64Content(encoded, 'base64')
      expect(result).toBe('Hello, World!')
    })

    it('should handle base64 with newlines', () => {
      const content = 'This is a longer piece of content for testing'
      const encoded = Buffer.from(content).toString('base64')
      // Simulate newlines that might appear in API responses
      const encodedWithNewlines = encoded.slice(0, 20) + '\n' + encoded.slice(20)
      const result = decodeBase64Content(encodedWithNewlines, 'base64')
      expect(result).toBe(content)
    })

    it('should handle UTF-8 multi-byte characters', () => {
      const content = 'Hello, \u4e16\u754c! \u{1F600}' // "Hello, World!" in Chinese + emoji
      const encoded = Buffer.from(content, 'utf-8').toString('base64')
      const result = decodeBase64Content(encoded, 'base64')
      expect(result).toBe(content)
    })

    it('should handle empty string', () => {
      const encoded = Buffer.from('').toString('base64')
      const result = decodeBase64Content(encoded, 'base64')
      expect(result).toBe('')
    })

    it('should return content unchanged for non-base64 encoding', () => {
      const content = 'Plain text content'
      const result = decodeBase64Content(content, 'text')
      expect(result).toBe(content)
    })

    it('should return content unchanged for unknown encoding', () => {
      const content = 'Some content'
      const result = decodeBase64Content(content, 'utf-8')
      expect(result).toBe(content)
    })

    it('should handle special characters in base64', () => {
      const content = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\'
      const encoded = Buffer.from(content).toString('base64')
      const result = decodeBase64Content(encoded, 'base64')
      expect(result).toBe(content)
    })
  })

  describe('isRateLimitStatus', () => {
    it('should return true for 403 (Forbidden)', () => {
      expect(isRateLimitStatus(403)).toBe(true)
    })

    it('should return true for 429 (Too Many Requests)', () => {
      expect(isRateLimitStatus(429)).toBe(true)
    })

    it('should return false for 200 (OK)', () => {
      expect(isRateLimitStatus(200)).toBe(false)
    })

    it('should return false for 404 (Not Found)', () => {
      expect(isRateLimitStatus(404)).toBe(false)
    })

    it('should return false for 500 (Server Error)', () => {
      expect(isRateLimitStatus(500)).toBe(false)
    })

    it('should return false for 401 (Unauthorized)', () => {
      expect(isRateLimitStatus(401)).toBe(false)
    })
  })

  describe('isServerError', () => {
    it('should return false for 499', () => {
      expect(isServerError(499)).toBe(false)
    })

    it('should return true for 500', () => {
      expect(isServerError(500)).toBe(true)
    })

    it('should return true for 599', () => {
      expect(isServerError(599)).toBe(true)
    })

    it('should return false for 600', () => {
      expect(isServerError(600)).toBe(false)
    })

    it('should return true for 502 (Bad Gateway)', () => {
      expect(isServerError(502)).toBe(true)
    })

    it('should return true for 503 (Service Unavailable)', () => {
      expect(isServerError(503)).toBe(true)
    })

    it('should return false for 200', () => {
      expect(isServerError(200)).toBe(false)
    })

    it('should return false for 400', () => {
      expect(isServerError(400)).toBe(false)
    })
  })

  describe('isNotFoundStatus', () => {
    it('should return true for 404', () => {
      expect(isNotFoundStatus(404)).toBe(true)
    })

    it('should return false for 200', () => {
      expect(isNotFoundStatus(200)).toBe(false)
    })

    it('should return false for 403', () => {
      expect(isNotFoundStatus(403)).toBe(false)
    })

    it('should return false for 410 (Gone)', () => {
      expect(isNotFoundStatus(410)).toBe(false)
    })

    it('should return false for 500', () => {
      expect(isNotFoundStatus(500)).toBe(false)
    })
  })

  describe('handleApiError', () => {
    it('should throw rate limit error for 429', async () => {
      const response = createMockResponse({
        status: 429,
        ok: false,
        headers: {
          'Retry-After': '60',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1704067200',
        },
      })

      await expect(handleApiError(response, 'GitHub API')).rejects.toThrow(ApiError)
      await expect(handleApiError(response, 'GitHub API')).rejects.toThrow(
        'GitHub API rate limit exceeded'
      )
    })

    it('should throw rate limit error for 403', async () => {
      const response = createMockResponse({
        status: 403,
        ok: false,
        headers: {
          'X-RateLimit-Remaining': '0',
        },
      })

      await expect(handleApiError(response, 'GitLab API')).rejects.toThrow(
        'GitLab API rate limit exceeded'
      )
    })

    it('should throw not found error for 404', async () => {
      const response = createMockResponse({
        status: 404,
        ok: false,
      })

      await expect(handleApiError(response, 'GitHub API')).rejects.toThrow(
        'GitHub API resource not found'
      )
    })

    it('should include rate limit headers in error context', async () => {
      const response = createMockResponse({
        status: 429,
        ok: false,
        headers: {
          'Retry-After': '120',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1704067200',
        },
      })

      try {
        await handleApiError(response, 'API')
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        const apiError = error as ApiError
        expect(apiError.context?.retryAfter).toBe('120')
        expect(apiError.context?.rateLimitRemaining).toBe('0')
        expect(apiError.context?.rateLimitReset).toBe('1704067200')
      }
    })

    it('should include URL in error context when provided', async () => {
      const response = createMockResponse({
        status: 500,
        ok: false,
      })

      try {
        await handleApiError(response, 'API', { url: 'https://api.example.com/test' })
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        const apiError = error as ApiError
        expect(apiError.context?.url).toBe('https://api.example.com/test')
      }
    })

    it('should include error body in context for generic errors', async () => {
      const response = createMockResponse({
        status: 500,
        ok: false,
        statusText: 'Internal Server Error',
        body: '{"error": "Something went wrong"}',
      })

      try {
        await handleApiError(response, 'API')
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        const apiError = error as ApiError
        expect(apiError.context?.statusText).toBe('Internal Server Error')
        expect(apiError.context?.body).toContain('Something went wrong')
      }
    })

    it('should truncate long error bodies', async () => {
      const longBody = 'x'.repeat(1000)
      const response = createMockResponse({
        status: 500,
        ok: false,
        body: longBody,
      })

      try {
        await handleApiError(response, 'API')
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        const apiError = error as ApiError
        expect((apiError.context?.body as string).length).toBeLessThanOrEqual(500)
      }
    })

    it('should handle body parsing errors gracefully', async () => {
      const response = createMockResponse({
        status: 500,
        ok: false,
      })
      // Override text() to throw
      vi.mocked(response.text).mockRejectedValue(new Error('Body parse failed'))

      // Should not throw from body parsing, only from the API error
      await expect(handleApiError(response, 'API')).rejects.toThrow('API error: 500')
    })
  })

  describe('assertResponseOk', () => {
    it('should not throw for OK response', async () => {
      const response = createMockResponse({ status: 200, ok: true })
      await expect(assertResponseOk(response, 'API')).resolves.not.toThrow()
    })

    it('should not throw for 201 Created', async () => {
      const response = createMockResponse({ status: 201, ok: true })
      await expect(assertResponseOk(response, 'API')).resolves.not.toThrow()
    })

    it('should throw for 400 Bad Request', async () => {
      const response = createMockResponse({ status: 400, ok: false })
      await expect(assertResponseOk(response, 'API')).rejects.toThrow(ApiError)
    })

    it('should throw for 500 Server Error', async () => {
      const response = createMockResponse({ status: 500, ok: false })
      await expect(assertResponseOk(response, 'API')).rejects.toThrow(ApiError)
    })

    it('should pass through context options', async () => {
      const response = createMockResponse({ status: 404, ok: false })

      try {
        await assertResponseOk(response, 'GitHub', { url: 'https://github.com/test' })
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        const apiError = error as ApiError
        expect(apiError.context?.url).toBe('https://github.com/test')
      }
    })
  })

  describe('parseRateLimitHeaders', () => {
    it('should parse all rate limit headers', () => {
      const response = createMockResponse({
        headers: {
          'X-RateLimit-Remaining': '50',
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Reset': '1704067200',
        },
      })

      const result = parseRateLimitHeaders(response)
      expect(result.remaining).toBe(50)
      expect(result.limit).toBe(100)
      expect(result.reset).toBeInstanceOf(Date)
      expect(result.reset?.getTime()).toBe(1704067200 * 1000)
    })

    it('should return null for missing headers', () => {
      const response = createMockResponse({ headers: {} })

      const result = parseRateLimitHeaders(response)
      expect(result.remaining).toBeNull()
      expect(result.limit).toBeNull()
      expect(result.reset).toBeNull()
    })

    it('should handle partial headers', () => {
      const response = createMockResponse({
        headers: {
          'X-RateLimit-Remaining': '25',
        },
      })

      const result = parseRateLimitHeaders(response)
      expect(result.remaining).toBe(25)
      expect(result.limit).toBeNull()
      expect(result.reset).toBeNull()
    })

    it('should handle invalid numeric values', () => {
      const response = createMockResponse({
        headers: {
          'X-RateLimit-Remaining': 'not-a-number',
          'X-RateLimit-Limit': 'abc',
        },
      })

      const result = parseRateLimitHeaders(response)
      expect(result.remaining).toBeNaN()
      expect(result.limit).toBeNaN()
    })

    it('should return null for empty string headers', () => {
      const response = createMockResponse({
        headers: {
          'X-RateLimit-Remaining': '',
          'X-RateLimit-Limit': '',
        },
      })

      const result = parseRateLimitHeaders(response)
      // Empty strings are falsy, so the function returns null
      expect(result.remaining).toBeNull()
      expect(result.limit).toBeNull()
    })

    it('should handle zero values correctly', () => {
      const response = createMockResponse({
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Limit': '60',
        },
      })

      const result = parseRateLimitHeaders(response)
      expect(result.remaining).toBe(0)
      expect(result.limit).toBe(60)
    })
  })

  describe('extractDefaultBranch', () => {
    it('should extract default_branch when present', () => {
      const item = { default_branch: 'main' }
      expect(extractDefaultBranch(item)).toBe('main')
    })

    it('should extract defaultBranch when present', () => {
      const item = { defaultBranch: 'master' }
      expect(extractDefaultBranch(item)).toBe('master')
    })

    it('should prefer default_branch over defaultBranch', () => {
      const item = { default_branch: 'main', defaultBranch: 'master' }
      expect(extractDefaultBranch(item)).toBe('main')
    })

    it('should return default value when no branch specified', () => {
      const item = {}
      expect(extractDefaultBranch(item)).toBe('main')
    })

    it('should return custom default value', () => {
      const item = {}
      expect(extractDefaultBranch(item, 'develop')).toBe('develop')
    })

    it('should handle undefined values', () => {
      const item = { default_branch: undefined }
      expect(extractDefaultBranch(item)).toBe('main')
    })

    it('should handle empty string as valid branch name', () => {
      // Empty string is falsy but should still be treated as a valid value
      // based on nullish coalescing behavior
      const item = { default_branch: '' }
      expect(extractDefaultBranch(item)).toBe('')
    })
  })

  describe('buildPaginationParams', () => {
    it('should build params with page and per_page', () => {
      expect(buildPaginationParams(1, 30)).toBe('page=1&per_page=30')
    })

    it('should handle page 2', () => {
      expect(buildPaginationParams(2, 50)).toBe('page=2&per_page=50')
    })

    it('should handle large page numbers', () => {
      expect(buildPaginationParams(100, 100)).toBe('page=100&per_page=100')
    })

    it('should handle single item per page', () => {
      expect(buildPaginationParams(1, 1)).toBe('page=1&per_page=1')
    })

    it('should handle zero values (edge case)', () => {
      expect(buildPaginationParams(0, 0)).toBe('page=0&per_page=0')
    })
  })

  describe('parseJsonResponse', () => {
    it('should parse valid JSON response', async () => {
      const response = createMockResponse({
        body: { name: 'test', value: 123 },
      })

      const result = await parseJsonResponse<{ name: string; value: number }>(response, 'test API')
      expect(result).toEqual({ name: 'test', value: 123 })
    })

    it('should parse array response', async () => {
      const response = createMockResponse({
        body: [1, 2, 3],
      })

      const result = await parseJsonResponse<number[]>(response, 'test API')
      expect(result).toEqual([1, 2, 3])
    })

    it('should throw ApiError for invalid JSON', async () => {
      const response = createMockResponse({
        body: 'not valid json',
      })
      // Force json() to throw
      vi.mocked(response.json).mockRejectedValue(new SyntaxError('Unexpected token'))

      await expect(parseJsonResponse(response, 'GitHub API')).rejects.toThrow(ApiError)
      await expect(parseJsonResponse(response, 'GitHub API')).rejects.toThrow(
        'Failed to parse GitHub API response'
      )
    })

    it('should include content type in error context', async () => {
      const response = createMockResponse({
        headers: {
          'Content-Type': 'text/html',
        },
        body: '<html>Error</html>',
      })
      vi.mocked(response.json).mockRejectedValue(new SyntaxError('Unexpected token'))

      try {
        await parseJsonResponse(response, 'API')
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        const apiError = error as ApiError
        expect(apiError.context?.contentType).toBe('text/html')
      }
    })

    it('should preserve original error as cause', async () => {
      const originalError = new SyntaxError('Unexpected end of JSON input')
      const response = createMockResponse({})
      vi.mocked(response.json).mockRejectedValue(originalError)

      try {
        await parseJsonResponse(response, 'API')
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        expect((error as ApiError).cause).toBe(originalError)
      }
    })

    it('should handle null response', async () => {
      const response = createMockResponse({})
      vi.mocked(response.json).mockResolvedValue(null)

      const result = await parseJsonResponse<null>(response, 'API')
      expect(result).toBeNull()
    })

    it('should handle empty object', async () => {
      const response = createMockResponse({
        body: {},
      })

      const result = await parseJsonResponse<Record<string, never>>(response, 'API')
      expect(result).toEqual({})
    })
  })
})
