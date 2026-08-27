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
import { getSupabaseConfig } from './supabase-config'

/**
 * Returns the dedicated internal API key used to authenticate the website's
 * own server-side (SSR) fetches to Skillsmith's API — `[id].astro`'s
 * skill-detail and category-page fetches — instead of the shared public
 * anon key, which shares a single per-endpoint rate bucket with every other
 * anonymous caller (see SMI-6190 for the full investigation).
 *
 * Falls back to the anon key when the dedicated secret is unset (local dev,
 * or the window between this code deploying and the real credential being
 * provisioned) rather than an empty string. This matters: an empty bearer
 * token doesn't match the anon key's exact-string check
 * (`isSupabaseAnonKey()`, `api-key-auth.ts`), so it would fall all the way
 * through `runAuthMiddleware()` to the unauthenticated trial limiter — a
 * 10-requests-TOTAL-EVER cap, confirmed already exhausted in prod, which is
 * far stricter than the anon-key bucket this credential replaces. Live
 * verification during rollout caught this: post-merge, every SSR render
 * sitewide was silently spending down Vercel's own egress-IP trial budget
 * toward zero, which would have made every skill/category page's degraded
 * state permanent (no time-window reset) instead of the pre-existing
 * partial-degrade-under-anon-bucket-pressure behavior. Falling back to the
 * anon key preserves the exact pre-SMI-6190 behavior until the dedicated key
 * exists, then silently and correctly switches over once it's provisioned —
 * no redeploy needed, no window where behavior is worse than before this
 * feature shipped.
 */
export function getWebsiteSsrApiKey(): string {
  return import.meta.env.SKILLSMITH_WEBSITE_SSR_API_KEY || getSupabaseConfig().anonKey
}
