/**
 * Trust-tier badge class maps — single source of truth for how the 5-tier
 * public `ApiTrustTier` renders across the site.
 *
 * SMI-5217: the website rendering layer had drifted to the legacy 4-tier DB
 * vocabulary (`experimental`/`unknown`, missing `official`). The public API
 * (`skills-search` / `skills-get`) translates internal DB tiers to the public
 * set before serialization (SMI-5205): `experimental → community`,
 * `unknown → unverified`. So every website surface receives exactly the five
 * canonical tiers and never `experimental`/`unknown`.
 *
 * Colors mirror the canonical tier page `src/pages/docs/trust-tiers.astro`.
 * Keys are derived from the canonical `TRUST_TIERS` constant in `terminology.ts`
 * and pinned by `trust-tier-badges.test.ts`.
 */
import type { TrustTierId } from './terminology'

/** Full badge (rounded pill with border) — skills browse + detail pages. */
export const TRUST_TIER_BADGE_CLASSES: Record<TrustTierId, string> = {
  official: 'bg-green-500/10 text-green-400 border-green-500/20',
  verified: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  curated: 'bg-teal-500/10 text-teal-300 border-teal-500/20',
  community: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  unverified: 'bg-red-500/10 text-red-400 border-red-500/20',
}

/** Compact pill (no border) color fragment — related-skills + homepage variant. */
export const TRUST_TIER_PILL_CLASSES: Record<TrustTierId, string> = {
  official: 'bg-green-500/20 text-green-400',
  verified: 'bg-blue-500/20 text-blue-400',
  curated: 'bg-teal-500/20 text-teal-300',
  community: 'bg-yellow-500/20 text-yellow-400',
  unverified: 'bg-red-500/20 text-red-400',
}

/**
 * Lowest-trust public tier — the safe rendering fallback for any value the API
 * doesn't return (it never returns one today, but a graceful degrade beats a
 * blank/gray badge if the contract ever changes).
 */
export const DEFAULT_TRUST_TIER: TrustTierId = 'unverified'
