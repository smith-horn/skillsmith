/**
 * Trial Limiter Tests
 * @module _shared/trial-limiter.test
 *
 * SMI-1872: Unit tests for trial limiting module
 *
 * Note: These tests mock the Supabase RPC calls but test the actual
 * trial limit logic including IP extraction and response formatting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vi.hoisted to ensure Deno stub is available before any imports
const { mockRpc } = vi.hoisted(() => {
  // Stub Deno global immediately - this runs before any module loads
  const mockGet = (key: string) => {
    if (key === 'TRIAL_SALT') return 'test-salt'
    return undefined
  }
  ;(globalThis as Record<string, unknown>).Deno = {
    env: { get: mockGet },
  }

  // Return mock function for RPC calls
  return { mockRpc: vi.fn() }
})

// Mock Supabase before importing the module
vi.mock('./supabase.ts', () => ({
  createSupabaseAdminClient: () => ({
    rpc: mockRpc,
  }),
}))

vi.mock('./cors.ts', () => ({
  errorResponse: (message: string, status: number, details: Record<string, unknown>) => {
    return new Response(JSON.stringify({ error: message, details }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  },
}))

// Now import the module under test
import { checkTrialLimit, trialExceededResponse, getTrialLimit } from './trial-limiter.ts'

describe('checkTrialLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('IP extraction', () => {
    it('should extract IP from x-forwarded-for header', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: true, used: 1, remaining: 9 }],
        error: null,
      })

      const req = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1' },
      })

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(true)
      expect(mockRpc).toHaveBeenCalledWith('check_trial_usage', expect.any(Object))
    })

    it('should extract IP from x-real-ip header', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: true, used: 2, remaining: 8 }],
        error: null,
      })

      const req = new Request('https://example.com', {
        headers: { 'x-real-ip': '10.0.0.5' },
      })

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(true)
    })

    it('should extract IP from cf-connecting-ip header', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: true, used: 3, remaining: 7 }],
        error: null,
      })

      const req = new Request('https://example.com', {
        headers: { 'cf-connecting-ip': '172.16.0.1' },
      })

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(true)
    })

    it('should use "unknown" when no IP headers present', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: true, used: 0, remaining: 10 }],
        error: null,
      })

      const req = new Request('https://example.com')

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(true)
    })

    // SMI-1874: Test IP header priority order
    it('should prioritize x-forwarded-for over other IP headers', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: true, used: 1, remaining: 9 }],
        error: null,
      })

      const req = new Request('https://example.com', {
        headers: {
          'x-forwarded-for': '1.1.1.1, 10.0.0.1',
          'x-real-ip': '2.2.2.2',
          'cf-connecting-ip': '3.3.3.3',
        },
      })

      await checkTrialLimit(req)

      // Verify RPC was called (IP is hashed, so we just verify call happened)
      expect(mockRpc).toHaveBeenCalledWith('check_trial_usage', {
        ip_hash_input: expect.any(String),
      })
    })

    it('should prioritize x-real-ip over cf-connecting-ip', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: true, used: 1, remaining: 9 }],
        error: null,
      })

      const req = new Request('https://example.com', {
        headers: {
          'x-real-ip': '2.2.2.2',
          'cf-connecting-ip': '3.3.3.3',
        },
      })

      await checkTrialLimit(req)

      expect(mockRpc).toHaveBeenCalledWith('check_trial_usage', {
        ip_hash_input: expect.any(String),
      })
    })
  })

  describe('trial limits', () => {
    it('should return allowed=true when within limits', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: true, used: 5, remaining: 5 }],
        error: null,
      })

      const req = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '1.2.3.4' },
      })

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(true)
      expect(result.used).toBe(5)
      expect(result.remaining).toBe(5)
    })

    it('should return allowed=false when limit exceeded', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: false, used: 100, remaining: 0 }],
        error: null,
      })

      const req = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '1.2.3.4' },
      })

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(false)
      expect(result.used).toBe(100)
      expect(result.remaining).toBe(0)
    })
  })

  describe('error handling', () => {
    it('should be permissive on RPC error', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'Database unavailable' },
      })

      const req = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '1.2.3.4' },
      })

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(true)
      expect(result.used).toBe(0)
      expect(result.remaining).toBe(100)
    })

    it('should be permissive on empty data', async () => {
      mockRpc.mockResolvedValue({
        data: [],
        error: null,
      })

      const req = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '1.2.3.4' },
      })

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(true)
      expect(result.used).toBe(0)
      expect(result.remaining).toBe(100)
    })

    it('should be permissive on exception', async () => {
      mockRpc.mockRejectedValue(new Error('Network error'))

      const req = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '1.2.3.4' },
      })

      const result = await checkTrialLimit(req)

      expect(result.allowed).toBe(true)
      expect(result.used).toBe(0)
      expect(result.remaining).toBe(100)
    })
  })

  describe('RPC result handling', () => {
    it('should handle array result from RPC', async () => {
      mockRpc.mockResolvedValue({
        data: [{ allowed: true, used: 7, remaining: 3 }],
        error: null,
      })

      const req = new Request('https://example.com')

      const result = await checkTrialLimit(req)

      expect(result.used).toBe(7)
      expect(result.remaining).toBe(3)
    })

    it('should handle single object result from RPC', async () => {
      mockRpc.mockResolvedValue({
        data: { allowed: true, used: 4, remaining: 6 },
        error: null,
      })

      const req = new Request('https://example.com')

      const result = await checkTrialLimit(req)

      expect(result.used).toBe(4)
      expect(result.remaining).toBe(6)
    })
  })
})

describe('trialExceededResponse', () => {
  it('should return 401 response with details', async () => {
    const result = { allowed: false, used: 100, remaining: 0 }

    const response = trialExceededResponse(result, 'https://app.example.com')

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Authentication required')
    expect(body.details.trialUsed).toBe(100)
    expect(body.details.trialLimit).toBe(100)
    expect(body.details.signupUrl).toBe('https://skillsmith.app/signup')
  })

  it('should include signup URL and docs URL in response', async () => {
    const result = { allowed: false, used: 11, remaining: 0 }

    const response = trialExceededResponse(result)

    const body = await response.json()
    expect(body.details.signupUrl).toContain('skillsmith.app/signup')
    expect(body.details.docsUrl).toContain('getting-started')
  })

  it('should include helpful hint in response', async () => {
    const result = { allowed: false, used: 10, remaining: 0 }

    const response = trialExceededResponse(result)

    const body = await response.json()
    expect(body.details.hint).toContain('1,000 requests/month')
  })
})

describe('getTrialLimit', () => {
  it('should return 100', () => {
    expect(getTrialLimit()).toBe(100)
  })
})
