/**
 * API Response Mocks for Testing
 *
 * SMI-1583: Partial and edge-case API response fixtures for comprehensive testing.
 *
 * These mocks cover:
 * - Successful responses
 * - Partial/incomplete data
 * - Error responses
 * - Rate limiting scenarios
 * - Edge cases (empty results, pagination, etc.)
 */

import type {
  SearchResponse,
  RecommendResponse,
  SkillResponse,
  HealthStatus,
  ApiErrorResponse,
  RateLimitInfo,
  ApiSkill,
} from '../../../src/api/types.js'

// ============================================================================
// Helper Types
// ============================================================================

export interface MockResponse<T> {
  status: number
  headers: Record<string, string>
  body: T
}

// ============================================================================
// Successful Responses
// ============================================================================

export const MOCK_SKILL: ApiSkill = {
  id: 'test-author/test-skill',
  name: 'test-skill',
  description: 'A test skill for unit testing purposes',
  author: 'test-author',
  version: '1.0.0',
  trust_tier: 'community',
  quality_score: 0.85,
  category: 'development',
  tags: ['testing', 'mock', 'fixture'],
  repo_url: 'https://github.com/test-author/test-skill',
  install_count: 100,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-15T00:00:00Z',
}

export const MOCK_SEARCH_SUCCESS: MockResponse<SearchResponse> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '99',
    'x-ratelimit-reset': String(Date.now() + 60000),
  },
  body: {
    skills: [MOCK_SKILL],
    meta: {
      total: 1,
      page: 1,
      per_page: 20,
      total_pages: 1,
      query: 'test',
      filters: {},
    },
  },
}

export const MOCK_RECOMMEND_SUCCESS: MockResponse<RecommendResponse> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    recommendations: [
      {
        skill: MOCK_SKILL,
        score: 0.95,
        reason: 'Matches project context',
      },
    ],
    meta: {
      total: 1,
      context_analyzed: true,
      project_type: 'typescript',
    },
  },
}

export const MOCK_SKILL_RESPONSE: MockResponse<SkillResponse> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    skill: MOCK_SKILL,
  },
}

export const MOCK_HEALTH_SUCCESS: MockResponse<HealthStatus> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    status: 'healthy',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  },
}

// ============================================================================
// Partial/Incomplete Responses
// ============================================================================

/**
 * Skill with minimal fields (edge case for optional field handling)
 */
export const MOCK_SKILL_MINIMAL: ApiSkill = {
  id: 'minimal/skill',
  name: 'minimal-skill',
  description: '',
  author: 'minimal',
  version: '0.0.1',
  trust_tier: 'experimental',
  quality_score: 0,
  category: 'other',
  tags: [],
  repo_url: '',
  install_count: 0,
  created_at: '',
  updated_at: '',
}

/**
 * Search response with empty results
 */
export const MOCK_SEARCH_EMPTY: MockResponse<SearchResponse> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    skills: [],
    meta: {
      total: 0,
      page: 1,
      per_page: 20,
      total_pages: 0,
      query: 'nonexistent-skill-xyz',
      filters: {},
    },
  },
}

/**
 * Search response with partial skill data (missing optional fields)
 */
export const MOCK_SEARCH_PARTIAL: MockResponse<SearchResponse> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    skills: [MOCK_SKILL_MINIMAL],
    meta: {
      total: 1,
      page: 1,
      per_page: 20,
      total_pages: 1,
      query: 'minimal',
      filters: {},
    },
  },
}

/**
 * Recommend response with no recommendations
 */
export const MOCK_RECOMMEND_EMPTY: MockResponse<RecommendResponse> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    recommendations: [],
    meta: {
      total: 0,
      context_analyzed: true,
      project_type: 'unknown',
    },
  },
}

/**
 * Paginated response (page 2 of 3)
 */
export const MOCK_SEARCH_PAGINATED: MockResponse<SearchResponse> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
    link: '</api/v1/skills/search?page=1>; rel="first", </api/v1/skills/search?page=3>; rel="last", </api/v1/skills/search?page=3>; rel="next", </api/v1/skills/search?page=1>; rel="prev"',
  },
  body: {
    skills: [MOCK_SKILL],
    meta: {
      total: 50,
      page: 2,
      per_page: 20,
      total_pages: 3,
      query: 'development',
      filters: { trust_tier: 'community' },
    },
  },
}

// ============================================================================
// Error Responses
// ============================================================================

export const MOCK_ERROR_NOT_FOUND: MockResponse<ApiErrorResponse> = {
  status: 404,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    error: {
      code: 'SKILL_NOT_FOUND',
      message: 'Skill not found',
      details: {
        skill_id: 'nonexistent/skill',
      },
    },
  },
}

export const MOCK_ERROR_VALIDATION: MockResponse<ApiErrorResponse> = {
  status: 400,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request parameters',
      details: {
        field: 'query',
        reason: 'Query must be at least 2 characters',
      },
    },
  },
}

export const MOCK_ERROR_UNAUTHORIZED: MockResponse<ApiErrorResponse> = {
  status: 401,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    error: {
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing API key',
    },
  },
}

export const MOCK_ERROR_FORBIDDEN: MockResponse<ApiErrorResponse> = {
  status: 403,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    error: {
      code: 'FORBIDDEN',
      message: 'Insufficient permissions for this operation',
      details: {
        required_tier: 'team',
        current_tier: 'community',
      },
    },
  },
}

