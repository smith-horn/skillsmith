/**
 * Tests for Content Security Policy middleware and utilities
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_CSP_DIRECTIVES,
  STRICT_CSP_DIRECTIVES,
  generateNonce,
  buildCspHeader,
  validateCspHeader,
  cspMiddleware,
  getCspForEnvironment,
  type CspDirectives,
} from '../csp.js'

describe('CSP Utilities', () => {
  describe('generateNonce', () => {
    it('should generate a nonce', () => {
      const nonce = generateNonce()
      expect(nonce).toBeDefined()
      expect(typeof nonce).toBe('string')
    })

    it('should generate nonces of sufficient length', () => {
      const nonce = generateNonce()
      expect(nonce.length).toBeGreaterThanOrEqual(16)
    })

    it('should generate unique nonces', () => {
      const nonce1 = generateNonce()
      const nonce2 = generateNonce()
      expect(nonce1).not.toBe(nonce2)
    })

    it('should generate alphanumeric nonces', () => {
      const nonce = generateNonce()
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+$/)
    })
  })

  describe('buildCspHeader', () => {
    it('should build a basic CSP header', () => {
      const directives: CspDirectives = {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
      }
      const header = buildCspHeader(directives)
      expect(header).toContain("default-src 'self'")
      expect(header).toContain("script-src 'self'")
    })

    it('should add nonce to script-src', () => {
      const directives: CspDirectives = {
        'script-src': ["'self'"],
      }
      const nonce = 'test-nonce-123'
      const header = buildCspHeader(directives, nonce)
      expect(header).toContain(`'nonce-${nonce}'`)
    })

    it('should add nonce to style-src', () => {
      const directives: CspDirectives = {
        'style-src': ["'self'"],
      }
      const nonce = 'test-nonce-123'
      const header = buildCspHeader(directives, nonce)
      expect(header).toContain(`'nonce-${nonce}'`)
    })

    it('should handle boolean directives', () => {
      const directives: CspDirectives = {
        'upgrade-insecure-requests': true,
        'block-all-mixed-content': true,
      }
      const header = buildCspHeader(directives)
      expect(header).toContain('upgrade-insecure-requests')
      expect(header).toContain('block-all-mixed-content')
    })

    it('should not include false boolean directives', () => {
      const directives: CspDirectives = {
        'upgrade-insecure-requests': false,
      }
      const header = buildCspHeader(directives)
      expect(header).not.toContain('upgrade-insecure-requests')
    })

    it('should handle multiple sources', () => {
      const directives: CspDirectives = {
        'img-src': ["'self'", 'data:', 'https:'],
      }
      const header = buildCspHeader(directives)
      expect(header).toContain("img-src 'self' data: https:")
    })

    it('should use DEFAULT_CSP_DIRECTIVES', () => {
      const header = buildCspHeader(DEFAULT_CSP_DIRECTIVES)
      expect(header).toContain("default-src 'self'")
      expect(header).toContain("script-src 'self'")
      expect(header).toContain("object-src 'none'")
      expect(header).toContain('upgrade-insecure-requests')
    })

    it('should use STRICT_CSP_DIRECTIVES', () => {
      const header = buildCspHeader(STRICT_CSP_DIRECTIVES)
      expect(header).toContain("default-src 'none'")
      expect(header).toContain("script-src 'self'")
      expect(header).toContain("object-src 'none'")
    })
  })

  describe('validateCspHeader', () => {
    it('should validate a proper CSP header', () => {
      const header = "default-src 'self'; script-src 'self'"
      expect(validateCspHeader(header)).toBe(true)
    })

    it('should reject empty CSP', () => {
      expect(validateCspHeader('')).toBe(false)
    })

    it('should reject non-string CSP', () => {
      expect(validateCspHeader(null as any)).toBe(false)
      expect(validateCspHeader(undefined as any)).toBe(false)
      expect(validateCspHeader(123 as any)).toBe(false)
    })

    it('should warn about unsafe-eval', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "script-src 'self' 'unsafe-eval'"
      validateCspHeader(header)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('unsafe-eval')
      )
      consoleSpy.mockRestore()
    })

    it('should warn about unsafe-inline without nonce', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "script-src 'self' 'unsafe-inline'"
      validateCspHeader(header)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('unsafe-inline')
      )
      consoleSpy.mockRestore()
    })

    it('should not warn about unsafe-inline with nonce', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "script-src 'self' 'unsafe-inline' 'nonce-abc123'"
      validateCspHeader(header)
      expect(consoleSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('should reject CSP without directives', () => {
      const header = 'not a valid csp'
      expect(validateCspHeader(header)).toBe(false)
    })
  })

  describe('cspMiddleware', () => {
    let mockReq: any
    let mockRes: any
    let mockNext: any

    beforeEach(() => {
      mockReq = {}
      mockRes = {
        setHeader: vi.fn(),
        locals: {},
      }
      mockNext = vi.fn()
    })

    it('should set CSP header', () => {
      const middleware = cspMiddleware()
      middleware(mockReq, mockRes, mockNext)

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Security-Policy',
        expect.any(String)
      )
    })

    it('should add nonce to response locals', () => {
      const middleware = cspMiddleware()
      middleware(mockReq, mockRes, mockNext)

      expect(mockRes.locals.cspNonce).toBeDefined()
      expect(typeof mockRes.locals.cspNonce).toBe('string')
    })

    it('should call next', () => {
      const middleware = cspMiddleware()
      middleware(mockReq, mockRes, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('should use custom directives', () => {
      const customDirectives: CspDirectives = {
        'default-src': ["'none'"],
      }
      const middleware = cspMiddleware(customDirectives)
      middleware(mockReq, mockRes, mockNext)

      const cspHeader = mockRes.setHeader.mock.calls[0][1]
      expect(cspHeader).toContain("default-src 'none'")
    })

    it('should create locals object if missing', () => {
      mockRes.locals = undefined
      const middleware = cspMiddleware()
      middleware(mockReq, mockRes, mockNext)

      expect(mockRes.locals).toBeDefined()
      expect(mockRes.locals.cspNonce).toBeDefined()
    })
  })

  describe('getCspForEnvironment', () => {
    it('should return strict CSP for production', () => {
      const csp = getCspForEnvironment('production')
      expect(csp['default-src']).toEqual(["'none'"])
    })

    it('should return strict CSP by default', () => {
      const csp = getCspForEnvironment()
      expect(csp['default-src']).toEqual(["'none'"])
    })

    it('should allow unsafe-eval for development', () => {
      const csp = getCspForEnvironment('development')
      expect(csp['script-src']).toContain("'unsafe-eval'")
    })

    it('should be permissive for test environment', () => {
      const csp = getCspForEnvironment('test')
      expect(csp['script-src']).toContain("'unsafe-inline'")
      expect(csp['script-src']).toContain("'unsafe-eval'")
      expect(csp['style-src']).toContain("'unsafe-inline'")
    })
  })

  describe('Security Requirements', () => {
    it('should not allow unsafe-eval in production', () => {
      const csp = getCspForEnvironment('production')
      const header = buildCspHeader(csp)
      expect(header).not.toContain("'unsafe-eval'")
    })

    it('should not allow unsafe-inline in production', () => {
      const csp = getCspForEnvironment('production')
      const header = buildCspHeader(csp)
      expect(header).not.toContain("'unsafe-inline'")
    })

    it('should block object-src in all environments', () => {
      const prodCsp = getCspForEnvironment('production')
      const devCsp = getCspForEnvironment('development')
      const testCsp = getCspForEnvironment('test')

      expect(prodCsp['object-src']).toEqual(["'none'"])
      expect(devCsp['object-src']).toEqual(["'none'"])
      expect(testCsp['object-src']).toEqual(["'none'"])
    })

    it('should upgrade insecure requests in production', () => {
      const csp = getCspForEnvironment('production')
      expect(csp['upgrade-insecure-requests']).toBe(true)
    })

    it('should block mixed content in production', () => {
      const csp = getCspForEnvironment('production')
      expect(csp['block-all-mixed-content']).toBe(true)
    })

    it('should prevent frame embedding in production', () => {
      const csp = getCspForEnvironment('production')
      expect(csp['frame-ancestors']).toEqual(["'none'"])
    })
  })
})
