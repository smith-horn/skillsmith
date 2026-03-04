/**
 * Middleware Unit Tests
 *
 * SMI-1832: Test coverage for auth middleware from SMI-1715
 *
 * Tests the pure utility functions extracted from middleware.ts.
 * The Astro middleware runtime (defineMiddleware) is tested via E2E tests.
 */

import { describe, it, expect } from 'vitest'
import {
  PROTECTED_ROUTES,
  AUTH_ROUTES,
  AUTH_CACHE_CONTROL,
  isProtectedRoute,
  isAuthRoute,
  shouldDisableCache,
  getAuthSecurityHeaders,
} from '../middleware.utils'
import {
  AB_VARIANT_COOKIE,
  AB_COOKIE_MAX_AGE,
  AB_VARIANTS,
  DEFAULT_AB_WEIGHTS,
  isValidAbVariant,
  parseAbVariantFromCookie,
  parseAbWeights,
  assignAbVariant,
  assignAbVariantWeighted,
  buildAbVariantCookie,
} from '../middleware.utils'

describe('Middleware Route Detection', () => {
  describe('PROTECTED_ROUTES', () => {
    it('should include /account', () => {
      expect(PROTECTED_ROUTES).toContain('/account')
    })

    it('should include /account/billing', () => {
      expect(PROTECTED_ROUTES).toContain('/account/billing')
    })

    it('should include /account/subscription', () => {
      expect(PROTECTED_ROUTES).toContain('/account/subscription')
    })

    it('should have exactly 3 protected routes', () => {
      expect(PROTECTED_ROUTES).toHaveLength(3)
    })
  })

  describe('AUTH_ROUTES', () => {
    it('should include /login', () => {
      expect(AUTH_ROUTES).toContain('/login')
    })

    it('should include /signup', () => {
      expect(AUTH_ROUTES).toContain('/signup')
    })

    it('should have exactly 2 auth routes', () => {
      expect(AUTH_ROUTES).toHaveLength(2)
    })
  })

  describe('isProtectedRoute', () => {
    it('should return true for /account', () => {
      expect(isProtectedRoute('/account')).toBe(true)
    })

    it('should return true for /account/billing', () => {
      expect(isProtectedRoute('/account/billing')).toBe(true)
    })

    it('should return true for /account/subscription', () => {
      expect(isProtectedRoute('/account/subscription')).toBe(true)
    })

    it('should return true for sub-paths of /account', () => {
      expect(isProtectedRoute('/account/settings')).toBe(true)
      expect(isProtectedRoute('/account/profile')).toBe(true)
      expect(isProtectedRoute('/account/api-keys')).toBe(true)
    })

    it('should return true for deeply nested sub-paths', () => {
      expect(isProtectedRoute('/account/billing/history')).toBe(true)
      expect(isProtectedRoute('/account/subscription/plans')).toBe(true)
    })

    it('should return false for non-protected paths', () => {
      expect(isProtectedRoute('/')).toBe(false)
      expect(isProtectedRoute('/login')).toBe(false)
      expect(isProtectedRoute('/signup')).toBe(false)
      expect(isProtectedRoute('/docs')).toBe(false)
      expect(isProtectedRoute('/pricing')).toBe(false)
    })

    it('should return false for paths that contain but do not start with protected routes', () => {
      expect(isProtectedRoute('/my-account')).toBe(false)
      expect(isProtectedRoute('/user/account')).toBe(false)
      expect(isProtectedRoute('/settings/account')).toBe(false)
    })

    it('should return false for empty string', () => {
      expect(isProtectedRoute('')).toBe(false)
    })

    it('should handle trailing slashes correctly', () => {
      // Paths with trailing slashes are sub-paths of the protected route
      expect(isProtectedRoute('/account/')).toBe(true)
    })
  })

  describe('isAuthRoute', () => {
    it('should return true for /login', () => {
      expect(isAuthRoute('/login')).toBe(true)
    })

    it('should return true for /signup', () => {
      expect(isAuthRoute('/signup')).toBe(true)
    })

    it('should return false for protected routes', () => {
      expect(isAuthRoute('/account')).toBe(false)
      expect(isAuthRoute('/account/billing')).toBe(false)
    })

    it('should return false for non-auth paths', () => {
      expect(isAuthRoute('/')).toBe(false)
      expect(isAuthRoute('/docs')).toBe(false)
      expect(isAuthRoute('/pricing')).toBe(false)
      expect(isAuthRoute('/contact')).toBe(false)
    })

    it('should return false for paths containing auth route names', () => {
      expect(isAuthRoute('/login/callback')).toBe(false)
      expect(isAuthRoute('/signup/verify')).toBe(false)
      expect(isAuthRoute('/auth/login')).toBe(false)
    })

    it('should return false for empty string', () => {
      expect(isAuthRoute('')).toBe(false)
    })

    it('should be case-sensitive', () => {
      expect(isAuthRoute('/Login')).toBe(false)
      expect(isAuthRoute('/SIGNUP')).toBe(false)
    })
  })

  describe('shouldDisableCache', () => {
    it('should return true for protected routes', () => {
      expect(shouldDisableCache('/account')).toBe(true)
      expect(shouldDisableCache('/account/billing')).toBe(true)
      expect(shouldDisableCache('/account/subscription')).toBe(true)
    })

    it('should return true for auth routes', () => {
      expect(shouldDisableCache('/login')).toBe(true)
      expect(shouldDisableCache('/signup')).toBe(true)
    })

    it('should return false for public routes', () => {
      expect(shouldDisableCache('/')).toBe(false)
      expect(shouldDisableCache('/docs')).toBe(false)
      expect(shouldDisableCache('/pricing')).toBe(false)
      expect(shouldDisableCache('/about')).toBe(false)
    })
  })
})

