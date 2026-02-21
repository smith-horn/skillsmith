/**
 * Middleware Utility Functions
 *
 * SMI-1832: Extracted for testability
 *
 * Pure functions for route detection logic.
 * These can be unit tested without Astro runtime.
 */

/**
 * Routes that require authentication.
 * Users visiting these routes without valid auth cookies
 * will be redirected to login (handled client-side).
 */
export const PROTECTED_ROUTES = ['/account', '/account/billing', '/account/subscription'] as const

/**
 * Routes that should redirect to dashboard if already authenticated.
 * These are auth-related pages that don't make sense when logged in.
 */
export const AUTH_ROUTES = ['/login', '/signup'] as const

/**
 * Cache-Control header value for auth-related pages.
 * Prevents caching of sensitive authentication pages.
 */
export const AUTH_CACHE_CONTROL = 'private, no-cache, no-store, must-revalidate'

/**
 * Check if a pathname matches a protected route.
 * Matches exact routes and their sub-paths.
 *
 * @param pathname - The URL pathname to check
 * @returns true if the route requires authentication
 *
 * @example
 * isProtectedRoute('/account') // true
 * isProtectedRoute('/account/billing') // true
 * isProtectedRoute('/account/settings') // true (sub-path of /account)
 * isProtectedRoute('/login') // false
 * isProtectedRoute('/') // false
 */
export function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

/**
 * Check if a pathname is an auth-related route.
 * These routes should redirect authenticated users away.
 *
 * @param pathname - The URL pathname to check
 * @returns true if the route is an auth page (login, signup)
 *
 * @example
 * isAuthRoute('/login') // true
 * isAuthRoute('/signup') // true
 * isAuthRoute('/account') // false
 * isAuthRoute('/') // false
 */
export function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTES.includes(pathname as (typeof AUTH_ROUTES)[number])
}

/**
 * Determine if a response should have no-cache headers.
 * Auth-related pages (both protected and login/signup) should not be cached.
 *
 * @param pathname - The URL pathname to check
 * @returns true if cache should be disabled
 */
export function shouldDisableCache(pathname: string): boolean {
  return isProtectedRoute(pathname) || isAuthRoute(pathname)
}

/**
 * Get the security headers for auth-related pages.
 * Returns headers that prevent caching.
 *
 * @returns Headers object with cache-disabling headers
 */
export function getAuthSecurityHeaders(): Record<string, string> {
  return {
    'Cache-Control': AUTH_CACHE_CONTROL,
    Pragma: 'no-cache',
    Expires: '0',
  }
}

// ─── A/B Testing (homepage category grid experiment) ─────────────────────────

/** Cookie name for the A/B variant assignment */
export const AB_VARIANT_COOKIE = 'sk_ab_variant'

/** 30-day TTL in seconds */
export const AB_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

/** Valid A/B variant values */
export const AB_VARIANTS = ['control', 'variant-b'] as const
export type AbVariant = (typeof AB_VARIANTS)[number]

/**
 * Returns true if the value is a known AbVariant.
 */
export function isValidAbVariant(value: unknown): value is AbVariant {
  return AB_VARIANTS.includes(value as AbVariant)
}

/**
 * Reads the AB_VARIANT_COOKIE from a Cookie header string.
 * Returns the variant if valid, null otherwise.
 *
 * @param cookieHeader - Raw `Cookie:` header value (e.g. "sk_ab_variant=control; session=abc")
 * Note: URL-encoded cookie values (rare) will fail isValidAbVariant and return null.
 */
export function parseAbVariantFromCookie(cookieHeader: string | null): AbVariant | null {
  if (!cookieHeader) return null
  const match = cookieHeader.match(/(?:^|;\s*)sk_ab_variant=([^;]+)/)
  if (!match) return null
  const value = match[1].trim()
  return isValidAbVariant(value) ? value : null
}

/**
 * Randomly assigns a variant with equal 50/50 probability.
 */
export function assignAbVariant(): AbVariant {
  return Math.random() < 0.5 ? 'control' : 'variant-b'
}

/**
 * Builds the Set-Cookie header string for the AB variant.
 * Note: The Secure flag prevents this cookie from being set on http://localhost.
 * For local testing of variant-b, set the cookie manually via browser DevTools.
 *
 * @param variant - The variant to persist
 * @returns Set-Cookie header value
 */
export function buildAbVariantCookie(variant: AbVariant): string {
  return `${AB_VARIANT_COOKIE}=${variant}; Max-Age=${AB_COOKIE_MAX_AGE}; Path=/; SameSite=Lax; Secure`
}
