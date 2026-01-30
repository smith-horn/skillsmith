/**
 * Auth Middleware Tests
 * @module _shared/auth-middleware.test
 *
 * SMI-1872: Unit tests for consolidated auth middleware
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

// Stub Deno before any imports
beforeAll(() => {
  vi.stubGlobal('Deno', {
    env: {
      get: vi.fn(),
    },
  })
})

// Mock all dependencies with factory functions
vi.mock('./cors.ts', () => ({
  buildCorsHeaders: (origin?: string | null) => ({
    'Access-Control-Allow-Origin': origin || '*',
  }),
}))

vi.mock('./api-key-auth.ts', () => ({
  authenticateRequest: vi.fn(),
}))

vi.mock('./trial-limiter.ts', () => ({
  checkTrialLimit: vi.fn(),
  trialExceededResponse: vi.fn(),
}))

vi.mock('./rate-limiter.ts', () => ({
  checkRateLimit: vi.fn(),
  createRateLimitHeaders: vi.fn(() => ({
    'X-RateLimit-Limit': '60',
    'X-RateLimit-Remaining': '59',
    'X-RateLimit-Reset': '1234567890',
  })),
  rateLimitExceededResponse: vi.fn(),
}))

// Import after mocks are set up
const { runAuthMiddleware, addAuthHeaders, getTierRateLimit } = await import('./auth-middleware.ts')
const { authenticateRequest } = await import('./api-key-auth.ts')
const { checkTrialLimit, trialExceededResponse } = await import('./trial-limiter.ts')
const { checkRateLimit, rateLimitExceededResponse } = await import('./rate-limiter.ts')

describe('runAuthMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('authenticated requests', () => {
    it('should allow authenticated request with tier rate limit', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        authenticated: true,
        tier: 'team',
        rateLimit: 120,
        keyPrefix: 'abc123',
      })
      vi.mocked(checkRateLimit).mockResolvedValue({
        success: true,
        remaining: 119,
        reset: 1234567890,
        limit: 120,
      })

      const req = new Request('https://example.com')
      const result = await runAuthMiddleware(req, 'skills-search', 'https://app.example.com')

      expect(result.earlyResponse).toBeNull()
      expect(result.authResult.authenticated).toBe(true)
      expect(result.authResult.tier).toBe('team')
      expect(result.trialResult).toBeUndefined()
      expect(checkTrialLimit).not.toHaveBeenCalled()
      expect(checkRateLimit).toHaveBeenCalledWith('skills-search', req, {
        customLimit: 120,
        keyPrefix: 'abc123',
      })
    })

    it('should use default community rate limit when tier rateLimit not provided', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        authenticated: true,
        tier: 'community',
        keyPrefix: 'def456',
      })
      vi.mocked(checkRateLimit).mockResolvedValue({
        success: true,
        remaining: 29,
        reset: 1234567890,
        limit: 30,
      })

      const req = new Request('https://example.com')
      await runAuthMiddleware(req, 'skills-get', null)

      expect(checkRateLimit).toHaveBeenCalledWith('skills-get', req, {
        customLimit: 30, // Community tier default
        keyPrefix: 'def456',
      })
    })
  })

  describe('unauthenticated requests - trial flow', () => {
    it('should check trial limit for unauthenticated requests', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({ authenticated: false })
      vi.mocked(checkTrialLimit).mockResolvedValue({
        allowed: true,
        used: 3,
        remaining: 7,
      })
      vi.mocked(checkRateLimit).mockResolvedValue({
        success: true,
        remaining: 9,
        reset: 1234567890,
        limit: 100,
      })

      const req = new Request('https://example.com')
      const result = await runAuthMiddleware(req, 'skills-search', null)

      expect(result.earlyResponse).toBeNull()
      expect(result.authResult.authenticated).toBe(false)
      expect(result.trialResult?.remaining).toBe(7)
      expect(checkTrialLimit).toHaveBeenCalled()
      expect(checkRateLimit).toHaveBeenCalledWith('skills-search', req, {
        customLimit: 100, // Trial tier
      })
    })

    it('should return early response when trial exceeded', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({ authenticated: false })
      vi.mocked(checkTrialLimit).mockResolvedValue({
        allowed: false,
        used: 10,
        remaining: 0,
      })
      const mockResponse = new Response('Trial exceeded', { status: 401 })
      vi.mocked(trialExceededResponse).mockReturnValue(mockResponse)

      const req = new Request('https://example.com')
      const result = await runAuthMiddleware(req, 'skills-search', 'https://app.example.com')

      expect(result.earlyResponse).toBe(mockResponse)
      expect(result.trialResult?.allowed).toBe(false)
      expect(checkRateLimit).not.toHaveBeenCalled()
    })
  })

  describe('rate limit exceeded', () => {
    it('should return early response when rate limit exceeded for authenticated user', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        authenticated: true,
        tier: 'individual',
        rateLimit: 60,
        keyPrefix: 'xyz789',
      })
      vi.mocked(checkRateLimit).mockResolvedValue({
        success: false,
        remaining: 0,
        reset: 1234567890,
        limit: 60,
      })
      const mockResponse = new Response('Rate limit exceeded', { status: 429 })
      vi.mocked(rateLimitExceededResponse).mockReturnValue(mockResponse)

      const req = new Request('https://example.com')
      const result = await runAuthMiddleware(req, 'skills-recommend', null)

      expect(result.earlyResponse).toBe(mockResponse)
      expect(result.rateLimitResult?.success).toBe(false)
    })

    it('should return early response when rate limit exceeded for trial user', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({ authenticated: false })
      vi.mocked(checkTrialLimit).mockResolvedValue({
        allowed: true,
        used: 5,
        remaining: 5,
      })
      vi.mocked(checkRateLimit).mockResolvedValue({
        success: false,
        remaining: 0,
        reset: 1234567890,
        limit: 100,
      })
      const mockResponse = new Response('Rate limit exceeded', { status: 429 })
      vi.mocked(rateLimitExceededResponse).mockReturnValue(mockResponse)

      const req = new Request('https://example.com')
      const result = await runAuthMiddleware(req, 'skills-get', null)

      expect(result.earlyResponse).toBe(mockResponse)
    })
  })
})

describe('addAuthHeaders', () => {
  it('should add X-Authenticated and X-Tier for authenticated users', () => {
    const headers = new Headers()
    const middlewareResult = {
      authResult: {
        authenticated: true,
        tier: 'team' as const,
      },
      rateLimitResult: {
        success: true,
        remaining: 119,
        reset: 1234567890,
        limit: 120,
      },
      earlyResponse: null,
    }

    addAuthHeaders(headers, middlewareResult)

    expect(headers.get('X-Authenticated')).toBe('true')
    expect(headers.get('X-Tier')).toBe('team')
    expect(headers.get('X-RateLimit-Limit')).toBe('60')
  })

  it('should add X-Trial-Remaining for unauthenticated users', () => {
    const headers = new Headers()
    const middlewareResult = {
      authResult: { authenticated: false },
      trialResult: {
        allowed: true,
        used: 3,
        remaining: 7,
      },
      rateLimitResult: {
        success: true,
        remaining: 9,
        reset: 1234567890,
        limit: 100,
      },
      earlyResponse: null,
    }

    addAuthHeaders(headers, middlewareResult)

    expect(headers.get('X-Trial-Remaining')).toBe('7')
    expect(headers.get('X-Authenticated')).toBeNull()
  })

  it('should add rate limit headers when present', () => {
    const headers = new Headers()
    const middlewareResult = {
      authResult: { authenticated: false },
      rateLimitResult: {
        success: true,
        remaining: 5,
        reset: 1234567890,
        limit: 100,
      },
      earlyResponse: null,
    }

    addAuthHeaders(headers, middlewareResult)

    expect(headers.get('X-RateLimit-Limit')).toBe('60')
    expect(headers.get('X-RateLimit-Remaining')).toBe('59')
    expect(headers.get('X-RateLimit-Reset')).toBe('1234567890')
  })

  it('should use default tier when not specified', () => {
    const headers = new Headers()
    const middlewareResult = {
      authResult: {
        authenticated: true,
        // tier not specified
      },
      rateLimitResult: {
        success: true,
        remaining: 29,
        reset: 1234567890,
        limit: 30,
      },
      earlyResponse: null,
    }

    addAuthHeaders(headers, middlewareResult)

    expect(headers.get('X-Tier')).toBe('community')
  })
})

describe('getTierRateLimit', () => {
  it('should return 100 for trial (undefined tier)', () => {
    expect(getTierRateLimit()).toBe(100)
    expect(getTierRateLimit(undefined)).toBe(100)
  })

  it('should return 30 for community tier', () => {
    expect(getTierRateLimit('community')).toBe(30)
  })

  it('should return 60 for individual tier', () => {
    expect(getTierRateLimit('individual')).toBe(60)
  })

  it('should return 120 for team tier', () => {
    expect(getTierRateLimit('team')).toBe(120)
  })

  it('should return 300 for enterprise tier', () => {
    expect(getTierRateLimit('enterprise')).toBe(300)
  })

  it('should return community rate for unknown tier', () => {
    expect(getTierRateLimit('unknown')).toBe(30)
  })
})
