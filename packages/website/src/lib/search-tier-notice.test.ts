import { describe, it, expect } from 'vitest'
import { tierNotSearchableNotice, TIER_NOT_SEARCHABLE_REASON } from './search-tier-notice'
import { TRUST_TIER_ORDER } from '../constants/terminology'

// The body skills-search sends for a query plus trust_tier=unverified (SMI-7236).
const DECLINED = {
  error:
    'Full-text search covers tiered skills only; trust_tier=unverified can be browsed without a query',
  details: { parameter: 'trust_tier', received: 'unverified', reason: TIER_NOT_SEARCHABLE_REASON },
}

describe('tierNotSearchableNotice (SMI-7246)', () => {
  it('explains the declined search and points to browsing without a query', () => {
    const notice = tierNotSearchableNotice(400, DECLINED)
    expect(notice).not.toBeNull()
    expect(notice?.message).toMatch(/clear the search box/i)
    expect(notice?.message).toMatch(/Unverified filter/)
  })

  // PR #3269 gate (PR-16): pin the coverage claim, not just the call to action.
  // The website shows the five public tiers; the edge relabels experimental as
  // community, so "every public tier except unverified" is exactly the set
  // full-text search covers (SMI-7236).
  it('names every searchable public tier, and not unverified, in the coverage sentence', () => {
    const notice = tierNotSearchableNotice(400, DECLINED)
    const coverage = (notice?.message ?? '').split('. ')[0].toLowerCase()
    expect(coverage).toMatch(/^text search covers /)
    const searchable = TRUST_TIER_ORDER.filter((t) => t.id !== 'unverified')
    expect(searchable.length).toBe(TRUST_TIER_ORDER.length - 1)
    for (const tier of searchable) expect(coverage).toContain(tier.id)
    expect(coverage).not.toContain('unverified')
  })

  it('stays null for any other 400, so real errors keep the generic path', () => {
    expect(
      tierNotSearchableNotice(400, { error: 'Invalid trust_tier', details: { allowed: [] } })
    ).toBeNull()
    expect(tierNotSearchableNotice(400, { error: 'Bad request' })).toBeNull()
    expect(tierNotSearchableNotice(400, { details: { reason: 'something_else' } })).toBeNull()
  })

  it('stays null when the status is not 400, even with the reason present', () => {
    expect(tierNotSearchableNotice(500, DECLINED)).toBeNull()
    expect(tierNotSearchableNotice(200, DECLINED)).toBeNull()
  })

  it('stays null for a body that is not an object', () => {
    expect(tierNotSearchableNotice(400, null)).toBeNull()
    expect(tierNotSearchableNotice(400, 'tier_not_searchable')).toBeNull()
    expect(tierNotSearchableNotice(400, { details: 'tier_not_searchable' })).toBeNull()
  })
})
