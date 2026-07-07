/**
 * SMI-5562: Unit coverage for the shared security-summary derivation helper,
 * extracted from get-skill.ts's inline derivation (SMI-4240).
 */

import { describe, it, expect } from 'vitest'
import { deriveSecuritySummaryFromApiSkill } from './security-summary.js'

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
})
