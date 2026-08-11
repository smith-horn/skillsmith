/**
 * SMI-5178/SMI-5929: unit tests for the pure search compatibility helpers.
 * No DB / context — fast, isolated from the seeded better-sqlite3 fixtures.
 */

import { describe, it, expect } from 'vitest'
import { type SkillSearchResult, type SearchResult, type Skill } from '@skillsmith/core'
import {
  compatibilityWantedSlugs,
  computeCompatRank,
  sortByCompatRank,
  countCompatDeprioritized,
  mergeRankAndPage,
  filterInstallable,
  resolveDefaultCompatibility,
  buildEmptySearchSuggestion,
  mapLocalSkillToSearchResult,
  computeLocalCompatFetchLimit,
} from './search.helpers.js'

function skill(id: string, compatibility?: string[], installable?: boolean): SkillSearchResult {
  return {
    id,
    name: id,
    description: '',
    author: 'test',
    category: 'development',
    trustTier: 'community',
    score: 50,
    ...(compatibility !== undefined ? { compatibility } : {}),
    ...(installable !== undefined ? { installable } : {}),
  }
}

describe('compatibilityWantedSlugs (SMI-5929)', () => {
  it('unions ides + llms, deduped', () => {
    const set = compatibilityWantedSlugs({ ides: ['cursor', 'windsurf'], llms: ['cursor'] })
    expect([...set].sort()).toEqual(['cursor', 'windsurf'])
  })

  it('is empty for undefined / {}', () => {
    expect(compatibilityWantedSlugs(undefined).size).toBe(0)
    expect(compatibilityWantedSlugs({}).size).toBe(0)
  })
})

describe('computeCompatRank (SMI-5929)', () => {
  const wanted = new Set(['windsurf'])

  it('rank 0: declares a requested slug', () => {
    expect(computeCompatRank(['windsurf'], wanted)).toBe(0)
    expect(computeCompatRank(['claude-code', 'windsurf'], wanted)).toBe(0)
  })

  it('rank 1: empty/absent — unscoped, unknown ≠ incompatible', () => {
    expect(computeCompatRank([], wanted)).toBe(1)
    expect(computeCompatRank(undefined, wanted)).toBe(1)
  })

  it('rank 2: declares only OTHER slugs', () => {
    expect(computeCompatRank(['claude-code'], wanted)).toBe(2)
  })

  it('an empty wanted set always ranks 1 (no filter active)', () => {
    expect(computeCompatRank(['claude-code'], new Set())).toBe(1)
  })
})

describe('sortByCompatRank (SMI-5929)', () => {
  it('orders rank 0 before rank 1 before rank 2, never dropping a row', () => {
    const rows = [skill('other', ['claude-code']), skill('empty', []), skill('a', ['windsurf'])]
    const out = sortByCompatRank(rows, { ides: ['windsurf'] })
    expect(out.map((r) => r.id)).toEqual(['a', 'empty', 'other'])
  })

  it('is a no-op when the filter has no wanted slugs', () => {
    const rows = [skill('a', ['windsurf']), skill('b', ['claude-code'])]
    expect(sortByCompatRank(rows, {})).toBe(rows)
    expect(sortByCompatRank(rows, undefined)).toBe(rows)
  })

  it('is a stable sort — preserves relative order within each rank', () => {
    const rows = [
      skill('rank2-first', ['claude-code']),
      skill('rank0-first', ['windsurf']),
      skill('rank2-second', ['copilot']),
      skill('rank0-second', ['windsurf', 'copilot']),
    ]
    const out = sortByCompatRank(rows, { ides: ['windsurf'] })
    expect(out.map((r) => r.id)).toEqual([
      'rank0-first',
      'rank0-second',
      'rank2-first',
      'rank2-second',
    ])
  })
})

describe('countCompatDeprioritized (SMI-5929)', () => {
  it('counts only rank-2 rows in the given (post-slice) array', () => {
    const rows = [skill('rank0', ['windsurf']), skill('rank1', []), skill('rank2', ['copilot'])]
    expect(countCompatDeprioritized(rows, { ides: ['windsurf'] })).toBe(1)
  })

  it('is 0 when the filter has no wanted slugs', () => {
    expect(countCompatDeprioritized([skill('a', ['copilot'])], {})).toBe(0)
  })

  it('reflects only what was passed in — the field it backs is page-scoped, not corpus-wide', () => {
    const wide = sortByCompatRank(
      [skill('rank0', ['windsurf']), skill('rank2-a', ['copilot']), skill('rank2-b', ['gemini'])],
      { ides: ['windsurf'] }
    )
    const finalPage = wide.slice(0, 2) // rank0 + one rank2
    expect(countCompatDeprioritized(finalPage, { ides: ['windsurf'] })).toBe(1)
    expect(countCompatDeprioritized(wide, { ides: ['windsurf'] })).toBe(2)
  })
})

