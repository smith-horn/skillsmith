/**
 * Shared Source Adapter Utilities - SMI-879
 *
 * Consolidates duplicated code patterns from GitHub, GitLab, and RawUrl adapters.
 * Provides common utilities for content decoding, error handling, and response processing.
 */

import { ApiError } from '../errors/SkillsmithError.js'

/**
 * Standard skill file paths to search for
 */
export const SKILL_FILE_PATHS = [
  'SKILL.md',
  'skill.md',
  '.claude/SKILL.md',
  '.claude/skill.md',
  'docs/SKILL.md',
  'docs/skill.md',
]

/**
 * Decode base64 encoded content (used by GitHub and GitLab APIs)
 *
 * Previously duplicated in:
 * - GitHubSourceAdapter.ts:356-367
 * - GitLabSourceAdapter.ts:376-386
 *
 * @param content - The encoded content string
 * @param encoding - The encoding type ('base64' or 'text')
 * @returns Decoded string content
 */
export function decodeBase64Content(content: string, encoding: string): string {
  if (encoding === 'base64') {
    // Remove any newlines that might be in the base64 string
    const base64 = content.replace(/\n/g, '')

    // Use Buffer in Node.js environment
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(base64, 'base64').toString('utf-8')
    }

    // Fallback for browser environment
    // atob() decodes to Latin-1, so we need to convert to UTF-8 manually
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    return new TextDecoder('utf-8').decode(bytes)
  }

  return content
}

/**
 * Check if an HTTP status code indicates a rate limit error
 *
 * @param status - HTTP status code
 * @returns true if rate limit error
 */
export function isRateLimitStatus(status: number): boolean {
  return status === 403 || status === 429
}

/**
 * Check if an HTTP status code indicates a server error (retryable)
 *
 * @param status - HTTP status code
 * @returns true if server error
 */
export function isServerError(status: number): boolean {
  return status >= 500 && status < 600
}

/**
 * Check if an HTTP status code indicates not found
 *
 * @param status - HTTP status code
 * @returns true if not found
 */
export function isNotFoundStatus(status: number): boolean {
  return status === 404
}

/**
 * Handle API response errors with proper error wrapping
 *
 * Previously duplicated error handling in:
 * - GitHubSourceAdapter.ts:166-170, 309-313
 * - GitLabSourceAdapter.ts:164-168, 324-328
 * - RawUrlSourceAdapter.ts:113-114, 248-249
 *
 * @param response - Fetch Response object
 * @param context - Context for error message (e.g., "GitHub API", "GitLab API")
 * @throws ApiError with appropriate code and context
 */
export async function handleApiError(
  response: Response,
  context: string,
  options?: { url?: string }
): Promise<never> {
  const status = response.status

  if (isRateLimitStatus(status)) {
    throw new ApiError(`${context} rate limit exceeded`, {
      statusCode: status,
      url: options?.url,
      context: {
        retryAfter: response.headers.get('Retry-After'),
        rateLimitRemaining: response.headers.get('X-RateLimit-Remaining'),
        rateLimitReset: response.headers.get('X-RateLimit-Reset'),
      },
    })
  }

  if (isNotFoundStatus(status)) {
    throw new ApiError(`${context} resource not found`, {
      statusCode: status,
      url: options?.url,
    })
  }

  // Try to get error message from response body
  let errorBody: string | undefined
  try {
    errorBody = await response.text()
  } catch {
    // Ignore body parsing errors
  }

  throw new ApiError(`${context} error: ${status}`, {
    statusCode: status,
    url: options?.url,
    context: {
      statusText: response.statusText,
      body: errorBody?.slice(0, 500), // Truncate long bodies
    },
  })
}

/**
 * Check response and throw appropriate error if not OK
 *
 * @param response - Fetch Response object
 * @param context - Context for error message
 * @throws ApiError if response is not OK
 */
export async function assertResponseOk(
  response: Response,
  context: string,
  options?: { url?: string }
): Promise<void> {
  if (!response.ok) {
    await handleApiError(response, context, options)
  }
}

/**
 * Parse rate limit headers from response
 *
 * @param response - Fetch Response object
 * @returns Rate limit info or null if not available
 */
export function parseRateLimitHeaders(response: Response): {
  remaining: number | null
  limit: number | null
  reset: Date | null
} {
  const remaining = response.headers.get('X-RateLimit-Remaining')
  const limit = response.headers.get('X-RateLimit-Limit')
  const reset = response.headers.get('X-RateLimit-Reset')

  return {
    remaining: remaining ? parseInt(remaining, 10) : null,
    limit: limit ? parseInt(limit, 10) : null,
    reset: reset ? new Date(parseInt(reset, 10) * 1000) : null,
  }
}

/**
 * Map common repository fields from API response
 *
 * @param source - Source type ('github' | 'gitlab')
 * @param item - API response item
 * @returns Normalized repository object
 */
export interface NormalizedRepository {
  id: string
  name: string
  fullName: string
  url: string
  description: string | null
  stars: number
  language: string | null
  updatedAt: string
  isPrivate: boolean
  defaultBranch: string
}

/**
 * Extract default branch from repository data
 *
 * @param item - API response with branch info
 * @param defaultValue - Default value if not found
 */
export function extractDefaultBranch(
  item: { default_branch?: string; defaultBranch?: string },
  defaultValue = 'main'
): string {
  return item.default_branch ?? item.defaultBranch ?? defaultValue
}

/**
 * Build pagination parameters for API requests
 *
 * @param page - Page number (1-indexed)
 * @param perPage - Items per page
 * @returns URL search params string
 */
export function buildPaginationParams(page: number, perPage: number): string {
  return `page=${page}&per_page=${perPage}`
}

/**
 * Safely parse JSON response with error handling
 *
 * @param response - Fetch Response object
 * @param context - Context for error message
 * @returns Parsed JSON data
 */
export async function parseJsonResponse<T>(response: Response, context: string): Promise<T> {
  try {
    return (await response.json()) as T
  } catch (error) {
    throw new ApiError(`Failed to parse ${context} response`, {
      cause: error,
      context: {
        contentType: response.headers.get('Content-Type'),
      },
    })
  }
}
