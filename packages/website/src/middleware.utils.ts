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
