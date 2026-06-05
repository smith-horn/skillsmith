/**
 * SMI-2402: Banded quality-score model — unit tests.
 * @module scripts/tests/indexer/quality-score.test
 *
 * Covers:
 *  - band math (`getTierBands` / `computeQualityScore`)
 *  - each intrinsic sub-signal of `computeIntrinsicQuality`
 *  - `computeStructureQuality` on a dispatcher vs a monolithic SKILL.md
 *  - the 0-star case is no longer pinned (within-tier spread exists)
 *  - the NULL-`source` legacy-row path (re-scored into the `unknown` band)
 *  - the `orgIsVerified` -> `curated` band-selection interaction
 *
 * Tests the Node tree; the Deno twin is byte-identical (parity.test.ts).
 */

import { describe, it, expect } from 'vitest'
import {
  getTierBands,
  computeQualityScore,
  computeIntrinsicQuality,
  computeStructureQuality,
  selectTrustTier,
  type TrustTier,
  type IntrinsicQualityMetadata,
} from '../../indexer/skill-processor.helpers.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'
import type { HighTrustAuthor } from '../../indexer/high-trust-authors.ts'

function makeRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    owner: 'someorg',
    name: 'somerepo',
    fullName: 'someorg/somerepo',
    description: null,
    url: 'https://github.com/someorg/somerepo',
    stars: 0,
    forks: 0,
    topics: [],
    updatedAt: '2026-01-01T00:00:00Z',
    defaultBranch: 'main',
    installable: true,
    repoName: 'somerepo',
    skillPath: '',
    license: 'MIT',
    ...overrides,
  }
}

describe('SMI-2402: getTierBands', () => {
  it('every band is non-overlapping and ordered highest-to-lowest', () => {
    const b = getTierBands()
    expect(b.verified).toEqual({ floor: 0.85, ceil: 1.0 })
    expect(b.curated).toEqual({ floor: 0.7, ceil: 0.85 })
    expect(b.community).toEqual({ floor: 0.5, ceil: 0.7 })
    expect(b.experimental).toEqual({ floor: 0.35, ceil: 0.5 })
    expect(b.unknown).toEqual({ floor: 0.2, ceil: 0.35 })
  })

  it('adjacent bands touch but never overlap (verified.floor == curated.ceil etc.)', () => {
    const b = getTierBands()
    expect(b.verified.floor).toBe(b.curated.ceil)
    expect(b.curated.floor).toBe(b.community.ceil)
    expect(b.community.floor).toBe(b.experimental.ceil)
    expect(b.experimental.floor).toBe(b.unknown.ceil)
  })
})

describe('SMI-2402: computeQualityScore band math', () => {
  const tiers: TrustTier[] = ['verified', 'curated', 'community', 'experimental', 'unknown']

  it('intrinsic 0 maps to the band floor for every tier', () => {
    const b = getTierBands()
    for (const t of tiers) {
      expect(computeQualityScore(t, 0)).toBeCloseTo(b[t].floor, 10)
    }
  })

  it('intrinsic 1 maps to the band ceil for every tier', () => {
    const b = getTierBands()
    for (const t of tiers) {
      expect(computeQualityScore(t, 1)).toBeCloseTo(b[t].ceil, 10)
    }
  })

  it('intrinsic 0.5 maps to the band midpoint', () => {
    expect(computeQualityScore('community', 0.5)).toBeCloseTo(0.6, 10)
    expect(computeQualityScore('verified', 0.5)).toBeCloseTo(0.925, 10)
  })

  it('cross-tier ordering is structurally guaranteed (a higher tier never scores below a lower one)', () => {
    // Worst-case higher tier (intrinsic 0) vs best-case lower tier (intrinsic 1).
    expect(computeQualityScore('verified', 0)).toBeGreaterThanOrEqual(
      computeQualityScore('curated', 1)
    )
    expect(computeQualityScore('curated', 0)).toBeGreaterThanOrEqual(
      computeQualityScore('community', 1)
    )
    expect(computeQualityScore('community', 0)).toBeGreaterThanOrEqual(
      computeQualityScore('experimental', 1)
    )
    expect(computeQualityScore('experimental', 0)).toBeGreaterThanOrEqual(
      computeQualityScore('unknown', 1)
    )
  })

  it('clamps an out-of-range intrinsic into the band', () => {
    expect(computeQualityScore('community', 5)).toBeCloseTo(0.7, 10)
    expect(computeQualityScore('community', -3)).toBeCloseTo(0.5, 10)
  })

  it('an unrecognized tier falls back to the unknown band', () => {
    expect(computeQualityScore('bogus' as TrustTier, 0)).toBeCloseTo(0.2, 10)
    expect(computeQualityScore('bogus' as TrustTier, 1)).toBeCloseTo(0.35, 10)
  })
})

