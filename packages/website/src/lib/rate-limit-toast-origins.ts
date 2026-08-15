/**
 * SMI-5893 Wave 6 Step 4: origin allowlist for the site-wide 429 toast.
 *
 * RateLimitToast.astro's `window.fetch` interceptor previously fired on ANY
 * 429 response from ANY origin — including unrelated Supabase auth/session
 * calls made via getSupabaseClient() (packages/website/src/lib/supabase-client.ts)
 * from Nav.astro and the auth pages. This module scopes it down to the
 * Skillsmith API surfaces the site's own client code actually calls:
 *
 *   - The resolved `PUBLIC_API_BASE_URL` origin. Defaults to
 *     `https://api.skillsmith.app` (prod) — the same origin
 *     packages/website/src/lib/api.ts and pages/skills/index.astro already
 *     use for their own skills-search / stats client-side fetch calls. Any
 *     staging deploy overrides `PUBLIC_API_BASE_URL` at build time (Vite
 *     `define`, astro.config.mjs) to point elsewhere — reusing that same env
 *     var here (rather than hardcoding a second copy of "the API origin")
 *     means a configured staging origin is picked up automatically.
 *   - The page's own same-origin `/api/...` proxy paths (e.g.
 *     `/api/skills-search`, pages/api/skills-search.ts).
 *
 * Deliberately EXCLUDES `PUBLIC_SUPABASE_URL` (the raw `*.supabase.co` auth
 * origin used by getSupabaseClient()) — an auth/session 429 is not a
 * Skillsmith-API rate limit and must not trigger this toast.
 */

/** Resolves the set of origins this toast should react to a 429 from. */
export function getTrackedRateLimitOrigins(apiBaseUrl: string, pageOrigin: string): string[] {
  const origins = new Set<string>([pageOrigin])
  try {
    origins.add(new URL(apiBaseUrl).origin)
  } catch {
    // apiBaseUrl malformed (shouldn't happen in practice — always a full
    // https:// URL) — fall back to same-origin-only tracking rather than
    // throwing out of a fetch() interceptor.
  }
  return [...origins]
}

/** Extracts the request URL from any of fetch()'s three accepted input shapes. */
export function extractRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** True if `requestUrl` (absolute or relative) resolves to one of `trackedOrigins`. */
export function isTrackedRateLimitRequest(
  requestUrl: string,
  trackedOrigins: readonly string[],
  pageHref: string
): boolean {
  try {
    const origin = new URL(requestUrl, pageHref).origin
    return trackedOrigins.includes(origin)
  } catch {
    return false
  }
}
