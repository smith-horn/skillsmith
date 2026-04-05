/**
 * Quality Score Tests - SMI-3864
 *
 * Tests the canonical computeQualityScore function.
 */

import { describe, it, expect } from 'vitest'
import { computeQualityScore, type QualityScoreInput } from '../../src/scoring/quality-score.js'

function makeInput(overrides: Partial<QualityScoreInput> = {}): QualityScoreInput {
  return {
    riskScore: 0,
    securityFindingsCount: 0,
    securityPassed: true,
    description: 'A well-documented skill for testing purposes with plenty of detail',
    tagCount: 4,
    hasRepoUrl: true,
    hasAuthor: true,
    trustTier: 'verified',
    hasExamples: true,
    ...overrides,
  }
}

describe('computeQualityScore (SMI-3864)', () => {
  it('should return a number between 0 and 1', () => {
    const score = computeQualityScore(makeInput())
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('should return high score for perfect inputs', () => {
    const score = computeQualityScore(makeInput({ description: 'A'.repeat(300), tagCount: 5 }))
    expect(score).toBeGreaterThan(0.85)
  })

  it('should return low score for worst-case inputs', () => {
    const score = computeQualityScore({
      riskScore: 100,
      securityFindingsCount: 20,
      securityPassed: false,
      description: null,
      tagCount: 0,
      hasRepoUrl: false,
      hasAuthor: false,
      trustTier: 'unknown',
      hasExamples: false,
    })
    expect(score).toBeLessThan(0.15)
  })

  it('should give partial credit when security scan is null', () => {
    const withScan = computeQualityScore(makeInput({ securityPassed: true }))
    const withoutScan = computeQualityScore(makeInput({ securityPassed: null, riskScore: null }))
    expect(withoutScan).toBeLessThan(withScan)
    expect(withoutScan).toBeGreaterThan(0)
  })

  it('should increase score with more tags', () => {
    const noTags = computeQualityScore(makeInput({ tagCount: 0 }))
    const someTags = computeQualityScore(makeInput({ tagCount: 4 }))
    expect(someTags).toBeGreaterThan(noTags)
  })

  it('should increase score with examples', () => {
    const noExamples = computeQualityScore(makeInput({ hasExamples: false }))
    const withExamples = computeQualityScore(makeInput({ hasExamples: true }))
    expect(withExamples).toBeGreaterThan(noExamples)
  })

  it('should score verified higher than experimental', () => {
    const verified = computeQualityScore(makeInput({ trustTier: 'verified' }))
    const experimental = computeQualityScore(makeInput({ trustTier: 'experimental' }))
    expect(verified).toBeGreaterThan(experimental)
  })

  it('should handle null description', () => {
    const score = computeQualityScore(makeInput({ description: null }))
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('should penalize high risk scores', () => {
    const lowRisk = computeQualityScore(makeInput({ riskScore: 5 }))
    const highRisk = computeQualityScore(makeInput({ riskScore: 80 }))
    expect(lowRisk).toBeGreaterThan(highRisk)
  })
})