describe('SMI-2402: computeIntrinsicQuality sub-signals', () => {
  it('descQuality (weight 0.25): a 160-char description maxes the component', () => {
    const meta: IntrinsicQualityMetadata = { description: 'x'.repeat(160) }
    // descQuality clamp(160/160)=1.0 -> 0.25.
    // frontmatterCompleteness counts the booleans present / 6: only descLong
    // is true (name/author/triggers/tags/category all absent) -> 1/6.
    const fmc = 1 / 6
    expect(computeIntrinsicQuality('', meta, makeRepo())).toBeCloseTo(0.25 * 1 + 0.25 * fmc, 6)
  })

  it('descQuality: a missing description is treated as empty string (component 0)', () => {
    // repo.description is null, metadata has no description -> descQuality 0.
    // No frontmatter fields are present at all -> frontmatterCompleteness 0.
    expect(computeIntrinsicQuality(undefined, undefined, makeRepo())).toBeCloseTo(0, 6)
  })

  it('descQuality: falls back to repo.description when metadata has none', () => {
    const repo = makeRepo({ description: 'y'.repeat(80) })
    // descQuality clamp(80/160)=0.5. frontmatterCompleteness: descLong true
    // (80 >= 20), nothing else -> 1/6.
    const fmc = 1 / 6
    expect(computeIntrinsicQuality(undefined, undefined, repo)).toBeCloseTo(
      0.25 * 0.5 + 0.25 * fmc,
      6
    )
  })

  it('frontmatterCompleteness (weight 0.25): all 6 fields present -> component 1.0', () => {
    const meta: IntrinsicQualityMetadata = {
      name: 'my-skill',
      description: 'a sufficiently long description over twenty chars',
      author: 'someone',
      triggers: ['do the thing'],
      frontmatterTags: ['tag-a'],
      frontmatterCategory: 'utilities',
    }
    const intrinsic = computeIntrinsicQuality('', meta, makeRepo())
    // descQuality clamp(49/160) + fmc 1.0*0.25 + triggers clamp(1/5)*0.2
    const descLen = meta.description!.length
    const expected = 0.25 * (descLen / 160) + 0.25 * 1 + 0.2 * (1 / 5) + 0.2 * 0 + 0.1 * 0
    expect(intrinsic).toBeCloseTo(expected, 6)
  })

  it('frontmatterCompleteness: a short description (<20 chars) does not count toward descLong', () => {
    const meta: IntrinsicQualityMetadata = { name: 'n', description: 'short' }
    // frontmatterCompleteness counts true booleans / 6: name present (1),
    // descLong false (5 < 20), author/triggers/tags/category absent -> 1/6.
    const fmc = 1 / 6
    const intrinsic = computeIntrinsicQuality('', meta, makeRepo())
    expect(intrinsic).toBeCloseTo(0.25 * (5 / 160) + 0.25 * fmc, 6)
  })

  it('triggerPhrases (weight 0.20): clamps at 5 triggers', () => {
    const five: IntrinsicQualityMetadata = {
      triggers: ['a', 'b', 'c', 'd', 'e'],
    }
    const ten: IntrinsicQualityMetadata = {
      triggers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    }
    // Only the trigger component differs; both have triggers>=1 so fmc is equal.
    expect(computeIntrinsicQuality('', five, makeRepo())).toBeCloseTo(
      computeIntrinsicQuality('', ten, makeRepo()),
      6
    )
  })

  it('popularity (weight 0.10): log-scaled, 1000 stars yields a full component', () => {
    const repo = makeRepo({ stars: 1000 }) // log10(1001)/3 ~= 1.0004 -> clamp 1
    // repo.description is null and metadata is undefined: descQuality 0,
    // frontmatterCompleteness 0, triggers 0, structure 0. Only popularity fires.
    const intrinsic = computeIntrinsicQuality('', undefined, repo)
    expect(intrinsic).toBeCloseTo(0.1 * 1, 6)
  })

  it('popularity: a 0-star skill is no longer pinned — descQuality/structure still spread it', () => {
    const lowRepo = makeRepo({ stars: 0, description: 'short desc here ok' })
    const highRepo = makeRepo({ stars: 0, description: 'x'.repeat(160) })
    const low = computeIntrinsicQuality('## a\n## b\n## c', undefined, lowRepo)
    const high = computeIntrinsicQuality(
      '## a\n## b\n## c\n```ts\n1\n```\n[d](./d.md)',
      undefined,
      highRepo
    )
    expect(high).toBeGreaterThan(low)
    expect(low).not.toBe(high)
  })

  it('popularity: a negative star count is clamped to 0 before log10 (no NaN)', () => {
    const repo = makeRepo({ stars: -5 })
    const intrinsic = computeIntrinsicQuality('', undefined, repo)
    expect(Number.isFinite(intrinsic)).toBe(true)
    expect(intrinsic).toBeGreaterThanOrEqual(0)
  })

  it('the result is always within [0, 1]', () => {
    const maxed: IntrinsicQualityMetadata = {
      name: 'n',
      description: 'z'.repeat(500),
      author: 'a',
      triggers: ['a', 'b', 'c', 'd', 'e', 'f'],
      frontmatterTags: ['t'],
      frontmatterCategory: 'c',
    }
    const intrinsic = computeIntrinsicQuality(
      '## a\n## b\n## c\n```ts\n1\n```\n[x](./x.md)',
      maxed,
      makeRepo({ stars: 100000 })
    )
    expect(intrinsic).toBeGreaterThanOrEqual(0)
    expect(intrinsic).toBeLessThanOrEqual(1)
  })
})