describe('Middleware Cache Headers', () => {
  describe('AUTH_CACHE_CONTROL', () => {
    it('should include private directive', () => {
      expect(AUTH_CACHE_CONTROL).toContain('private')
    })

    it('should include no-cache directive', () => {
      expect(AUTH_CACHE_CONTROL).toContain('no-cache')
    })

    it('should include no-store directive', () => {
      expect(AUTH_CACHE_CONTROL).toContain('no-store')
    })

    it('should include must-revalidate directive', () => {
      expect(AUTH_CACHE_CONTROL).toContain('must-revalidate')
    })
  })

  describe('getAuthSecurityHeaders', () => {
    it('should return Cache-Control header', () => {
      const headers = getAuthSecurityHeaders()
      expect(headers['Cache-Control']).toBe(AUTH_CACHE_CONTROL)
    })

    it('should return Pragma header set to no-cache', () => {
      const headers = getAuthSecurityHeaders()
      expect(headers['Pragma']).toBe('no-cache')
    })

    it('should return Expires header set to 0', () => {
      const headers = getAuthSecurityHeaders()
      expect(headers['Expires']).toBe('0')
    })

    it('should return exactly 3 headers', () => {
      const headers = getAuthSecurityHeaders()
      expect(Object.keys(headers)).toHaveLength(3)
    })

    it('should return a new object on each call (immutability)', () => {
      const headers1 = getAuthSecurityHeaders()
      const headers2 = getAuthSecurityHeaders()
      expect(headers1).not.toBe(headers2)
      expect(headers1).toEqual(headers2)
    })
  })
})

describe('Edge Cases', () => {
  describe('URL path variations', () => {
    it('should handle query strings (they should not affect route matching)', () => {
      // Note: URL.pathname strips query strings, so these test the function behavior
      expect(isProtectedRoute('/account?tab=billing')).toBe(false)
      expect(isAuthRoute('/login?redirect=/dashboard')).toBe(false)
    })

    it('should handle hash fragments', () => {
      // Note: URL.pathname strips hash fragments
      expect(isProtectedRoute('/account#settings')).toBe(false)
      expect(isAuthRoute('/login#form')).toBe(false)
    })

    it('should handle paths with special characters', () => {
      expect(isProtectedRoute('/account%20test')).toBe(false)
      expect(isProtectedRoute('/account-test')).toBe(false)
    })
  })

  describe('boundary conditions', () => {
    it('should handle very long paths', () => {
      const longPath = '/account/' + 'a'.repeat(1000)
      expect(isProtectedRoute(longPath)).toBe(true)
    })

    it('should handle unicode paths', () => {
      expect(isProtectedRoute('/account/\u4e2d\u6587')).toBe(true)
      expect(isAuthRoute('/\u30ed\u30b0\u30a4\u30f3')).toBe(false)
    })
  })
})