describe('mergeRankAndPage (SMI-5929)', () => {
  it('local-first stays the OUTER key — an API rank-0 result never outranks a local row', () => {
    const localOther = skill('local-other', ['copilot']) // rank 2 vs cursor
    const apiMatch = skill('api-match', ['cursor']) // rank 0 vs cursor
    const out = mergeRankAndPage({
      localResults: [localOther],
      apiResults: [apiMatch],
      compatibleWith: { ides: ['cursor'] },
      installableOnly: false,
      limit: 10,
    })
    // local-other (rank 2, but LOCAL) must still precede api-match (rank 0, API).
    expect(out.pageResults.map((r) => r.id)).toEqual(['local-other', 'api-match'])
  })

  it('compat-rank reorders WITHIN each bucket separately', () => {
    const out = mergeRankAndPage({
      localResults: [skill('local-other', ['copilot']), skill('local-match', ['cursor'])],
      apiResults: [skill('api-other', ['copilot']), skill('api-match', ['cursor'])],
      compatibleWith: { ides: ['cursor'] },
      installableOnly: false,
      limit: 10,
    })
    expect(out.pageResults.map((r) => r.id)).toEqual([
      'local-match',
      'local-other',
      'api-match',
      'api-other',
    ])
  })

  it('never drops a rank-2 row — it is present, just deprioritized', () => {
    const out = mergeRankAndPage({
      localResults: [],
      apiResults: [skill('other-only', ['copilot'])],
      compatibleWith: { ides: ['cursor'] },
      installableOnly: false,
      limit: 10,
    })
    expect(out.pageResults.map((r) => r.id)).toEqual(['other-only'])
    expect(out.compatibilityDeprioritized).toBe(1)
  })

  it('compatibilityDeprioritized counts only rank-2 rows on the FINAL sliced page', () => {
    const out = mergeRankAndPage({
      localResults: [],
      apiResults: [
        skill('rank0', ['cursor']),
        skill('rank2-a', ['copilot']),
        skill('rank2-b', ['gemini']),
      ],
      compatibleWith: { ides: ['cursor'] },
      installableOnly: false,
      limit: 2, // only room for rank0 + one rank2
    })
    expect(out.pageResults).toHaveLength(2)
    expect(out.compatibilityDeprioritized).toBe(1)
  })

  it('applies the installable filter and reports discoveryOnlyHidden', () => {
    const out = mergeRankAndPage({
      localResults: [],
      apiResults: [skill('keep', undefined, true), skill('drop', undefined, false)],
      compatibleWith: undefined,
      installableOnly: true,
      limit: 10,
    })
    expect(out.pageResults.map((r) => r.id)).toEqual(['keep'])
    expect(out.discoveryOnlyHidden).toBe(1)
    expect(out.mergedTotal).toBe(1)
  })
})

describe('filterInstallable (SMI-5178 regression guard)', () => {
  it('drops discovery-only rows only when installable_only is true', () => {
    const rows = [skill('a', undefined, true), skill('b', undefined, false)]
    expect(filterInstallable(rows, true).map((r) => r.id)).toEqual(['a'])
    expect(filterInstallable(rows, false)).toHaveLength(2)
    expect(filterInstallable(rows, undefined)).toHaveLength(2)
  })

  it('(C3) keeps a row with installable: null — null means unknown, not discovery-only', () => {
    // `installable` is a stored column frequently null for rows that DO have a repo_url.
    // Only explicit `false` marks a discovery-only entry.
    const rows = [skill('null-row'), skill('false-row', undefined, false)]
    // null-row has no installable key at all (undefined) — treated as installable.
    expect(filterInstallable(rows, true).map((r) => r.id)).toEqual(['null-row'])
  })

  it('(C3) drops a row with installable: false, keeps installable: true and absent', () => {
    const rows = [
      skill('true-row', undefined, true),
      skill('false-row', undefined, false),
      skill('absent-row'), // no installable key
    ]
    const out = filterInstallable(rows, true).map((r) => r.id)
    expect(out).toContain('true-row')
    expect(out).toContain('absent-row')
    expect(out).not.toContain('false-row')
  })
})

