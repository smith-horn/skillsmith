/**
 * SMI-2754: PatternStore Helper Functions Tests
 *
 * Tests covering pure math functions, FisherInformationMatrix,
 * and DB-touching helpers extracted to PatternStore.helpers.ts.
 *
 * Categories:
 * - FisherInformationMatrix: construct, update, accumulate, decay,
 *   serialize/deserialize round-trip, reset, invalid buffer size
 * - contextToText: empty, partial, full context
 * - computeGradient, cosineSimilarity, importanceWeightedSimilarity (zero-norm edge)
 * - calculatePatternImportance: positive and negative reward
 * - shouldConsolidate: too recent, no patterns, ratio threshold, near max patterns
 * - computeAverageEmbedding: empty table → zero vector, populated → average
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  FisherInformationMatrix,
  contextToText,
  computeGradient,
  cosineSimilarity,
  importanceWeightedSimilarity,
  calculatePatternImportance,
  shouldConsolidate,
  computeAverageEmbedding,
  PATTERN_STORE_SCHEMA,
} from '../../src/learning/PatternStore.helpers.js'
import type {
  PatternRecommendationContext,
  StoredPattern,
  PatternOutcome,
  ConsolidationState,
  EWCConfig,
} from '../../src/learning/PatternStore.types.js'
import { createDatabase } from '../../src/db/createDatabase.js'
import type { Database } from '../../src/db/database-interface.js'

// ============================================================================
// FisherInformationMatrix
// ============================================================================

describe('FisherInformationMatrix', () => {
  it('constructs with zero importance vector', () => {
    const fim = new FisherInformationMatrix(4)
    expect(fim.getImportanceVector()).toEqual(new Float32Array(4))
    expect(fim.getUpdateCount()).toBe(0)
    expect(fim.getAverageImportance()).toBe(0)
  })

  it('updates importance from a gradient', () => {
    const fim = new FisherInformationMatrix(3)
    const gradient = new Float32Array([1.0, 2.0, 0.0])
    fim.update(gradient)

    expect(fim.getUpdateCount()).toBe(1)
    // importance = runningSum / updateCount = [1, 4, 0] / 1
    expect(fim.getImportance(0)).toBeCloseTo(1.0)
    expect(fim.getImportance(1)).toBeCloseTo(4.0)
    expect(fim.getImportance(2)).toBeCloseTo(0.0)
  })

  it('accumulates importance over multiple updates', () => {
    const fim = new FisherInformationMatrix(2)
    fim.update(new Float32Array([2.0, 0.0]))
    fim.update(new Float32Array([2.0, 0.0]))

    // runningSum = [4+4, 0] = [8, 0]; importance = [8/2, 0/2] = [4, 0]
    expect(fim.getImportance(0)).toBeCloseTo(4.0)
    expect(fim.getUpdateCount()).toBe(2)
  })

  it('decays importance by decayFactor', () => {
    const fim = new FisherInformationMatrix(2)
    fim.update(new Float32Array([2.0, 4.0]))
    // After update: runningSum=[4, 16], importance=[4, 16]
    fim.decay(0.5)
    // runningSum=[2, 8]; importance = [2, 8] / max(1, 1) = [2, 8]
    expect(fim.getImportance(0)).toBeCloseTo(2.0)
    expect(fim.getImportance(1)).toBeCloseTo(8.0)
  })

  it('serialize and deserialize round-trip preserves values', () => {
    const fim = new FisherInformationMatrix(3)
    fim.update(new Float32Array([1.0, 2.0, 3.0]))
    fim.update(new Float32Array([0.5, 1.0, 1.5]))

    const buffer = fim.serialize()

    const fim2 = new FisherInformationMatrix(3)
    fim2.deserialize(buffer)

    expect(fim2.getUpdateCount()).toBe(2)
    // Values should match within float32 precision
    for (let i = 0; i < 3; i++) {
      expect(fim2.getImportance(i)).toBeCloseTo(fim.getImportance(i), 4)
    }
  })

  it('reset clears all values to zero', () => {
    const fim = new FisherInformationMatrix(3)
    fim.update(new Float32Array([1.0, 2.0, 3.0]))
    fim.reset()

    expect(fim.getUpdateCount()).toBe(0)
    expect(fim.getAverageImportance()).toBe(0)
    expect(fim.getImportance(0)).toBe(0)
  })

  it('throws when deserializing buffer that is too small', () => {
    const fim = new FisherInformationMatrix(4)
    const tooSmall = Buffer.alloc(4) // way smaller than needed

    expect(() => fim.deserialize(tooSmall)).toThrow(/Invalid Fisher matrix buffer/)
  })
})

// ============================================================================
// contextToText
// ============================================================================

describe('contextToText', () => {
  it('returns "empty context" for an empty context object', () => {
    const ctx: PatternRecommendationContext = { installedSkills: [] }
    expect(contextToText(ctx)).toBe('empty context')
  })

  it('returns partial text when only some fields are set', () => {
    const ctx: PatternRecommendationContext = {
      installedSkills: ['anthropic/commit'],
      timeOfDay: 'morning',
    }
    const text = contextToText(ctx)
    expect(text).toContain('installed: anthropic/commit')
    expect(text).toContain('time: morning')
    expect(text).not.toContain('frameworks')
  })

  it('returns all fields when all are set', () => {
    const ctx: PatternRecommendationContext = {
      installedSkills: ['anthropic/commit', 'community/jest'],
      frameworks: ['react', 'typescript'],
      keywords: ['testing'],
      timeOfDay: 'afternoon',
      dayType: 'weekday',
    }
    const text = contextToText(ctx)
    expect(text).toContain('installed: anthropic/commit, community/jest')
    expect(text).toContain('frameworks: react, typescript')
    expect(text).toContain('keywords: testing')
    expect(text).toContain('time: afternoon')
    expect(text).toContain('day: weekday')
  })
})

// ============================================================================
// computeGradient
// ============================================================================

describe('computeGradient', () => {
  it('computes element-wise difference a - b', () => {
    const a = new Float32Array([3.0, 1.0, 2.0])
    const b = new Float32Array([1.0, 2.0, 1.0])
    const gradient = computeGradient(a, b)
    expect(gradient[0]).toBeCloseTo(2.0)
    expect(gradient[1]).toBeCloseTo(-1.0)
    expect(gradient[2]).toBeCloseTo(1.0)
  })
})

// ============================================================================
// cosineSimilarity
// ============================================================================

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical non-zero vectors', () => {
    const a = new Float32Array([1.0, 0.0, 0.0])
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1.0, 0.0])
    const b = new Float32Array([0.0, 1.0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0)
  })

  it('returns 0 when either vector is all zeros (zero-norm edge case)', () => {
    const zero = new Float32Array([0.0, 0.0])
    const a = new Float32Array([1.0, 2.0])
    expect(cosineSimilarity(zero, a)).toBe(0)
    expect(cosineSimilarity(a, zero)).toBe(0)
  })
})

// ============================================================================
// importanceWeightedSimilarity
// ============================================================================

describe('importanceWeightedSimilarity', () => {
  it('computes weighted similarity between two identical vectors', () => {
    const a = new Float32Array([1.0, 0.0])
    const importance = new Float32Array([1.0, 0.0])
    const result = importanceWeightedSimilarity(a, a, importance)
    expect(result).toBeCloseTo(1.0)
  })

  it('returns 0 when the weighted norms are zero (zero-norm edge case)', () => {
    const zero = new Float32Array([0.0, 0.0])
    const importance = new Float32Array([1.0, 1.0])
    const result = importanceWeightedSimilarity(zero, zero, importance)
    expect(result).toBe(0)
  })
})

// ============================================================================
// calculatePatternImportance
// ============================================================================

function makeStoredPattern(reward: number): StoredPattern {
  return {
    id: 'test-id',
    context: { installedSkills: [] },
    skill: {
      skillId: 'community/test',
      category: 'testing',
      trustTier: 'community',
      keywords: [],
      qualityScore: 80,
      installCount: 100,
    },
    originalScore: 0.8,
    source: 'recommend',
    contextEmbedding: new Float32Array([0.1, 0.2]),
    outcome: { type: reward >= 0 ? 'accept' : 'dismiss', reward },
    importance: 0.5,
    accessCount: 3,
    createdAt: new Date(),
    lastAccessedAt: new Date(),
  }
}

describe('calculatePatternImportance', () => {
  it('gives higher importance for positive reward (1.5x multiplier)', () => {
    const pattern = makeStoredPattern(1.0)
    const outcome: PatternOutcome = { type: 'accept', reward: 1.0 }
    const importance = calculatePatternImportance(pattern, outcome)
    // baseImportance = 1.0 * 1.5 = 1.5, times other factors
    expect(importance).toBeGreaterThan(0)
  })

  it('gives lower importance for negative reward (no 1.5x multiplier)', () => {
    const positivePattern = makeStoredPattern(1.0)
    const negativePattern = makeStoredPattern(-0.5)
    const positiveOutcome: PatternOutcome = { type: 'accept', reward: 1.0 }
    const negativeOutcome: PatternOutcome = { type: 'dismiss', reward: -0.5 }

    const importancePos = calculatePatternImportance(positivePattern, positiveOutcome)
    const importanceNeg = calculatePatternImportance(negativePattern, negativeOutcome)
    // positive reward has 1.5x boost, so its importance should be higher
    expect(importancePos).toBeGreaterThan(importanceNeg)
  })
})

// ============================================================================
// shouldConsolidate
// ============================================================================

function makeConsolidationState(overrides: Partial<ConsolidationState> = {}): ConsolidationState {
  return {
    totalPatterns: 100,
    patternsSinceLastConsolidation: 5,
    lastConsolidation: null,
    ...overrides,
  }
}

const ewcConfig: EWCConfig = {
  lambda: 5.0,
  fisherDecay: 0.95,
  importanceThreshold: 0.01,
  fisherSampleSize: 100,
  consolidationThreshold: 0.1,
  maxPatterns: 1000,
}

describe('shouldConsolidate', () => {
  it('returns false when last consolidation was less than 1 hour ago', () => {
    const state = makeConsolidationState({
      lastConsolidation: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
      totalPatterns: 200,
      patternsSinceLastConsolidation: 50,
    })
    expect(shouldConsolidate(state, ewcConfig)).toBe(false)
  })

  it('returns false when totalPatterns is 0', () => {
    const state = makeConsolidationState({ totalPatterns: 0, patternsSinceLastConsolidation: 0 })
    expect(shouldConsolidate(state, ewcConfig)).toBe(false)
  })

  it('returns true when newPatternsRatio exceeds consolidationThreshold', () => {
    // 20/100 = 0.2 > 0.1 threshold
    const state = makeConsolidationState({
      totalPatterns: 100,
      patternsSinceLastConsolidation: 20,
      lastConsolidation: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    })
    expect(shouldConsolidate(state, ewcConfig)).toBe(true)
  })

  it('returns true when totalPatterns > 90% of maxPatterns', () => {
    const state = makeConsolidationState({
      totalPatterns: 950, // > 1000 * 0.9 = 900
      patternsSinceLastConsolidation: 5, // ratio = 5/950 < 0.1
      lastConsolidation: new Date(Date.now() - 2 * 60 * 60 * 1000),
    })
    expect(shouldConsolidate(state, ewcConfig)).toBe(true)
  })
})

// ============================================================================
// computeAverageEmbedding (requires in-memory SQLite)
// ============================================================================

describe('computeAverageEmbedding', () => {
  let db: Database

  beforeEach(() => {
    db = createDatabase(':memory:')
    db.exec(PATTERN_STORE_SCHEMA)
  })

  afterEach(() => {
    db.close()
  })

  it('returns zero vector when the patterns table is empty', async () => {
    const result = await computeAverageEmbedding(db, 100, 4)
    expect(result).toEqual(new Float32Array(4))
  })

  it('returns the average of all stored embeddings', async () => {
    const dims = 4
    // Store two embeddings: [1,2,3,4] and [3,4,5,6]
    // Expected average: [2,3,4,5]
    const emb1 = new Float32Array([1, 2, 3, 4])
    const emb2 = new Float32Array([3, 4, 5, 6])

    const buf1 = Buffer.from(emb1.buffer)
    const buf2 = Buffer.from(emb2.buffer)

    const insertStmt = db.prepare(`
      INSERT INTO patterns (
        pattern_id, context_embedding, skill_id, skill_features, context_data,
        outcome_type, outcome_reward, importance, original_score, source,
        access_count, created_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `)

    insertStmt.run('p1', buf1, 'skill1', '{}', '{}', 'accept', 1.0, 0.5, 0.8, 'recommend', 0)
    insertStmt.run('p2', buf2, 'skill2', '{}', '{}', 'accept', 1.0, 0.5, 0.8, 'recommend', 0)

    const result = await computeAverageEmbedding(db, 100, dims)

    expect(result[0]).toBeCloseTo(2.0)
    expect(result[1]).toBeCloseTo(3.0)
    expect(result[2]).toBeCloseTo(4.0)
    expect(result[3]).toBeCloseTo(5.0)
  })
})
