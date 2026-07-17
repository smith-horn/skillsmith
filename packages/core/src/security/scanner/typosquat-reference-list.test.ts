/**
 * SMI-595 §2: typosquat-reference-list.ts — reference-list builder tests.
 */

import { describe, it, expect } from 'vitest'
import {
  buildTyposquatReferenceList,
  DEFAULT_TOP_INSTALLED_LIMIT,
} from './typosquat-reference-list.js'
import { BRAND_ALIASES } from './typosquat.js'

describe('buildTyposquatReferenceList (SMI-595 §2)', () => {
  it('folds in HIGH_TRUST_OWNERS-published skill names, lowercased', () => {
    const list = buildTyposquatReferenceList({
      highTrustOwnerSkills: [{ author: 'anthropics', name: 'Claude-Helper' }],
    })
    expect(list.has('claude-helper')).toBe(true)
  })

  it('folds in the top-N installed skills by install count', () => {
    const list = buildTyposquatReferenceList({
      installedSkills: [
        { author: 'a', name: 'popular-skill', installCount: 1000 },
        { author: 'b', name: 'niche-skill', installCount: 1 },
      ],
      topInstalledLimit: 1,
    })
    expect(list.has('popular-skill')).toBe(true)
    expect(list.has('niche-skill')).toBe(false) // cut off by the limit
  })

  it('respects the default top-N limit of 200', () => {
    expect(DEFAULT_TOP_INSTALLED_LIMIT).toBe(200)
    const installedSkills = Array.from({ length: 250 }, (_, i) => ({
      author: 'a',
      name: `skill-${i}`,
      installCount: 250 - i, // skill-0 has the highest count
    }))
    const list = buildTyposquatReferenceList({ installedSkills })
    expect(list.has('skill-0')).toBe(true) // rank 1, well within top 200
    expect(list.has('skill-249')).toBe(false) // rank 250, cut off
  })

  it('always includes the BRAND_ALIASES keys, even with no other sources', () => {
    const list = buildTyposquatReferenceList()
    for (const brand of Object.keys(BRAND_ALIASES)) {
      expect(list.has(brand)).toBe(true)
    }
  })

  it('deduplicates a name that appears in both sources', () => {
    const list = buildTyposquatReferenceList({
      highTrustOwnerSkills: [{ author: 'anthropics', name: 'shared-skill' }],
      installedSkills: [{ author: 'anthropics', name: 'shared-skill', installCount: 5 }],
    })
    // A Set naturally dedupes; just confirm the entry is present exactly once
    // (Set semantics already guarantee this, this is a readability check).
    expect([...list].filter((n) => n === 'shared-skill')).toHaveLength(1)
  })
})