describe('resolveDefaultCompatibility (SMI-5178)', () => {
  it('returns undefined for an unset / empty client (permissive)', () => {
    expect(resolveDefaultCompatibility(undefined)).toBeUndefined()
    expect(resolveDefaultCompatibility('')).toBeUndefined()
    expect(resolveDefaultCompatibility('   ')).toBeUndefined()
  })

  it('maps a known client to its compatibility slug', () => {
    expect(resolveDefaultCompatibility('windsurf')).toEqual({ ides: ['windsurf'] })
    expect(resolveDefaultCompatibility('claude-code')).toEqual({ ides: ['claude-code'] })
  })

  it('maps the agents (Codex) client to the codex slug', () => {
    expect(resolveDefaultCompatibility('agents')).toEqual({ ides: ['codex'] })
  })

  it('returns undefined for an unknown client (no silent mis-restriction)', () => {
    expect(resolveDefaultCompatibility('emacs')).toBeUndefined()
  })
})

function localSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'local-1',
    name: 'local-skill',
    description: 'A local skill',
    author: 'tester',
    repoUrl: null,
    qualityScore: 0.5,
    trustTier: 'local',
    tags: [],
    installable: false,
    riskScore: null,
    securityFindingsCount: 0,
    securityScannedAt: null,
    securityPassed: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('mapLocalSkillToSearchResult (SMI-5897 Wave 4 fix)', () => {
  it('returns security: undefined for a never-scanned local skill (regression guard)', () => {
    // Pre-fix this built { passed: null, riskScore: null, findingsCount: 0,
    // scannedAt: null } unconditionally — a placeholder object that narrates
    // as "scanned, no verdict yet" for a skill that was NEVER scanned.
    const result: SearchResult = {
      skill: localSkill({ securityScannedAt: null }),
      rank: 0,
      highlights: {},
    }
    const mapped = mapLocalSkillToSearchResult(result)
    expect(mapped.security).toBeUndefined()
  })

  it('returns a real security summary when the local skill has been scanned', () => {
    const result: SearchResult = {
      skill: localSkill({
        securityScannedAt: '2026-06-01T00:00:00.000Z',
        securityPassed: true,
        riskScore: 5,
        securityFindingsCount: 0,
      }),
      rank: 0,
      highlights: {},
    }
    const mapped = mapLocalSkillToSearchResult(result)
    expect(mapped.security).toEqual({
      passed: true,
      riskScore: 5,
      findingsCount: 0,
      scannedAt: '2026-06-01T00:00:00.000Z',
    })
  })
})

describe('buildEmptySearchSuggestion (SMI-5556)', () => {
  it('explains lexical-only matching and single-topic guidance with no hidden counts', () => {
    const out = buildEmptySearchSuggestion({})
    expect(out).toContain('keyword-based (not semantic)')
    expect(out).toContain('single-topic query')
    expect(out).not.toContain('discovery-only')
    expect(out).not.toContain('compatibility filter')
  })

  it('mentions installable_only: false only when discoveryOnlyHidden > 0', () => {
    const out = buildEmptySearchSuggestion({ discoveryOnlyHidden: 3 })
    expect(out).toContain('3 discovery-only result(s)')
    expect(out).toContain('installable_only: false')
  })

  it('omits the discovery-only hint when discoveryOnlyHidden is 0', () => {
    const out = buildEmptySearchSuggestion({ discoveryOnlyHidden: 0 })
    expect(out).not.toContain('discovery-only')
  })

  // SMI-5929: no compatibility-filter hint here anymore — the compatibility
  // filter is a RANKING signal, not an exclusion, so it can never be the
  // reason a page came back empty. compatibilityDeprioritized counts rank-2
  // rows *present in the final page*, which is provably 0 when results are
  // empty (this helper is only ever called in that case) — see the JSDoc on
  // buildEmptySearchSuggestion in search.helpers.ts.
  it('never mentions a compatibility filter, regardless of input shape', () => {
    const out = buildEmptySearchSuggestion({ discoveryOnlyHidden: 1 })
    expect(out).not.toContain('compatibility filter')
    expect(out).not.toContain('compatible_with')
  })
})

// Code-review finding, MEDIUM: the offline branch's SearchService.search()
// call was truncating to the caller-facing `limit` BEFORE mergeRankAndPage
// ever saw the results — the exact rank-after-truncation bug this whole
// change exists to fix, reproduced locally.
describe('computeLocalCompatFetchLimit (SMI-5929 code-review finding)', () => {
  it('is a no-op when no compat filter is active', () => {
    expect(computeLocalCompatFetchLimit(10, false)).toBe(10)
    expect(computeLocalCompatFetchLimit(100, false)).toBe(100)
  })

  it('widens by the overfetch multiplier when a filter is active', () => {
    expect(computeLocalCompatFetchLimit(10, true)).toBe(30)
    expect(computeLocalCompatFetchLimit(2, true)).toBe(6)
  })

  it('caps the widened fetch at 100', () => {
    expect(computeLocalCompatFetchLimit(50, true)).toBe(100)
    expect(computeLocalCompatFetchLimit(100, true)).toBe(100)
  })
})