describe('A/B Testing Utilities', () => {
  describe('isValidAbVariant', () => {
    it('should return true for "control"', () => {
      expect(isValidAbVariant('control')).toBe(true)
    })
    it('should return true for "variant-b"', () => {
      expect(isValidAbVariant('variant-b')).toBe(true)
    })
    it('should return false for unknown strings', () => {
      expect(isValidAbVariant('variant-x')).toBe(false)
      expect(isValidAbVariant('')).toBe(false)
      expect(isValidAbVariant(null)).toBe(false)
      expect(isValidAbVariant(undefined)).toBe(false)
    })
  })

  describe('parseAbVariantFromCookie', () => {
    it('should parse "control" from cookie header', () => {
      expect(parseAbVariantFromCookie('sk_ab_variant=control')).toBe('control')
    })
    it('should parse "variant-b" from cookie header', () => {
      expect(parseAbVariantFromCookie('sk_ab_variant=variant-b')).toBe('variant-b')
    })
    it('should parse when other cookies are present', () => {
      expect(parseAbVariantFromCookie('session=abc; sk_ab_variant=control; other=xyz')).toBe(
        'control'
      )
    })
    it('should return null for null input', () => {
      expect(parseAbVariantFromCookie(null)).toBeNull()
    })
    it('should return null when cookie is absent', () => {
      expect(parseAbVariantFromCookie('session=abc; other=xyz')).toBeNull()
    })
    it('should return null for unknown variant values', () => {
      expect(parseAbVariantFromCookie('sk_ab_variant=variant-x')).toBeNull()
    })
  })

  describe('assignAbVariant', () => {
    it('should return a valid AbVariant', () => {
      const result = assignAbVariant()
      expect(AB_VARIANTS).toContain(result)
    })
    it('should produce both variants over many calls (probabilistic)', () => {
      const results = new Set(Array.from({ length: 200 }, () => assignAbVariant()))
      expect(results.has('control')).toBe(true)
      expect(results.has('variant-b')).toBe(true)
    })
  })

  describe('buildAbVariantCookie', () => {
    it('should include the cookie name and value', () => {
      const cookie = buildAbVariantCookie('control')
      expect(cookie).toContain('sk_ab_variant=control')
    })
    it('should include Max-Age', () => {
      const cookie = buildAbVariantCookie('control')
      expect(cookie).toContain(`Max-Age=${AB_COOKIE_MAX_AGE}`)
    })
    it('should include Path=/', () => {
      const cookie = buildAbVariantCookie('control')
      expect(cookie).toContain('Path=/')
    })
    it('should include SameSite=Lax', () => {
      const cookie = buildAbVariantCookie('control')
      expect(cookie).toContain('SameSite=Lax')
    })
    it('should include Secure', () => {
      const cookie = buildAbVariantCookie('control')
      expect(cookie).toContain('Secure')
    })
    it('should work for variant-b', () => {
      const cookie = buildAbVariantCookie('variant-b')
      expect(cookie).toContain('sk_ab_variant=variant-b')
    })
  })

  describe('AB_VARIANT_COOKIE and AB_COOKIE_MAX_AGE', () => {
    it('AB_VARIANT_COOKIE should equal sk_ab_variant', () => {
      expect(AB_VARIANT_COOKIE).toBe('sk_ab_variant')
    })
    it('AB_COOKIE_MAX_AGE should equal 30 days in seconds', () => {
      expect(AB_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 30)
    })
  })
})

describe('3-variant A/B utilities', () => {
  describe('parseAbWeights', () => {
    it('should return DEFAULT_AB_WEIGHTS for undefined', () => {
      expect(parseAbWeights(undefined)).toEqual([...DEFAULT_AB_WEIGHTS])
    })
    it('should parse valid "80,10,10"', () => {
      expect(parseAbWeights('80,10,10')).toEqual([80, 10, 10])
    })
    it('should parse valid "60,20,20"', () => {
      expect(parseAbWeights('60,20,20')).toEqual([60, 20, 20])
    })
    it('should return defaults when sum is not 100', () => {
      expect(parseAbWeights('50,10,10')).toEqual([...DEFAULT_AB_WEIGHTS])
    })
    it('should return defaults for non-numeric values', () => {
      expect(parseAbWeights('a,b,c')).toEqual([...DEFAULT_AB_WEIGHTS])
    })
    it('should return defaults for wrong length (2 parts)', () => {
      expect(parseAbWeights('50,50')).toEqual([...DEFAULT_AB_WEIGHTS])
    })
    it('should return defaults for wrong length (4 parts)', () => {
      expect(parseAbWeights('25,25,25,25')).toEqual([...DEFAULT_AB_WEIGHTS])
    })
  })

  describe('assignAbVariantWeighted', () => {
    it('should only return valid AbVariant values', () => {
      for (let i = 0; i < 100; i++) {
        expect(AB_VARIANTS).toContain(assignAbVariantWeighted([...DEFAULT_AB_WEIGHTS]))
      }
    })
    it('should return "control" exclusively when weight is [100,0,0]', () => {
      for (let i = 0; i < 50; i++) {
        expect(assignAbVariantWeighted([100, 0, 0])).toBe('control')
      }
    })
    it('should return "variant-a" exclusively when weight is [0,100,0]', () => {
      for (let i = 0; i < 50; i++) {
        expect(assignAbVariantWeighted([0, 100, 0])).toBe('variant-a')
      }
    })
    it('should return "variant-b" exclusively when weight is [0,0,100]', () => {
      for (let i = 0; i < 50; i++) {
        expect(assignAbVariantWeighted([0, 0, 100])).toBe('variant-b')
      }
    })
    it('should produce all 3 variants over 500 iterations with default weights', () => {
      const results = new Set(
        Array.from({ length: 500 }, () => assignAbVariantWeighted([...DEFAULT_AB_WEIGHTS]))
      )
      expect(results.has('control')).toBe(true)
      expect(results.has('variant-a')).toBe(true)
      expect(results.has('variant-b')).toBe(true)
    })
  })

  describe('isValidAbVariant with variant-a', () => {
    it('should return true for "variant-a"', () => {
      expect(isValidAbVariant('variant-a')).toBe(true)
    })
  })

  describe('parseAbVariantFromCookie with variant-a', () => {
    it('should parse "variant-a" from cookie header', () => {
      expect(parseAbVariantFromCookie('sk_ab_variant=variant-a')).toBe('variant-a')
    })
    it('should parse "variant-a" when other cookies are present', () => {
      expect(parseAbVariantFromCookie('session=abc; sk_ab_variant=variant-a; other=xyz')).toBe(
        'variant-a'
      )
    })
  })
})
