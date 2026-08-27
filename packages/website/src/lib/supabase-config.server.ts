/**
 * Server-only Supabase/Skillsmith API accessors (SMI-6190).
 *
 * Deliberately NOT part of `supabase-config.ts` — that module is a shared,
 * general-purpose config accessor a future client-side import could pull in
 * without anyone noticing the boundary was crossed. Only `PUBLIC_API_BASE_URL`
 * is exposed to the client bundle today (see `astro.config.mjs`'s
 * `vite.define` block), so "avoid the `PUBLIC_` prefix" is *currently*
 * sufficient — but putting this accessor in its own `.server.ts`-suffixed
 * file makes the server-only boundary an explicit, greppable convention
 * rather than an implicit property of the current bundler config. A build-time
 * scan (see the build-artifact check under `scripts/`) backs this convention
 * with a concrete assertion that neither the env var name nor the `sk_live_`
 * key shape ever reaches the client-shipped bundle.
 */

/**
 * Returns the dedicated internal API key used to authenticate the website's
 * own server-side (SSR) fetches to Skillsmith's API — `[id].astro`'s
 * skill-detail and category-page fetches — instead of the shared public
 * anon key, which shares a single per-endpoint rate bucket with every other
 * anonymous caller (see SMI-6190 for the full investigation).
 *
 * Returns `''` when the secret is unset (local dev, or before the real key
 * is provisioned) rather than throwing — callers degrade gracefully to the
 * existing trial-limiter fallback path exactly like any other failed/absent
 * auth, rather than crashing the SSR render.
 */
export function getWebsiteSsrApiKey(): string {
  return import.meta.env.SKILLSMITH_WEBSITE_SSR_API_KEY || ''
}
