/**
 * SMI-5562: Unit coverage for the shared security-summary derivation helper,
 * extracted from get-skill.ts's inline derivation (SMI-4240).
 * SMI-5897 (C-15): moved from packages/mcp-server/src/utils/security-summary.test.ts
 * to packages/core so the CLI (`SkillsmithApiClient.toSkill()`) and MCP tool
 * call sites share and test one implementation.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveSecuritySummaryFromApiSkill,
  deriveSecuritySummaryFromSkillRow,
} from './security-summary.js'

describe('deriveSecuritySummaryFromApiSkill', () => {
  it('returns undefined when the skill has never been scanned (last_scanned_at null)', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: null,
      quarantined: false,
      security_score: null,
      security_findings: null,
    })

    expect(result).toBeUndefined()
  })

  it('returns undefined when last_scanned_at is undefined', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: undefined,
      quarantined: undefined,
      security_score: undefined,
      security_findings: undefined,
    })

    expect(result).toBeUndefined()
  })

  it('returns passed: false when quarantined, regardless of security_score', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: true,
      // A low score would otherwise read as "clean" — quarantined must win.
      security_score: 0,
      security_findings: [],
    })

    expect(result?.passed).toBe(false)
  })

  it('returns passed: null when scanned but no security_score is recorded yet', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: null,
      security_findings: null,
    })

    expect(result?.passed).toBeNull()
    expect(result?.riskScore).toBeNull()
  })

  it('returns passed: true for a clean scanned skill with a recorded score', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: 0,
      security_findings: [],
    })

    expect(result).toEqual({
      passed: true,
      riskScore: 0,
      findingsCount: 0,
      scannedAt: '2026-06-01T00:00:00.000Z',
      scanCoverageIncomplete: false,
      scanCoverageNote: null,
    })
  })

  it('derives findingsCount from the security_findings array length', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: 42,
      security_findings: [{ rule: 'a' }, { rule: 'b' }, { rule: 'c' }],
    })

    expect(result?.findingsCount).toBe(3)
  })

  it('defaults findingsCount to 0 when security_findings is not an array', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: 10,
      // Defensive non-array case — should never happen at runtime (jsonb column),
      // but the derivation must not throw or miscount.
      security_findings: undefined,
    })

    expect(result?.findingsCount).toBe(0)
  })

  it('passes riskScore through as null (never a fabricated 0) when unscored', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: null,
      security_findings: [{ rule: 'pending-review' }],
    })

    expect(result?.riskScore).toBeNull()
    expect(result?.findingsCount).toBe(1)
  })

  // SMI-6033 Wave 2 (Gap 8): scan-coverage columns.
  it('defaults scanCoverageIncomplete to false and scanCoverageNote to null when absent (older cached data)', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: 0,
      security_findings: [],
      // scan_coverage_incomplete / scan_coverage_note deliberately omitted —
      // must not throw or fabricate an incomplete-scan caveat.
    })

    expect(result?.scanCoverageIncomplete).toBe(false)
    expect(result?.scanCoverageNote).toBeNull()
  })

  it('passes scanCoverageIncomplete/scanCoverageNote through when present', () => {
    const result = deriveSecuritySummaryFromApiSkill({
      last_scanned_at: '2026-06-01T00:00:00.000Z',
      quarantined: false,
      security_score: 5,
      security_findings: [],
      scan_coverage_incomplete: true,
      scan_coverage_note: 'tree_budget_exhausted',
    })

    expect(result?.scanCoverageIncomplete).toBe(true)
    expect(result?.scanCoverageNote).toBe('tree_budget_exhausted')
  })
})

describe('deriveSecuritySummaryFromSkillRow', () => {
  it('returns undefined when the skill has never been scanned (securityScannedAt null)', () => {
    const result = deriveSecuritySummaryFromSkillRow({
      securityPassed: null,
      riskScore: null,
      securityFindingsCount: 0,
      securityScannedAt: null,
    })

    expect(result).toBeUndefined()
  })

  it('passes passed/riskScore/findingsCount/scannedAt through raw for a scanned row', () => {
    const result = deriveSecuritySummaryFromSkillRow({
      securityPassed: true,
      riskScore: 12,
      securityFindingsCount: 2,
      securityScannedAt: '2026-06-01T00:00:00.000Z',
    })

    expect(result).toEqual({
      passed: true,
      riskScore: 12,
      findingsCount: 2,
      scannedAt: '2026-06-01T00:00:00.000Z',
      scanCoverageIncomplete: false,
      scanCoverageNote: null,
    })
  })

  // SMI-6033 Wave 2 (Gap 8): the local-DB path doesn't persist scan-coverage
  // columns yet — must default safely, never throw or fabricate a caveat.
  it('defaults scanCoverageIncomplete to false and scanCoverageNote to null when absent', () => {
    const result = deriveSecuritySummaryFromSkillRow({
      securityPassed: false,
      riskScore: 60,
      securityFindingsCount: 3,
      securityScannedAt: '2026-06-01T00:00:00.000Z',
    })

    expect(result?.scanCoverageIncomplete).toBe(false)
    expect(result?.scanCoverageNote).toBeNull()
  })

  it('passes scanCoverageIncomplete/scanCoverageNote through when present', () => {
    const result = deriveSecuritySummaryFromSkillRow({
      securityPassed: true,
      riskScore: 8,
      securityFindingsCount: 0,
      securityScannedAt: '2026-06-01T00:00:00.000Z',
      scanCoverageIncomplete: true,
      scanCoverageNote: 'count_cap_exceeded',
    })

    expect(result?.scanCoverageIncomplete).toBe(true)
    expect(result?.scanCoverageNote).toBe('count_cap_exceeded')
  })
})
