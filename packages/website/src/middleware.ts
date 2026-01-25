/**
 * Astro Middleware
 *
 * SMI-1715: GitHub OAuth authentication
 *
 * Handles authentication state for protected routes.
 * Note: Full auth validation is done client-side with Supabase.
 * This middleware adds helpers and basic redirect logic.
 */

import { defineMiddleware } from 'astro:middleware';

/**
 * Routes that require authentication.
 * Users visiting these routes without valid auth cookies
 * will be redirected to login (handled client-side).
 */
const PROTECTED_ROUTES = ['/account', '/account/billing', '/account/subscription'];

/**
 * Routes that should redirect to dashboard if already authenticated.
 * These are auth-related pages that don't make sense when logged in.
 */
const AUTH_ROUTES = ['/login', '/signup'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Add auth-related context for pages
  // The actual auth state is managed client-side with Supabase JS
  const isProtectedRoute = PROTECTED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
  const isAuthRoute = AUTH_ROUTES.includes(pathname);

  // Store route info in locals for pages to access
  context.locals.isProtectedRoute = isProtectedRoute;
  context.locals.isAuthRoute = isAuthRoute;

  // Continue to the next middleware or page
  const response = await next();

  // Add security headers for auth-related pages
  if (isProtectedRoute || isAuthRoute) {
    // Prevent caching of auth-related pages
    response.headers.set(
      'Cache-Control',
      'private, no-cache, no-store, must-revalidate'
    );
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Expires', '0');
  }

  return response;
});

// Type augmentation for Astro locals
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace App {
    interface Locals {
      isProtectedRoute: boolean;
      isAuthRoute: boolean;
    }
  }
}
