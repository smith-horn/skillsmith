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
  validateCspHeaderDetailed,
  cspMiddleware,
  getCspForEnvironment,
  type CspDirectives,
  type CspHttpRequest,
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

    it('should generate valid base64 nonces', () => {
      const nonce = generateNonce()
      // Base64 can include A-Z, a-z, 0-9, +, /, and = for padding
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/)
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
      // Use valid base64 nonce (no hyphens)
      const nonce = 'dGVzdG5vbmNlMTIz'
      const header = buildCspHeader(directives, nonce)
      expect(header).toContain(`'nonce-${nonce}'`)
    })

    it('should add nonce to style-src', () => {
      const directives: CspDirectives = {
        'style-src': ["'self'"],
      }
      // Use valid base64 nonce (no hyphens)
      const nonce = 'dGVzdG5vbmNlMTIz'
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

    it('should handle string directives like report-to', () => {
      const directives: CspDirectives = {
        'default-src': ["'self'"],
        'report-to': 'csp-endpoint',
      }
      const header = buildCspHeader(directives)
      expect(header).toContain('report-to csp-endpoint')
    })

    it('should include all STRICT_CSP_DIRECTIVES values', () => {
      const header = buildCspHeader(STRICT_CSP_DIRECTIVES)
      expect(header).toContain("worker-src 'none'")
      expect(header).toContain("form-action 'none'")
      expect(header).toContain("frame-ancestors 'none'")
      expect(header).toContain("base-uri 'none'")
      expect(header).toContain("manifest-src 'self'")
      expect(header).toContain("require-trusted-types-for 'script'")
    })

    it('should properly format nonce in script-src', () => {
      const directives: CspDirectives = {
        'script-src': ["'self'"],
      }
      const nonce = 'abc123XYZ'
      const header = buildCspHeader(directives, nonce)
      expect(header).toBe("script-src 'self' 'nonce-abc123XYZ'")
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
      expect(validateCspHeader(null as unknown as string)).toBe(false)
      expect(validateCspHeader(undefined as unknown as string)).toBe(false)
      expect(validateCspHeader(123 as unknown as string)).toBe(false)
    })

    it('should warn about unsafe-eval', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "script-src 'self' 'unsafe-eval'"
      validateCspHeader(header)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('unsafe-eval'))
      consoleSpy.mockRestore()
    })

    it('should warn about unsafe-inline without nonce', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "script-src 'self' 'unsafe-inline'"
      validateCspHeader(header)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('unsafe-inline'))
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

    it('should accept sandbox as a valid directive', () => {
      const header = 'sandbox allow-scripts'
      expect(validateCspHeader(header)).toBe(true)
    })
  })

  describe('validateCspHeaderDetailed', () => {
    it('should return detailed validation result for valid CSP', () => {
      const header = "default-src 'self'; script-src 'self'"
      const result = validateCspHeaderDetailed(header)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should return error for empty CSP', () => {
      const result = validateCspHeaderDetailed('')
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('CSP header must be a non-empty string')
    })

    it('should warn about wildcard in script-src', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "script-src 'self' *"
      const result = validateCspHeaderDetailed(header)
      expect(result.warnings).toContain('Wildcard (*) in script-src is overly permissive')
      consoleSpy.mockRestore()
    })

    it('should warn about data: URI in script-src', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "script-src 'self' data:"
      const result = validateCspHeaderDetailed(header)
      expect(result.warnings).toContain('data: URI in script-src allows XSS attacks')
      consoleSpy.mockRestore()
    })

    it('should warn about missing default-src', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "script-src 'self'"
      const result = validateCspHeaderDetailed(header)
      expect(result.warnings).toContain(
        'Missing default-src - other directives may fall back to permissive defaults'
      )
      consoleSpy.mockRestore()
    })

    it('should include warning details for unsafe-eval', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "default-src 'self'; script-src 'self' 'unsafe-eval'"
      const result = validateCspHeaderDetailed(header)
      // Updated warning message for per-directive validation
      expect(result.warnings).toContain(
        'unsafe-eval detected in script-src or default-src - allows arbitrary code execution'
      )
      consoleSpy.mockRestore()
    })

    it('should include warning details for unsafe-inline without nonce', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "default-src 'self'; script-src 'self' 'unsafe-inline'"
      const result = validateCspHeaderDetailed(header)
      // Updated warning message for per-directive validation
      expect(result.warnings).toContain(
        'unsafe-inline without nonce in script-src - vulnerable to XSS'
      )
      consoleSpy.mockRestore()
    })

    it('should not warn about unsafe-inline when nonce is present', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const header = "default-src 'self'; script-src 'self' 'unsafe-inline' 'nonce-abc123'"
      const result = validateCspHeaderDetailed(header)
      // Updated warning message check
      expect(result.warnings).not.toContain(
        'unsafe-inline without nonce in script-src - vulnerable to XSS'
      )
      consoleSpy.mockRestore()
    })
  })

  describe('cspMiddleware', () => {
    interface MockResponse {
      setHeader: ReturnType<typeof vi.fn> & ((name: string, value: string) => void)
      locals?: Record<string, unknown>
    }

    let mockReq: CspHttpRequest
    let mockRes: MockResponse
    let mockNext: () => void

    beforeEach(() => {
      mockReq = {}
      mockRes = {
        setHeader: vi.fn() as MockResponse['setHeader'],
        locals: {},
      }
      mockNext = vi.fn()
    })

    it('should set CSP header', () => {
      const middleware = cspMiddleware()
      middleware(mockReq, mockRes, mockNext)

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Security-Policy', expect.any(String))
    })

    it('should add nonce to response locals', () => {
      const middleware = cspMiddleware()
      middleware(mockReq, mockRes, mockNext)

      expect(mockRes.locals).toBeDefined()
      expect(mockRes.locals!.cspNonce).toBeDefined()
      expect(typeof mockRes.locals!.cspNonce).toBe('string')
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
      expect(mockRes.locals!.cspNonce).toBeDefined()
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

    it('should restrict base-uri in production to prevent base tag injection', () => {
      const csp = getCspForEnvironment('production')
      expect(csp['base-uri']).toEqual(["'none'"])
    })

    it('should include require-trusted-types-for in strict mode', () => {
      expect(STRICT_CSP_DIRECTIVES['require-trusted-types-for']).toEqual(["'script'"])
    })

    it('should restrict manifest-src in strict mode', () => {
      expect(STRICT_CSP_DIRECTIVES['manifest-src']).toEqual(["'self'"])
    })

    it('should block all frame-src in strict mode', () => {
      expect(STRICT_CSP_DIRECTIVES['frame-src']).toEqual(["'none'"])
    })

    it('should block all workers in strict mode', () => {
      expect(STRICT_CSP_DIRECTIVES['worker-src']).toEqual(["'none'"])
    })

    it('should have restrictive form-action in strict mode', () => {
      expect(STRICT_CSP_DIRECTIVES['form-action']).toEqual(["'none'"])
    })

    it('should generate cryptographically unique nonces', () => {
      // Generate multiple nonces and ensure they are all unique
      const nonces = new Set<string>()
      for (let i = 0; i < 100; i++) {
        nonces.add(generateNonce())
      }
      expect(nonces.size).toBe(100)
    })

    it('should have nonces with sufficient entropy', () => {
      const nonce = generateNonce()
      // Base64 of 16 bytes = 24 characters (with padding)
      // Without padding, it could be 22 characters
      expect(nonce.length).toBeGreaterThanOrEqual(22)
    })
  })

  describe('Directive Configuration', () => {
    it('should include all required security directives in DEFAULT_CSP_DIRECTIVES', () => {
      const requiredDirectives = [
        'default-src',
        'script-src',
        'style-src',
        'img-src',
        'connect-src',
        'frame-ancestors',
        'base-uri',
        'form-action',
      ]
      for (const directive of requiredDirectives) {
        expect(DEFAULT_CSP_DIRECTIVES).toHaveProperty(directive)
      }
    })

    it('should include all required security directives in STRICT_CSP_DIRECTIVES', () => {
      const requiredDirectives = [
        'default-src',
        'script-src',
        'style-src',
        'img-src',
        'connect-src',
        'frame-ancestors',
        'base-uri',
        'form-action',
        'object-src',
        'frame-src',
        'worker-src',
      ]
      for (const directive of requiredDirectives) {
        expect(STRICT_CSP_DIRECTIVES).toHaveProperty(directive)
      }
    })

    it('should have object-src set to none in both default and strict', () => {
      expect(DEFAULT_CSP_DIRECTIVES['object-src']).toEqual(["'none'"])
      expect(STRICT_CSP_DIRECTIVES['object-src']).toEqual(["'none'"])
    })
  })
})
