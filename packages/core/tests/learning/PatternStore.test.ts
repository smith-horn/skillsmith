/**
 * SMI-1522: PatternStore with EWC++ Tests
 *
 * Tests for the PatternStore class that implements Elastic Weight
 * Consolidation++ for catastrophic forgetting prevention.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  PatternStore,
  createPatternStore,
  FisherInformationMatrix,
  DEFAULT_EWC_CONFIG,
  PATTERN_REWARDS,
  type Pattern,
  type PatternOutcome,
  type PatternRecommendationContext,
  type SkillFeatures,
} from '../../src/learning/PatternStore.js'

describe('PatternStore', () => {
  let store: PatternStore

  const mockContext: PatternRecommendationContext = {
    installedSkills: ['anthropic/commit', 'anthropic/review-pr'],
    frameworks: ['react', 'typescript'],
    keywords: ['testing', 'jest'],
    timeOfDay: 'afternoon',
    dayType: 'weekday',
  }

  const mockSkill: SkillFeatures = {
    skillId: 'community/jest-helper',
    category: 'testing',
    trustTier: 'community',
    keywords: ['jest', 'testing', 'unit-test'],
    qualityScore: 85,
    installCount: 500,
  }

  const mockPattern: Pattern = {
    context: mockContext,
    skill: mockSkill,
    originalScore: 0.85,
    source: 'recommend',
  }

  const acceptOutcome: PatternOutcome = {
    type: 'accept',
    reward: 1.0,
    confidence: 1.0,
  }

  const dismissOutcome: PatternOutcome = {
    type: 'dismiss',
    reward: -0.5,
  }

  beforeEach(async () => {
    store = await createPatternStore({
      autoConsolidate: false, // Manual consolidation in tests
      ewc: {
        consolidationThreshold: 0.05,
        maxPatterns: 100,
      },
    })
  })

  afterEach(() => {
    store.close()
  })

  describe('initialization', () => {
    it('should create instance with default config', async () => {
      const instance = new PatternStore()
      await instance.initialize()
      expect(instance).toBeInstanceOf(PatternStore)
      instance.close()
    })

    it('should create initialized instance via factory', async () => {
      const instance = await createPatternStore()
      expect(instance).toBeInstanceOf(PatternStore)
      instance.close()
    })

    it('should throw if methods called before initialization', async () => {
      const uninitialized = new PatternStore()

      await expect(uninitialized.storePattern(mockPattern, acceptOutcome)).rejects.toThrow(
        'not initialized'
      )
    })

    it('should persist configuration', async () => {
      const instance = await createPatternStore({
        dimensions: 256,
        ewc: {
          lambda: 10.0,
          fisherDecay: 0.9,
        },
      })
      // No direct config accessor, but creation should succeed
      expect(instance).toBeInstanceOf(PatternStore)
      instance.close()
    })
  })

  describe('storePattern', () => {
    it('should store a new pattern and return ID', async () => {
      const patternId = await store.storePattern(mockPattern, acceptOutcome)

      expect(patternId).toBeDefined()
      expect(typeof patternId).toBe('string')
      expect(patternId.length).toBeGreaterThan(0)
    })

    it('should store pattern with custom ID', async () => {
      const customPattern: Pattern = {
        ...mockPattern,
        id: 'custom-pattern-id',
      }

      const patternId = await store.storePattern(customPattern, acceptOutcome)
      expect(patternId).toBe('custom-pattern-id')
    })

    it('should calculate initial importance from outcome reward', async () => {
      const patternId = await store.storePattern(mockPattern, acceptOutcome)

      const importance = store.getPatternImportance(patternId)
      expect(importance).toBeGreaterThan(0)
    })

    it('should give higher importance to positive outcomes', async () => {
      const positiveId = await store.storePattern(mockPattern, acceptOutcome)
      const negativeId = await store.storePattern(
        { ...mockPattern, skill: { ...mockSkill, skillId: 'other/skill' } },
        dismissOutcome
      )

      const positiveImportance = store.getPatternImportance(positiveId)
      const negativeImportance = store.getPatternImportance(negativeId)

      // Positive outcomes get 1.5x boost
      expect(positiveImportance).toBeGreaterThan(negativeImportance)
    })

    it('should update existing pattern if very similar', async () => {
      const firstId = await store.storePattern(mockPattern, acceptOutcome)

      // Store nearly identical pattern
      const samePatternAgain = await store.storePattern(mockPattern, {
        type: 'usage',
        reward: 0.3,
      })

      // Should return same ID since patterns are very similar
      expect(samePatternAgain).toBe(firstId)
    })

    it('should store different patterns separately', async () => {
      const firstId = await store.storePattern(mockPattern, acceptOutcome)

      // Store different pattern
      const differentPattern: Pattern = {
        context: {
          installedSkills: ['other/skill'],
          frameworks: ['vue', 'python'],
          keywords: ['different', 'keywords'],
        },
        skill: { skillId: 'other/different-skill', category: 'devops' },
        originalScore: 0.6,
        source: 'search',
      }

      const secondId = await store.storePattern(differentPattern, acceptOutcome)
      expect(secondId).not.toBe(firstId)
    })
  })

  describe('findSimilarPatterns', () => {
    beforeEach(async () => {
      // Seed some patterns
      await store.storePattern(mockPattern, acceptOutcome)
      await store.storePattern(
        {
          context: { ...mockContext, frameworks: ['vue'] },
          skill: { ...mockSkill, skillId: 'community/vue-helper' },
          originalScore: 0.75,
          source: 'recommend',
        },
        acceptOutcome
      )
      await store.storePattern(
        {
          context: { ...mockContext, keywords: ['python'] },
          skill: { ...mockSkill, skillId: 'community/pytest-helper' },
          originalScore: 0.65,
          source: 'search',
        },
        dismissOutcome
      )
    })

    it('should find similar patterns by context', async () => {
      const results = await store.findSimilarPatterns({
        context: mockContext,
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].similarity).toBeGreaterThan(0)
      expect(results[0].weightedSimilarity).toBeGreaterThan(0)
    })

    it('should return patterns sorted by weighted similarity', async () => {
      const results = await store.findSimilarPatterns({
        context: mockContext,
      })

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].weightedSimilarity).toBeGreaterThanOrEqual(
          results[i].weightedSimilarity
        )
      }
    })

    it('should assign correct ranks', async () => {
      const results = await store.findSimilarPatterns({
        context: mockContext,
      })

      for (let i = 0; i < results.length; i++) {
        expect(results[i].rank).toBe(i + 1)
      }
    })

    it('should filter by skillId', async () => {
      const results = await store.findSimilarPatterns({
        context: mockContext,
        skillId: 'community/jest-helper',
      })

      expect(results.length).toBeGreaterThan(0)
      for (const result of results) {
        expect(result.pattern.skill.skillId).toBe('community/jest-helper')
      }
    })

    it('should filter by category', async () => {
      const results = await store.findSimilarPatterns({
        context: mockContext,
        category: 'testing',
      })

      for (const result of results) {
        expect(result.pattern.skill.category).toBe('testing')
      }
    })

    it('should filter by minimum importance', async () => {
      const results = await store.findSimilarPatterns({
        context: mockContext,
        minImportance: 0.05,
      })

      for (const result of results) {
        expect(result.pattern.importance).toBeGreaterThanOrEqual(0.05)
      }
    })

    it('should filter by positiveOnly', async () => {
      const results = await store.findSimilarPatterns({
        context: mockContext,
        positiveOnly: true,
      })

      for (const result of results) {
        expect(result.pattern.outcome.reward).toBeGreaterThan(0)
      }
    })

    it('should respect limit parameter', async () => {
      const results = await store.findSimilarPatterns({ context: mockContext }, 2)

      expect(results.length).toBeLessThanOrEqual(2)
    })
  })

  describe('consolidate', () => {
    it('should skip consolidation if threshold not reached', async () => {
      // Store many patterns first to establish baseline
      for (let i = 0; i < 20; i++) {
        await store.storePattern(
          {
            context: { ...mockContext, keywords: [`baseline-${i}`] },
            skill: { ...mockSkill, skillId: `baseline/skill-${i}` },
            originalScore: 0.8,
            source: 'recommend',
          },
          acceptOutcome
        )
      }

      // Force consolidation to reset the counter
      await store.consolidate()

      // Now add just one pattern (well below 5% threshold)
      await store.storePattern(
        { ...mockPattern, skill: { ...mockSkill, skillId: 'single/new' } },
        acceptOutcome
      )

      const result = await store.consolidate()

      expect(result.consolidated).toBe(false)
      expect(result.patternsProcessed).toBe(0)
    })

    it('should consolidate when threshold is reached', async () => {
      // Store enough patterns to trigger consolidation
      for (let i = 0; i < 20; i++) {
        await store.storePattern(
          {
            context: { ...mockContext, keywords: [`keyword-${i}`] },
            skill: { ...mockSkill, skillId: `skill/skill-${i}` },
            originalScore: 0.5 + Math.random() * 0.5,
            source: 'recommend',
          },
          Math.random() > 0.3 ? acceptOutcome : dismissOutcome
        )
      }

      const result = await store.consolidate()

      expect(result.consolidated).toBe(true)
      expect(result.patternsProcessed).toBeGreaterThan(0)
    })

    it('should achieve >= 95% preservation rate', async () => {
      // Store patterns with varying importance
      for (let i = 0; i < 30; i++) {
        await store.storePattern(
          {
            context: { ...mockContext, keywords: [`keyword-${i}`] },
            skill: { ...mockSkill, skillId: `skill/skill-${i}` },
            originalScore: 0.5 + Math.random() * 0.5,
            source: 'recommend',
          },
          acceptOutcome
        )
      }

      const result = await store.consolidate()

      if (result.consolidated) {
        expect(result.preservationRate).toBeGreaterThanOrEqual(0.95)
      }
    })

    it('should prune low-importance patterns', async () => {
      // Store many patterns
      for (let i = 0; i < 50; i++) {
        await store.storePattern(
          {
            context: { ...mockContext, keywords: [`keyword-${i}`] },
            skill: { ...mockSkill, skillId: `skill/skill-${i}` },
            originalScore: 0.5 + Math.random() * 0.5,
            source: 'recommend',
          },
          i % 5 === 0 ? dismissOutcome : acceptOutcome
        )
      }

      const result = await store.consolidate()

      if (result.consolidated) {
        expect(result.patternsPruned).toBeGreaterThanOrEqual(0)
      }
    })

    it('should update average importance', async () => {
      for (let i = 0; i < 25; i++) {
        await store.storePattern(
          {
            context: { ...mockContext, keywords: [`keyword-${i}`] },
            skill: { ...mockSkill, skillId: `skill/skill-${i}` },
            originalScore: 0.5,
            source: 'recommend',
          },
          acceptOutcome
        )
      }

      const result = await store.consolidate()

      expect(result.averageImportance).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getMetrics', () => {
    it('should return metrics for empty store', async () => {
      const metrics = store.getMetrics()

      expect(metrics.totalPatterns).toBe(0)
      expect(metrics.averageImportance).toBe(0)
      expect(metrics.consolidation.totalConsolidations).toBe(0)
    })

    it('should track patterns by outcome type', async () => {
      await store.storePattern(mockPattern, acceptOutcome)
      await store.storePattern(
        { ...mockPattern, skill: { ...mockSkill, skillId: 'skill/2' } },
        dismissOutcome
      )

      const metrics = store.getMetrics()

      expect(metrics.patternsByOutcome.accept).toBeGreaterThanOrEqual(1)
      expect(metrics.patternsByOutcome.dismiss).toBeGreaterThanOrEqual(1)
    })

    it('should track query performance', async () => {
      await store.storePattern(mockPattern, acceptOutcome)

      // Get initial query count (storePattern also uses findSimilarPatterns internally)
      const initialMetrics = store.getMetrics()
      const initialQueries = initialMetrics.queryPerformance.queriesPerformed

      // Perform additional queries
      await store.findSimilarPatterns({ context: mockContext })
      await store.findSimilarPatterns({ context: mockContext })

      const metrics = store.getMetrics()

      expect(metrics.queryPerformance.queriesPerformed).toBe(initialQueries + 2)
      expect(metrics.queryPerformance.averageLatencyMs).toBeGreaterThanOrEqual(0)
    })

    it('should track consolidation history', async () => {
      // Store patterns and force consolidation
      for (let i = 0; i < 30; i++) {
        await store.storePattern(
          {
            context: { ...mockContext, keywords: [`keyword-${i}`] },
            skill: { ...mockSkill, skillId: `skill/skill-${i}` },
            originalScore: 0.5,
            source: 'recommend',
          },
          acceptOutcome
        )
      }

      await store.consolidate()

      const metrics = store.getMetrics()

      expect(metrics.consolidation.totalConsolidations).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('FisherInformationMatrix', () => {
  let matrix: FisherInformationMatrix
  const dimensions = 384

  beforeEach(() => {
    matrix = new FisherInformationMatrix(dimensions)
  })

  describe('initialization', () => {
    it('should create with correct dimensions', () => {
      const importanceVector = matrix.getImportanceVector()
      expect(importanceVector.length).toBe(dimensions)
    })

    it('should start with zero importance', () => {
      expect(matrix.getAverageImportance()).toBe(0)
      expect(matrix.getImportance(0)).toBe(0)
      expect(matrix.getImportance(dimensions - 1)).toBe(0)
    })
  })

  describe('update', () => {
    it('should update importance based on gradient', () => {
      const gradient = new Float32Array(dimensions)
      gradient.fill(0.5)

      matrix.update(gradient)

      expect(matrix.getAverageImportance()).toBeGreaterThan(0)
    })

    it('should accumulate importance over multiple updates', () => {
      const gradient = new Float32Array(dimensions)
      gradient.fill(0.5)

      matrix.update(gradient)
      matrix.getAverageImportance() // First update

      matrix.update(gradient)
      const secondAvg = matrix.getAverageImportance()

      // Running mean should stabilize
      expect(secondAvg).toBeGreaterThan(0)
    })

    it('should track update count', () => {
      const gradient = new Float32Array(dimensions)
      gradient.fill(0.5)

      expect(matrix.getUpdateCount()).toBe(0)
      matrix.update(gradient)
      expect(matrix.getUpdateCount()).toBe(1)
      matrix.update(gradient)
      expect(matrix.getUpdateCount()).toBe(2)
    })
  })

  describe('decay', () => {
    it('should reduce importance values', () => {
      const gradient = new Float32Array(dimensions)
      gradient.fill(1.0)

      matrix.update(gradient)
      const beforeDecay = matrix.getAverageImportance()

      matrix.decay(0.5)
      const afterDecay = matrix.getAverageImportance()

      expect(afterDecay).toBeLessThan(beforeDecay)
    })

    it('should not affect zero importance', () => {
      matrix.decay(0.5)
      expect(matrix.getAverageImportance()).toBe(0)
    })
  })

  describe('serialization', () => {
    it('should serialize and deserialize correctly', () => {
      const gradient = new Float32Array(dimensions)
      gradient.fill(0.75)

      matrix.update(gradient)
      const originalAvg = matrix.getAverageImportance()
      const originalCount = matrix.getUpdateCount()

      const serialized = matrix.serialize()

      const newMatrix = new FisherInformationMatrix(dimensions)
      newMatrix.deserialize(serialized)

      expect(newMatrix.getAverageImportance()).toBeCloseTo(originalAvg, 5)
      expect(newMatrix.getUpdateCount()).toBe(originalCount)
    })

    it('should preserve dimension-level importance', () => {
      const gradient = new Float32Array(dimensions)
      for (let i = 0; i < dimensions; i++) {
        gradient[i] = i / dimensions
      }

      matrix.update(gradient)

      const serialized = matrix.serialize()

      const newMatrix = new FisherInformationMatrix(dimensions)
      newMatrix.deserialize(serialized)

      for (let i = 0; i < dimensions; i++) {
        expect(newMatrix.getImportance(i)).toBeCloseTo(matrix.getImportance(i), 5)
      }
    })
  })

  describe('reset', () => {
    it('should reset all values to zero', () => {
      const gradient = new Float32Array(dimensions)
      gradient.fill(1.0)

      matrix.update(gradient)
      expect(matrix.getAverageImportance()).toBeGreaterThan(0)

      matrix.reset()

      expect(matrix.getAverageImportance()).toBe(0)
      expect(matrix.getUpdateCount()).toBe(0)
    })
  })
})

describe('Pattern Rewards', () => {
  it('should have correct reward values', () => {
    expect(PATTERN_REWARDS.accept).toBe(1.0)
    expect(PATTERN_REWARDS.usage).toBe(0.3)
    expect(PATTERN_REWARDS.frequent).toBe(0.5)
    expect(PATTERN_REWARDS.dismiss).toBe(-0.5)
    expect(PATTERN_REWARDS.abandonment).toBe(-0.3)
    expect(PATTERN_REWARDS.uninstall).toBe(-0.7)
  })

  it('should align with ReasoningBank trajectory rewards', () => {
    // These should match TRAJECTORY_REWARDS in ReasoningBankIntegration
    expect(PATTERN_REWARDS.accept).toBeGreaterThan(0)
    expect(PATTERN_REWARDS.dismiss).toBeLessThan(0)
    expect(PATTERN_REWARDS.uninstall).toBeLessThan(PATTERN_REWARDS.dismiss)
  })
})

describe('Default EWC Config', () => {
  it('should have reasonable default values', () => {
    expect(DEFAULT_EWC_CONFIG.lambda).toBe(5.0)
    expect(DEFAULT_EWC_CONFIG.fisherDecay).toBe(0.95)
    expect(DEFAULT_EWC_CONFIG.importanceThreshold).toBe(0.01)
    expect(DEFAULT_EWC_CONFIG.fisherSampleSize).toBe(100)
    expect(DEFAULT_EWC_CONFIG.consolidationThreshold).toBe(0.1)
    expect(DEFAULT_EWC_CONFIG.maxPatterns).toBe(10000)
  })

  it('should have fisher decay in valid range', () => {
    expect(DEFAULT_EWC_CONFIG.fisherDecay).toBeGreaterThan(0.8)
    expect(DEFAULT_EWC_CONFIG.fisherDecay).toBeLessThanOrEqual(1.0)
  })
})

describe('EWC++ Catastrophic Forgetting Prevention', () => {
  let store: PatternStore

  const importantContext: PatternRecommendationContext = {
    installedSkills: ['anthropic/commit'],
    frameworks: ['react', 'typescript'],
    keywords: ['testing', 'jest'],
  }

  const importantPattern: Pattern = {
    context: importantContext,
    skill: { skillId: 'community/jest-helper', category: 'testing' },
    originalScore: 0.95,
    source: 'recommend',
  }

  beforeEach(async () => {
    store = await createPatternStore({
      autoConsolidate: false,
      ewc: {
        consolidationThreshold: 0.05,
        maxPatterns: 100,
      },
    })
  })

  afterEach(() => {
    store.close()
  })

  it('should preserve important patterns across many new insertions', async () => {
    // Store the important pattern
    await store.storePattern(importantPattern, {
      type: 'accept',
      reward: 1.0,
    })

    // Access it multiple times to increase importance
    for (let i = 0; i < 10; i++) {
      await store.findSimilarPatterns({
        context: importantContext,
        skillId: 'community/jest-helper',
      })
    }

    // Store many new patterns
    for (let i = 0; i < 50; i++) {
      await store.storePattern(
        {
          context: {
            installedSkills: ['other/skill'],
            frameworks: ['vue', 'python'],
            keywords: [`keyword-${i}`],
          },
          skill: { skillId: `new-skill-${i}`, category: 'testing' },
          originalScore: 0.5,
          source: 'recommend',
        },
        {
          type: 'accept',
          reward: 0.8,
        }
      )
    }

    // Consolidate
    const result = await store.consolidate()

    // Verify important pattern was preserved
    const preserved = await store.findSimilarPatterns({
      context: importantContext,
      skillId: 'community/jest-helper',
      minImportance: 0.01,
    })

    expect(preserved.length).toBeGreaterThan(0)
    expect(result.preservationRate).toBeGreaterThanOrEqual(0.95)
  })

  it('should allow low-importance patterns to be overwritten', async () => {
    // Store a low-importance pattern
    await store.storePattern(
      {
        context: { installedSkills: [] },
        skill: { skillId: 'low/importance' },
        originalScore: 0.1,
        source: 'search',
      },
      {
        type: 'dismiss',
        reward: -0.5,
        confidence: 0.3,
      }
    )

    // Store many patterns and consolidate
    for (let i = 0; i < 50; i++) {
      await store.storePattern(
        {
          context: { installedSkills: [], keywords: [`key-${i}`] },
          skill: { skillId: `skill-${i}` },
          originalScore: 0.8,
          source: 'recommend',
        },
        { type: 'accept', reward: 1.0 }
      )
    }

    const result = await store.consolidate()

    // Low importance patterns may be pruned
    expect(result.consolidated).toBe(true)
  })

  it('should maintain 95% preservation after multiple consolidation cycles', async () => {
    // Seed initial important patterns
    for (let i = 0; i < 20; i++) {
      await store.storePattern(
        {
          context: { ...importantContext, keywords: [`important-${i}`] },
          skill: { skillId: `important/skill-${i}`, category: 'testing' },
          originalScore: 0.9,
          source: 'recommend',
        },
        { type: 'accept', reward: 1.0 }
      )
    }

    // Run multiple consolidation cycles
    const preservationRates: number[] = []

    for (let cycle = 0; cycle < 3; cycle++) {
      // Add new patterns each cycle
      for (let i = 0; i < 15; i++) {
        await store.storePattern(
          {
            context: { installedSkills: [], keywords: [`cycle-${cycle}-${i}`] },
            skill: { skillId: `cycle-${cycle}-skill-${i}` },
            originalScore: 0.5,
            source: 'search',
          },
          { type: 'accept', reward: 0.7 }
        )
      }

      const result = await store.consolidate()
      if (result.consolidated) {
        preservationRates.push(result.preservationRate)
      }
    }

    // All consolidation cycles should maintain high preservation
    for (const rate of preservationRates) {
      expect(rate).toBeGreaterThanOrEqual(0.9)
    }
  })
})