describe('SMI-2402: computeStructureQuality (dispatcher vs monolithic)', () => {
  it('empty/undefined content yields 0', () => {
    expect(computeStructureQuality(undefined)).toBe(0)
    expect(computeStructureQuality('')).toBe(0)
    expect(computeStructureQuality('   \n  ')).toBe(0)
  })

  it('a thin-dispatcher SKILL.md scores 1.0 (headings + example + .md refs)', () => {
    const dispatcher = [
      '# My Skill',
      '## Overview',
      '## Usage',
      '## Reference',
      'See [the guide](./guide.md) and [api](./api.md).',
      '```bash',
      'echo hi',
      '```',
    ].join('\n')
    expect(computeStructureQuality(dispatcher)).toBeCloseTo(1, 10)
  })

  it('a monolithic SKILL.md with no fenced code and no .md refs scores lower', () => {
    const monolithic = [
      '# My Skill',
      '## Overview',
      '## Usage',
      '## Reference',
      'This skill does a thing. No code blocks, no sibling-doc links.',
    ].join('\n')
    // headings yes (3+), example no, dispatcherRefs no -> 1/3
    expect(computeStructureQuality(monolithic)).toBeCloseTo(1 / 3, 10)
  })

  it('does NOT over-count `###` lines inside fenced code blocks', () => {
    // Only ONE real heading; the rest are inside a code fence.
    const tricky = [
      '## Real Heading',
      '```md',
      '### fake heading one',
      '### fake heading two',
      '### fake heading three',
      '```',
    ].join('\n')
    // 1 real heading < 3 -> hasHeadings 0; has a fenced block -> hasExample 1.
    expect(computeStructureQuality(tricky)).toBeCloseTo(1 / 3, 10)
  })

  it('treats any in-text relative `.md` link as a dispatcher signal (benign noise accepted)', () => {
    const withChangelogLink = '# S\nsome prose [changelog](./CHANGELOG.md) here'
    // no 3 headings, no code fence, but dispatcherRefs yes -> 1/3
    expect(computeStructureQuality(withChangelogLink)).toBeCloseTo(1 / 3, 10)
  })
})

