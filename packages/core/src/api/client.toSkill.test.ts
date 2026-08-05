/**
 * SMI-5897 (C-15): Unit coverage for `SkillsmithApiClient.toSkill()`'s
 * security-status field derivation.
 *
 * Previously `toSkill()` hardcoded `riskScore: null, securityFindingsCount: 0,
 * securityScannedAt: null, securityPassed: null` for every API-sourced skill,
 * discarding the real `security_score`/`quarantined`/`last_scanned_at`/
 * `security_findings` fields already present on the `ApiSearchResult` it
 * received — this is why CLI `info`/`search` (which both route through
 * `toSkill()`) could show "Not scanned" for a skill MCP correctly reported
 * as passed. `toSkill()` now derives these fields via the same shared
 * `deriveSecuritySummaryFromApiSkill()` MCP's tools use, so the two surfaces
 * can't re-diverge (see `api/security-summary.test.ts` for derivation-logic
 * coverage — this file only asserts `toSkill()` wires it through correctly).
 *
 * SMI-5897 (Wave 4 fix): imports `ApiSearchResult` from `./client.types.js` —
 * `toSkill()`'s ACTUAL parameter type — not `./types.js`, which declares a
 * different, same-named type (a pre-existing naming collision elsewhere in
 * this codebase, not something fixed globally here). Importing the wrong
 * type, combined with the `as ApiSearchResult` cast this fix also removes,
 * meant the fixture below was never actually type-checked against
 * `toSkill()`'s real input contract.
 */

import { describe, it, expect } from 'vitest'
import { SkillsmithApiClient } from './client.js'
import type { ApiSearchResult } from './client.types.js'

function makeApiSearchResult(overrides: Partial<ApiSearchResult> = {}): ApiSearchResult {
  return {
    id: 'skill-1',
    name: 'commit',
    description: 'A commit skill',
    author: 'anthropic',
    repo_url: 'https://github.com/anthropic/commit',
    quality_score: 90,
    trust_tier: 'verified',
    tags: ['git'],
    stars: 10,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    installable: true,
    ...overrides,
  }
}

describe('SkillsmithApiClient.toSkill() — security field derivation (SMI-5897 C-15)', () => {
  it('reports "not scanned" (all-null security fields) when last_scanned_at is null', () => {
    const result = makeApiSearchResult({
      last_scanned_at: null,
      quarantined: false,
      security_score: null,
      security_findings: null,
    })

    const skill = SkillsmithApiClient.toSkill(result)

    expect(skill.securityScannedAt).toBeNull()
    expect(skill.securityPassed).toBeNull()
    expect(skill.riskScore).toBeNull()
    expect(skill.securityFindingsCount).toBe(0)
  })

  it('reports a real passing scan status instead of a hardcoded "not scanned"', () => {
    const result = makeApiSearchResult({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: 0,
      security_findings: [],
    })

    const skill = SkillsmithApiClient.toSkill(result)

    // Pre-fix this was unconditionally { securityPassed: null, ... } —
    // the exact CLI/MCP status-mismatch bug (C-15).
    expect(skill.securityPassed).toBe(true)
    expect(skill.securityScannedAt).toBe('2026-06-01T00:00:00.000Z')
    expect(skill.riskScore).toBe(0)
    expect(skill.securityFindingsCount).toBe(0)
  })

  it('reports a failing scan status (quarantined) instead of a hardcoded "not scanned"', () => {
    const result = makeApiSearchResult({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: true,
      security_score: 10,
      security_findings: [{ rule: 'a' }, { rule: 'b' }],
    })

    const skill = SkillsmithApiClient.toSkill(result)

    expect(skill.securityPassed).toBe(false)
    expect(skill.securityFindingsCount).toBe(2)
    expect(skill.riskScore).toBe(10)
  })

  it('preserves riskScore: null (never fabricates 0) for a scanned-but-unscored skill', () => {
    const result = makeApiSearchResult({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: null,
      security_findings: null,
    })

    const skill = SkillsmithApiClient.toSkill(result)

    expect(skill.securityPassed).toBeNull()
    expect(skill.riskScore).toBeNull()
    expect(skill.securityScannedAt).toBe('2026-06-01T00:00:00.000Z')
  })
})
