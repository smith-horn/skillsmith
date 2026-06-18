/**
 * Unit tests for installUtils.getTrustBadge (SMI-5290).
 * The shields.io markdown badge vocabulary must mirror the canonical 5-tier
 * model (ApiTrustTier); legacy/unrecognized tiers normalize to Unverified.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('vscode', () => ({
  ThemeIcon: class {
    constructor(
      public id: string,
      public color?: unknown
    ) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
}))

import { getTrustBadge } from '../services/installUtils.js'

describe('getTrustBadge', () => {
  it('renders each canonical tier with its label + color', () => {
    expect(getTrustBadge('official')).toBe(
      '![Official](https://img.shields.io/badge/Trust-Official-brightgreen)'
    )
    expect(getTrustBadge('verified')).toBe(
      '![Verified](https://img.shields.io/badge/Trust-Verified-blue)'
    )
    expect(getTrustBadge('curated')).toBe(
      '![Curated](https://img.shields.io/badge/Trust-Curated-008080)'
    )
    expect(getTrustBadge('community')).toBe(
      '![Community](https://img.shields.io/badge/Trust-Community-yellow)'
    )
    expect(getTrustBadge('unverified')).toBe(
      '![Unverified](https://img.shields.io/badge/Trust-Unverified-lightgrey)'
    )
  })

  it('normalizes legacy/bogus tiers (no more "Standard")', () => {
    // standard/default were bogus SkillSearchProvider inventions → Unverified
    expect(getTrustBadge('standard')).toBe(
      '![Unverified](https://img.shields.io/badge/Trust-Unverified-lightgrey)'
    )
    expect(getTrustBadge('default')).toBe(
      '![Unverified](https://img.shields.io/badge/Trust-Unverified-lightgrey)'
    )
    // experimental is translated server-side to community
    expect(getTrustBadge('experimental')).toBe(
      '![Community](https://img.shields.io/badge/Trust-Community-yellow)'
    )
    // unknown → unverified
    expect(getTrustBadge('unknown')).toBe(
      '![Unverified](https://img.shields.io/badge/Trust-Unverified-lightgrey)'
    )
  })
})
