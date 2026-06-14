import { describe, it, expect } from 'vitest'
import { TRUST_TIERS } from './terminology'
import {
  TRUST_TIER_BADGE_CLASSES,
  TRUST_TIER_PILL_CLASSES,
  DEFAULT_TRUST_TIER,
} from './trust-tier-badges'

/**
 * SMI-5217: guards the website rendering layer against re-drifting away from the
 * canonical 5-tier public vocabulary. The badge maps must cover exactly the
 * tiers declared in `TRUST_TIERS` (terminology.ts) — no more (no legacy
 * `experimental`/`unknown`) and no fewer (no missing `official`/`unverified`).
 */
const CANONICAL_TIER_IDS = Object.values(TRUST_TIERS)
  .map((t) => t.id)
  .sort()

describe('trust-tier badge maps', () => {
  it('canonical TRUST_TIERS is the 5-tier public set', () => {
    expect(CANONICAL_TIER_IDS).toEqual(
      ['official', 'verified', 'curated', 'community', 'unverified'].sort()
    )
  })

  it('full-badge map covers exactly the canonical tiers', () => {
    expect(Object.keys(TRUST_TIER_BADGE_CLASSES).sort()).toEqual(CANONICAL_TIER_IDS)
  })

  it('compact-pill map covers exactly the canonical tiers', () => {
    expect(Object.keys(TRUST_TIER_PILL_CLASSES).sort()).toEqual(CANONICAL_TIER_IDS)
  })

  it('carries no legacy DB-only tiers', () => {
    for (const legacy of ['experimental', 'unknown']) {
      expect(TRUST_TIER_BADGE_CLASSES).not.toHaveProperty(legacy)
      expect(TRUST_TIER_PILL_CLASSES).not.toHaveProperty(legacy)
    }
  })

  it('every tier maps to a non-empty class string', () => {
    for (const tier of CANONICAL_TIER_IDS) {
      expect(TRUST_TIER_BADGE_CLASSES[tier as keyof typeof TRUST_TIER_BADGE_CLASSES]).toBeTruthy()
      expect(TRUST_TIER_PILL_CLASSES[tier as keyof typeof TRUST_TIER_PILL_CLASSES]).toBeTruthy()
    }
  })

  it('default fallback tier is a canonical tier', () => {
    expect(CANONICAL_TIER_IDS).toContain(DEFAULT_TRUST_TIER)
  })
})