export const MOCK_ERROR_SERVER: MockResponse<ApiErrorResponse> = {
  status: 500,
  headers: {
    'content-type': 'application/json',
  },
  body: {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  },
}

export const MOCK_ERROR_SERVICE_UNAVAILABLE: MockResponse<ApiErrorResponse> = {
  status: 503,
  headers: {
    'content-type': 'application/json',
    'retry-after': '30',
  },
  body: {
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable',
      details: {
        retry_after: 30,
      },
    },
  },
}

// ============================================================================
// Rate Limiting Responses
// ============================================================================

export const MOCK_RATE_LIMIT_INFO: RateLimitInfo = {
  limit: 100,
  remaining: 0,
  reset: Date.now() + 60000,
}

export const MOCK_ERROR_RATE_LIMITED: MockResponse<ApiErrorResponse> = {
  status: 429,
  headers: {
    'content-type': 'application/json',
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(Date.now() + 60000),
    'retry-after': '60',
  },
  body: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests',
      details: {
        limit: 100,
        remaining: 0,
        reset_at: new Date(Date.now() + 60000).toISOString(),
      },
    },
  },
}

export const MOCK_RATE_LIMIT_WARNING: MockResponse<SearchResponse> = {
  status: 200,
  headers: {
    'content-type': 'application/json',
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '5',
    'x-ratelimit-reset': String(Date.now() + 60000),
  },
  body: MOCK_SEARCH_SUCCESS.body,
}

// ============================================================================
// Network/Timeout Scenarios
// ============================================================================

/**
 * Simulates a slow response (for timeout testing)
 */
export const MOCK_SLOW_RESPONSE_DELAY_MS = 5000

/**
 * Simulates a partial response (connection closed mid-stream)
 */
export const MOCK_PARTIAL_JSON = '{"skills": [{"id": "partial/skill"'

/**
 * Simulates malformed JSON response
 */
export const MOCK_MALFORMED_JSON = '{"skills": [invalid json here]}'

/**
 * Simulates HTML error page (proxy/server misconfiguration)
 */
export const MOCK_HTML_ERROR_RESPONSE = `
<!DOCTYPE html>
<html>
<head><title>502 Bad Gateway</title></head>
<body><h1>502 Bad Gateway</h1></body>
</html>
`

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a mock fetch Response object
 */
export function createMockResponse<T>(mock: MockResponse<T>): Response {
  const body = typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body)

  return new Response(body, {
    status: mock.status,
    headers: new Headers(mock.headers),
  })
}

/**
 * Create a mock fetch function that returns a specific response
 */
export function createMockFetch<T>(mock: MockResponse<T>): typeof fetch {
  return async () => createMockResponse(mock)
}

/**
 * Create a mock fetch that fails with a network error
 */
export function createNetworkErrorFetch(message = 'Network error'): typeof fetch {
  return async () => {
    throw new Error(message)
  }
}

/**
 * Create a mock fetch that times out
 */
export function createTimeoutFetch(delayMs = MOCK_SLOW_RESPONSE_DELAY_MS): typeof fetch {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return createMockResponse(MOCK_SEARCH_SUCCESS)
  }
}

/**
 * Create a mock fetch that returns responses in sequence
 */
export function createSequentialFetch(responses: MockResponse<unknown>[]): typeof fetch {
  let callIndex = 0
  return async () => {
    const response = responses[callIndex] || responses[responses.length - 1]
    callIndex++
    return createMockResponse(response)
  }
}

// ============================================================================
// Export all mocks for easy importing
// ============================================================================

export const API_MOCKS = {
  // Success
  searchSuccess: MOCK_SEARCH_SUCCESS,
  recommendSuccess: MOCK_RECOMMEND_SUCCESS,
  skillResponse: MOCK_SKILL_RESPONSE,
  healthSuccess: MOCK_HEALTH_SUCCESS,

  // Partial/Empty
  searchEmpty: MOCK_SEARCH_EMPTY,
  searchPartial: MOCK_SEARCH_PARTIAL,
  searchPaginated: MOCK_SEARCH_PAGINATED,
  recommendEmpty: MOCK_RECOMMEND_EMPTY,
  skillMinimal: MOCK_SKILL_MINIMAL,

  // Errors
  errorNotFound: MOCK_ERROR_NOT_FOUND,
  errorValidation: MOCK_ERROR_VALIDATION,
  errorUnauthorized: MOCK_ERROR_UNAUTHORIZED,
  errorForbidden: MOCK_ERROR_FORBIDDEN,
  errorServer: MOCK_ERROR_SERVER,
  errorServiceUnavailable: MOCK_ERROR_SERVICE_UNAVAILABLE,
  errorRateLimited: MOCK_ERROR_RATE_LIMITED,

  // Rate limiting
  rateLimitWarning: MOCK_RATE_LIMIT_WARNING,
  rateLimitInfo: MOCK_RATE_LIMIT_INFO,

  // Edge cases
  partialJson: MOCK_PARTIAL_JSON,
  malformedJson: MOCK_MALFORMED_JSON,
  htmlError: MOCK_HTML_ERROR_RESPONSE,
}

export default API_MOCKS
