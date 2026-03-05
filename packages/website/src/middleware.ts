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
import {
  isProtectedRoute,
  isAuthRoute,
  getAuthSecurityHeaders,
  isValidAbVariant,
  parseAbVariantFromCookie,
  parseAbWeights,
  assignAbVariantWeighted,
  buildAbVariantCookie,
} from './middleware.utils'

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url

  // Check route type using extracted utility functions
  const protectedRoute = isProtectedRoute(pathname)
  const authRoute = isAuthRoute(pathname)

  // Store route info in locals for pages to access
  context.locals.isProtectedRoute = protectedRoute
  context.locals.isAuthRoute = authRoute

  // A/B variant assignment for homepage (kill switch: HOMEPAGE_AB_ENABLED=false disables)
  const abEnabled = import.meta.env.HOMEPAGE_AB_ENABLED !== 'false'
  const cookieHeader = context.request.headers.get('cookie')

  // Read X-AB-Variant header first (set by Cloudflare Worker edge split — Wave 4).
  // Fall back to cookie if header is absent or invalid.
  const headerVariantRaw = context.request.headers.get('X-AB-Variant')
  const headerVariant =
    headerVariantRaw && isValidAbVariant(headerVariantRaw) ? headerVariantRaw : null
  const existingVariant = headerVariant ?? parseAbVariantFromCookie(cookieHeader)

  let freshlyAssigned = false
  let abVariant: import('./middleware.utils').AbVariant = existingVariant ?? 'control'
  if (abEnabled && pathname === '/' && !existingVariant) {
    const weights = parseAbWeights(import.meta.env.AB_HOME_WEIGHTS)
    abVariant = assignAbVariantWeighted(weights)
    freshlyAssigned = true
  }
  context.locals.abVariant = abVariant

  // Homepage variant routing (HOMEPAGE_V2_ENABLED guards until Wave 2+3 ship).
  // When enabled, variant-a → /index-v2, variant-b → /index-v3.
  //
  // Use string paths rather than `new Request(path, context.request)` here.
  // In Node.js (undici), `new Request('/relative-path', init)` does NOT resolve
  // the relative path against the base URL, producing a malformed Request URL.
  // Astro's `copyRequest` (used for string/URL payloads) correctly copies all
  // request headers — including Cookie and X-AB-Variant — to the rewritten
  // request, so the cookie-based variant detection works in the rewritten
  // middleware run without triggering a spurious fresh assignment. (SMI-3032)
  const homepageV2Enabled = import.meta.env.HOMEPAGE_V2_ENABLED === 'true'
  if (abEnabled && homepageV2Enabled && pathname === '/') {
    if (abVariant === 'variant-a') {
      return context.rewrite('/index-v2')
    }
    if (abVariant === 'variant-b') {
      return context.rewrite('/index-v3')
    }
  }

  // Continue to the next middleware or page
  const response = await next()

  // Persist A/B variant cookie on fresh assignment
  if (freshlyAssigned) {
    response.headers.append('Set-Cookie', buildAbVariantCookie(abVariant))
  }

  // Forward variant to downstream (Vercel Edge Cache, CDN, etc.)
  response.headers.set('X-AB-Variant', abVariant)

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
      abVariant: import('./middleware.utils').AbVariant
    }
  }
}
