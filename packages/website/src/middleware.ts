/**
 * Astro Middleware
 *
 * SMI-1715: GitHub OAuth authentication
 * SMI-1832: Extracted route logic for testability
 *
 * Handles authentication state for protected routes.
 * Note: Full auth validation is done client-side with Supabase.
 * This middleware adds helpers and basic redirect logic.
 *
 * TODO: E2E tests for auth flow (SMI-1832)
 * - Test LoginButton initiates OAuth flow correctly
 * - Test UserMenu shows user info when logged in
 * - Test UserMenu dropdown menu appears on click
 * - Test logout button redirects to home page
 * - Test protected routes redirect unauthenticated users
 * - Test auth routes redirect authenticated users to dashboard
 * - Test cache headers are set correctly (use browser devtools assertions)
 */

import { defineMiddleware } from 'astro:middleware'
import { isProtectedRoute, isAuthRoute, getAuthSecurityHeaders } from './middleware.utils'

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url

  // Check route type using extracted utility functions
  const protectedRoute = isProtectedRoute(pathname)
  const authRoute = isAuthRoute(pathname)

  // Store route info in locals for pages to access
  context.locals.isProtectedRoute = protectedRoute
  context.locals.isAuthRoute = authRoute

  // Continue to the next middleware or page
  const response = await next()

  // Add security headers for auth-related pages
  if (protectedRoute || authRoute) {
    const headers = getAuthSecurityHeaders()
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value)
    }
  }

  return response
})

// Type augmentation for Astro locals
declare global {
  namespace App {
    interface Locals {
      isProtectedRoute: boolean
      isAuthRoute: boolean
    }
  }
}