describe('SMI-2402: selectTrustTier — band selection', () => {
  it('highTrustAuthor selects its trustTier (default verified)', () => {
    const author: HighTrustAuthor = {
      owner: 'anthropics',
      repo: 'skills',
      license: 'MIT',
      baseQualityScore: 0.95,
    }
    expect(selectTrustTier(makeRepo(), author)).toBe('verified')
  })

  it('highTrustAuthor with explicit curated trustTier selects curated', () => {
    const author: HighTrustAuthor = {
      owner: 'mattpocock',
      repo: 'skills',
      license: 'MIT',
      baseQualityScore: 0.9,
      trustTier: 'curated',
    }
    expect(selectTrustTier(makeRepo(), author, true)).toBe('curated')
  })

  it('claude-code-official topic selects verified', () => {
    expect(selectTrustTier(makeRepo({ topics: ['claude-code-official'] }))).toBe('verified')
  })

  it('orgIsVerified=true selects the curated band', () => {
    expect(selectTrustTier(makeRepo({ stars: 0 }), undefined, true)).toBe('curated')
  })

  it('claude-code-official topic wins over orgIsVerified=true', () => {
    const repo = makeRepo({ topics: ['claude-code-official'], stars: 100 })
    expect(selectTrustTier(repo, undefined, true)).toBe('verified')
  })

  it('stars heuristic: >=50 community, >=5 experimental, else unknown', () => {
    expect(selectTrustTier(makeRepo({ stars: 50 }))).toBe('community')
    expect(selectTrustTier(makeRepo({ stars: 5 }))).toBe('experimental')
    expect(selectTrustTier(makeRepo({ stars: 0 }))).toBe('unknown')
  })
})

describe('SMI-2402: orgIsVerified -> curated band interaction (end-to-end)', () => {
  it('a 0-star verified vendor org lands inside the curated band [0.70, 0.85]', () => {
    const repo = makeRepo({ owner: 'zapier', stars: 0 })
    const tier = selectTrustTier(repo, undefined, true)
    const score = computeQualityScore(tier, computeIntrinsicQuality(undefined, undefined, repo))
    expect(tier).toBe('curated')
    expect(score).toBeGreaterThanOrEqual(0.7)
    expect(score).toBeLessThanOrEqual(0.85)
  })

  it('a 0-star verified vendor still outranks any community skill (band guarantee)', () => {
    const vendor = makeRepo({ owner: 'zapier', stars: 0 })
    const community = makeRepo({ owner: 'popular', stars: 5000, description: 'x'.repeat(160) })
    const vendorScore = computeQualityScore(
      selectTrustTier(vendor, undefined, true),
      computeIntrinsicQuality(undefined, undefined, vendor)
    )
    const communityScore = computeQualityScore(
      selectTrustTier(community),
      computeIntrinsicQuality('## a\n## b\n## c\n```\n1\n```', undefined, community)
    )
    expect(vendorScore).toBeGreaterThanOrEqual(communityScore)
  })
})

describe('SMI-2402: NULL-source legacy-row path', () => {
  /**
   * Legacy seed rows have a NULL `source` column and were pinned near
   * 0.99/1.00 by the old model. The SQL backfill re-scores them by their
   * existing `trust_tier` (or `unknown` if NULL). The code path here mirrors
   * that: `source` is not an input to the scoring formula at all — only
   * `trust_tier` selects the band — so a NULL-`source` row scores exactly
   * like any other row of the same tier.
   */
  it('source is not a scoring input — a NULL-source row scores by its trust_tier band', () => {
    // A legacy unknown-tier row: it must now sit in [0.20, 0.35], NOT ~1.0.
    const score = computeQualityScore(
      'unknown',
      computeIntrinsicQuality(undefined, undefined, makeRepo())
    )
    expect(score).toBeGreaterThanOrEqual(0.2)
    expect(score).toBeLessThanOrEqual(0.35)
  })

  it('a NULL trust_tier legacy row resolves to the unknown band via the fallback', () => {
    // computeQualityScore with an unrecognized/missing tier falls back to unknown.
    const score = computeQualityScore(undefined as unknown as TrustTier, 0.5)
    expect(score).toBeGreaterThanOrEqual(0.2)
    expect(score).toBeLessThanOrEqual(0.35)
    expect(score).toBeCloseTo(0.275, 10)
  })
})
