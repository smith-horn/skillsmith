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
