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
 *
 * PR #2375 review follow-up: the original version tracked by ORIGIN alone,
 * so any same-origin 429 — not just the page's own `/api/...` proxy calls —
 * would trigger this toast, and a `PUBLIC_API_BASE_URL` that happened to
 * share an origin with `PUBLIC_SUPABASE_URL` (a plausible staging
 * misconfiguration) would silently defeat the auth-origin exclusion above.
 * Each tracked entry now carries an optional `pathPrefix`: the page's own
 * origin is scoped to `/api/` (the proxy convention actually in use), and
 * the API-base origin is scoped to whatever pathname (if any) is already
 * part of the configured `PUBLIC_API_BASE_URL` — a bare-origin API base
 * (the common case, no meaningful pathname) still tracks any path there,
 * but a dedicated sub-path (e.g. a Supabase functions URL) narrows to it.
 */
export interface TrackedRateLimitOrigin {
  readonly origin: string
  /** When set, only request paths starting with this prefix are tracked at `origin`. Omitted = track any path (used for a dedicated API host with no meaningful base pathname). */
  readonly pathPrefix?: string
}

/** Resolves the set of (origin, path-scope) entries this toast should react to a 429 from. */
export function getTrackedRateLimitOrigins(
  apiBaseUrl: string,
  pageOrigin: string
): TrackedRateLimitOrigin[] {
  let apiUrl: URL | null = null
  try {
    apiUrl = new URL(apiBaseUrl)
  } catch {
    // apiBaseUrl malformed (shouldn't happen in practice — always a full
    // https:// URL) — fall back to same-origin-only (path-scoped) tracking
    // rather than throwing out of a fetch() interceptor.
  }

  const entries: TrackedRateLimitOrigin[] = []
  const seenOrigins = new Set<string>()

  if (apiUrl) {
    // A root/empty pathname means "no meaningful base path configured" —
    // track any path at this origin (the common case: a bare API host).
    // A non-root pathname narrows tracking to under it, so a same-origin
    // request outside the configured API base (e.g. an auth endpoint that
    // happens to share this origin) isn't swept in.
    entries.push(
      apiUrl.pathname === '/' || apiUrl.pathname === ''
        ? { origin: apiUrl.origin }
        : { origin: apiUrl.origin, pathPrefix: apiUrl.pathname }
    )
    seenOrigins.add(apiUrl.origin)
  }

  if (!seenOrigins.has(pageOrigin)) {
    entries.push({ origin: pageOrigin, pathPrefix: '/api/' })
  }

  return entries
}

/** Extracts the request URL from any of fetch()'s three accepted input shapes. */
export function extractRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** True if `requestUrl` (absolute or relative) resolves to one of `trackedOrigins`, respecting each entry's path scope. */
export function isTrackedRateLimitRequest(
  requestUrl: string,
  trackedOrigins: readonly TrackedRateLimitOrigin[],
  pageHref: string
): boolean {
  try {
    const url = new URL(requestUrl, pageHref)
    return trackedOrigins.some(({ origin, pathPrefix }) => {
      if (url.origin !== origin) return false
      return pathPrefix === undefined || url.pathname.startsWith(pathPrefix)
    })
  } catch {
    return false
  }
}
