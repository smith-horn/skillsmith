/**
 * @fileoverview Risk trend detection tests
 * @see SMI-3874: Risk Trend Detection
 */

import { describe, it, expect } from 'vitest'
import { detectRiskTrend } from '../../src/security/risk-trend.js'
import type { RiskScoreSnapshot } from '../../src/repositories/RiskScoreHistoryRepository.js'

function makeSnapshot(
  riskScore: number,
  overrides?: Partial<RiskScoreSnapshot>
): RiskScoreSnapshot {
  return {
    id: 1,
    skillId: 'test/skill',
    riskScore,
    findingsCount: 0,
    contentHash: null,
    scannedAt: '2026-04-01T00:00:00.000Z',
    source: 'install',
    ...overrides,
  }
}

describe('detectRiskTrend', () => {
  it('should return no anomaly when there is no history', () => {
    const result = detectRiskTrend(10, [])
    expect(result.anomaly).toBe(false)
    expect(result.previousScore).toBeNull()
    expect(result.delta).toBe(0)
  })

  it('should return no anomaly for small delta', () => {
    const result = detectRiskTrend(15, [makeSnapshot(10)])
    expect(result.anomaly).toBe(false)
    expect(result.delta).toBe(5)
  })

  it('should flag warning for delta >= 20', () => {
    const result = detectRiskTrend(30, [makeSnapshot(10)])
    expect(result.anomaly).toBe(true)
    expect(result.message).toContain('WARNING')
  })

  it('should flag critical for delta >= 35', () => {
    const result = detectRiskTrend(45, [makeSnapshot(10)])
    expect(result.anomaly).toBe(true)
    expect(result.message).toContain('CRITICAL')
  })

  it('should flag boundary crossing (39 -> 40)', () => {
    const result = detectRiskTrend(40, [makeSnapshot(39)])
    expect(result.anomaly).toBe(true)
  })

  it('should not flag negative delta', () => {
    const result = detectRiskTrend(5, [makeSnapshot(30)])
    expect(result.anomaly).toBe(false)
  })

  it('should use most recent history entry', () => {
    const history = [makeSnapshot(10, { id: 2 }), makeSnapshot(50, { id: 1 })]
    const result = detectRiskTrend(35, history)
    expect(result.previousScore).toBe(10)
    expect(result.delta).toBe(25)
  })

  it('should not flag when isNewCategoryBaseline is true', () => {
    const result = detectRiskTrend(50, [makeSnapshot(10)], { isNewCategoryBaseline: true })
    expect(result.anomaly).toBe(false)
  })

  it('should not flag when score stays above 40', () => {
    const result = detectRiskTrend(45, [makeSnapshot(42)])
    expect(result.anomaly).toBe(false)
  })

  it('should flag boundary crossing (39 -> 41)', () => {
    const result = detectRiskTrend(41, [makeSnapshot(39)])
    expect(result.anomaly).toBe(true)
  })
})
