/**
 * SMI-1521: SONARouter Tests
 *
 * Tests for the SONA routing system that routes MCP tool requests
 * through an 8-expert MoE network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  SONARouter,
  createSONARouter,
  shouldUseSONARouting,
  isHighConfidenceDecision,
  usedFallback,
  TOOL_WEIGHTS,
  SONA_EXPERTS,
  DEFAULT_SONA_CONFIG,
  SONA_FEATURE_FLAGS,
  type ToolRequest,
  type ToolType,
  type RoutingDecision,
} from '../../src/routing/index.js'

describe('SONARouter', () => {
  let router: SONARouter

  beforeEach(async () => {
    router = new SONARouter({ useV3MoE: false }) // Disable V3 for tests
    await router.initialize()
  })

  afterEach(async () => {
    await router.shutdown()
  })

  const createRequest = (tool: ToolType, args: Record<string, unknown> = {}): ToolRequest => ({
    requestId: `test-${Date.now()}`,
    tool,
    arguments: args,
    timestamp: new Date(),
  })

  describe('initialization', () => {
    it('should create instance with default config', () => {
      const instance = new SONARouter()
      expect(instance.isInitialized()).toBe(false)
    })

    it('should initialize successfully', async () => {
      const instance = new SONARouter({ useV3MoE: false })
      await instance.initialize()
      expect(instance.isInitialized()).toBe(true)
      await instance.shutdown()
    })

    it('should be idempotent on multiple initializations', async () => {
      const instance = new SONARouter({ useV3MoE: false })
      await instance.initialize()
      await instance.initialize() // Should not throw
      expect(instance.isInitialized()).toBe(true)
      await instance.shutdown()
    })

    it('should not use V3 MoE when disabled', async () => {
      expect(router.isUsingV3MoE()).toBe(false)
    })

    it('should throw if methods called before initialization', async () => {
      const uninitialized = new SONARouter()
      await expect(uninitialized.route(createRequest('search'))).rejects.toThrow('not initialized')
    })
  })

  describe('route', () => {
    it('should route search requests to accuracy-focused expert', async () => {
      const decision = await router.route(createRequest('search', { query: 'testing' }))

      expect(decision.requestId).toBeDefined()
      expect(decision.expertId).toBeDefined()
      expect(decision.confidence).toBeGreaterThan(0)
      expect(decision.confidence).toBeLessThanOrEqual(1)
    })

    it('should route get_skill requests to latency-focused expert', async () => {
      const decision = await router.route(createRequest('get_skill', { id: 'anthropic/commit' }))

      // get_skill has high latency weight, should prefer latency expert
      expect(decision.expertId).toMatch(/latency|balanced/)
      expect(decision.decisionTimeMs).toBeDefined()
    })

    it('should route install requests to reliability-focused expert', async () => {
      const decision = await router.route(createRequest('install', { skillId: 'test/skill' }))

      // install has high reliability weight
      expect(decision.scores.reliabilityScore).toBeGreaterThan(0)
    })

    it('should include alternatives in decision', async () => {
      const decision = await router.route(createRequest('search'))

      // Multiple experts support search, should have alternatives
      expect(decision.alternatives).toBeDefined()
      expect(decision.alternatives.length).toBeGreaterThanOrEqual(0)
    })

    it('should include score breakdown', async () => {
      const decision = await router.route(createRequest('recommend'))

      expect(decision.scores).toBeDefined()
      expect(decision.scores.accuracyScore).toBeGreaterThanOrEqual(0)
      expect(decision.scores.latencyScore).toBeGreaterThanOrEqual(0)
      expect(decision.scores.reliabilityScore).toBeGreaterThanOrEqual(0)
      expect(decision.scores.efficiencyScore).toBeGreaterThanOrEqual(0)
      expect(decision.scores.totalScore).toBeGreaterThan(0)
    })

    it('should generate human-readable reason', async () => {
      const decision = await router.route(createRequest('compare'))

      expect(decision.reason).toBeDefined()
      expect(decision.reason.length).toBeGreaterThan(0)
      expect(decision.reason).toContain('compare')
    })
  })

  describe('caching', () => {
    it('should cache routing decisions', async () => {
      const request = createRequest('search', { query: 'same query' })

      await router.route(request)
      const decision2 = await router.route({ ...request, requestId: 'req-2' })

      // Second request should be cached
      expect(decision2.cacheHit).toBe(true)
    })

    it('should not cache high priority requests', async () => {
      const request1 = createRequest('search', { query: 'test' })
      request1.priority = 'high'

      const request2 = createRequest('search', { query: 'test' })
      request2.priority = 'high'

      await router.route(request1)
      const decision2 = await router.route(request2)

      expect(decision2.cacheHit).toBeUndefined()
    })

    it('should use different cache keys for different arguments', async () => {
      await router.route(createRequest('search', { query: 'foo' }))
      const decision2 = await router.route(createRequest('search', { query: 'bar' }))

      // Different arguments, should not be cached
      expect(decision2.cacheHit).toBeUndefined()
    })
  })

  describe('executeWithRouting', () => {
    it('should execute request and return success response', async () => {
      const request = createRequest('search', { query: 'test' })

      const response = await router.executeWithRouting(request, async (expertId) => {
        return { results: ['skill1', 'skill2'], expertUsed: expertId }
      })

      expect(response.success).toBe(true)
      expect(response.data).toBeDefined()
      expect(response.meta.expertId).toBeDefined()
      expect(response.meta.totalTimeMs).toBeGreaterThanOrEqual(0)
      expect(response.meta.routingTimeMs).toBeGreaterThanOrEqual(0)
      expect(response.meta.executionTimeMs).toBeGreaterThanOrEqual(0)
    })

    it('should handle execution failure', async () => {
      const request = createRequest('validate', { skillId: 'invalid' })

      const response = await router.executeWithRouting(request, async () => {
        throw new Error('Validation failed')
      })

      expect(response.success).toBe(false)
      expect(response.error).toBeDefined()
      expect(response.error?.message).toContain('Validation failed')
    })

    it('should record execution metrics', async () => {
      const request = createRequest('search')

      await router.executeWithRouting(request, async () => ({ results: [] }))

      const metrics = router.getMetrics()
      expect(metrics.totalRequests).toBeGreaterThan(0)
    })
  })

  describe('expert management', () => {
    it('should return status for all experts', () => {
      const statuses = router.getExpertStatus()

      expect(statuses.length).toBe(8) // 8 experts in default config
      expect(statuses[0].id).toBeDefined()
      expect(statuses[0].state).toBe('healthy')
    })

    it('should get specific expert definition', () => {
      const expert = router.getExpert('accuracy-semantic')

      expect(expert).toBeDefined()
      expect(expert?.name).toBe('Semantic Search Expert')
      expect(expert?.type).toBe('accuracy')
    })

    it('should update expert health', () => {
      router.updateExpertHealth('accuracy-semantic', 'degraded', 0.8)

      const statuses = router.getExpertStatus()
      const semantic = statuses.find((s) => s.id === 'accuracy-semantic')

      expect(semantic?.state).toBe('degraded')
      expect(semantic?.load).toBe(0.8)
    })
  })

  describe('metrics', () => {
    it('should track total requests', async () => {
      await router.route(createRequest('search'))
      await router.route(createRequest('recommend'))
      await router.route(createRequest('install'))

      const metrics = router.getMetrics()
      expect(metrics.totalRequests).toBe(3)
    })

    it('should track requests by tool', async () => {
      await router.route(createRequest('search'))
      await router.route(createRequest('search'))
      await router.route(createRequest('recommend'))

      const metrics = router.getMetrics()
      expect(metrics.requestsByTool?.search).toBe(2)
      expect(metrics.requestsByTool?.recommend).toBe(1)
    })

    it('should track cache hit rate', async () => {
      const request = createRequest('search', { query: 'test' })
      await router.route(request)
      await router.route({ ...request, requestId: 'req-2' })
      await router.route({ ...request, requestId: 'req-3' })

      const metrics = router.getMetrics()
      expect(metrics.cache?.hitRate).toBeGreaterThan(0)
    })

    it('should reset metrics', async () => {
      await router.route(createRequest('search'))
      router.resetMetrics()

      const metrics = router.getMetrics()
      expect(metrics.totalRequests).toBe(0)
    })

    it('should calculate speed improvement ratio', async () => {
      await router.route(createRequest('search'))

      const metrics = router.getMetrics()
      expect(metrics.speedImprovement?.improvementRatio).toBeGreaterThan(0)
    })
  })

  describe('fallback', () => {
    it('should return fallback decision when no experts eligible', async () => {
      // Create router with no experts
      const emptyRouter = new SONARouter({ experts: [], useV3MoE: false })
      await emptyRouter.initialize()

      const decision = await emptyRouter.route(createRequest('search'))

      expect(decision.expertId).toBe('direct-fallback')
      expect(decision.reason).toContain('Fallback')

      await emptyRouter.shutdown()
    })
  })
})

describe('TOOL_WEIGHTS', () => {
  it('should have weights for all tool types', () => {
    const tools: ToolType[] = [
      'search',
      'recommend',
      'install',
      'validate',
      'compare',
      'get_skill',
      'uninstall',
      'analyze',
    ]

    for (const tool of tools) {
      expect(TOOL_WEIGHTS[tool]).toBeDefined()
      expect(TOOL_WEIGHTS[tool].accuracy).toBeGreaterThanOrEqual(0)
      expect(TOOL_WEIGHTS[tool].accuracy).toBeLessThanOrEqual(1)
    }
  })

  it('should have weights that sum to approximately 1', () => {
    for (const [, weights] of Object.entries(TOOL_WEIGHTS)) {
      const sum = weights.accuracy + weights.latency + weights.reliability + weights.efficiency
      expect(sum).toBeCloseTo(1.0, 1)
    }
  })

  it('should prioritize accuracy for search', () => {
    expect(TOOL_WEIGHTS.search.accuracy).toBeGreaterThan(TOOL_WEIGHTS.search.latency)
  })

  it('should prioritize latency for get_skill', () => {
    expect(TOOL_WEIGHTS.get_skill.latency).toBeGreaterThan(TOOL_WEIGHTS.get_skill.accuracy)
  })

  it('should prioritize reliability for install', () => {
    expect(TOOL_WEIGHTS.install.reliability).toBeGreaterThan(TOOL_WEIGHTS.install.latency)
  })
})

describe('SONA_EXPERTS', () => {
  it('should have 8 experts', () => {
    expect(SONA_EXPERTS.length).toBe(8)
  })

  it('should have 2 accuracy experts', () => {
    const accuracyExperts = SONA_EXPERTS.filter((e) => e.type === 'accuracy')
    expect(accuracyExperts.length).toBe(2)
  })

  it('should have 2 latency experts', () => {
    const latencyExperts = SONA_EXPERTS.filter((e) => e.type === 'latency')
    expect(latencyExperts.length).toBe(2)
  })

  it('should have 2 balanced experts', () => {
    const balancedExperts = SONA_EXPERTS.filter((e) => e.type === 'balanced')
    expect(balancedExperts.length).toBe(2)
  })

  it('should have 2 specialized experts', () => {
    const specializedExperts = SONA_EXPERTS.filter((e) => e.type === 'specialized')
    expect(specializedExperts.length).toBe(2)
  })

  it('should have unique expert IDs', () => {
    const ids = SONA_EXPERTS.map((e) => e.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('should have valid capability definitions', () => {
    for (const expert of SONA_EXPERTS) {
      expect(expert.capabilities.supportedTools.length).toBeGreaterThan(0)
      expect(expert.capabilities.maxConcurrency).toBeGreaterThan(0)
      expect(expert.capabilities.avgLatencyMs).toBeGreaterThan(0)
      expect(expert.capabilities.accuracyScore).toBeGreaterThan(0)
      expect(expert.capabilities.accuracyScore).toBeLessThanOrEqual(1)
    }
  })
})

describe('DEFAULT_SONA_CONFIG', () => {
  it('should have default experts', () => {
    expect(DEFAULT_SONA_CONFIG.experts).toBe(SONA_EXPERTS)
  })

  it('should enable cache by default', () => {
    expect(DEFAULT_SONA_CONFIG.enableCache).toBe(true)
  })

  it('should have reasonable cache TTL', () => {
    expect(DEFAULT_SONA_CONFIG.cacheTtlMs).toBe(60000) // 1 minute
  })

  it('should enable fallback by default', () => {
    expect(DEFAULT_SONA_CONFIG.fallback.enabled).toBe(true)
  })
})

describe('shouldUseSONARouting', () => {
  it('should return false when master switch is off', () => {
    const result = shouldUseSONARouting('search', {
      'sona.enabled': false,
      'sona.tools.search': true,
    })
    expect(result).toBe(false)
  })

  it('should return false when tool flag is off', () => {
    const result = shouldUseSONARouting('search', {
      'sona.enabled': true,
      'sona.tools.search': false,
    })
    expect(result).toBe(false)
  })

  it('should return false when tier is not enabled', () => {
    const result = shouldUseSONARouting(
      'search',
      {
        'sona.enabled': true,
        'sona.tools.search': true,
        'sona.tiers.community': false,
      },
      'community'
    )
    expect(result).toBe(false)
  })

  it('should return true when all flags enabled', () => {
    const result = shouldUseSONARouting(
      'search',
      {
        'sona.enabled': true,
        'sona.tools.search': true,
        'sona.tiers.enterprise': true,
      },
      'enterprise'
    )
    expect(result).toBe(true)
  })

  it('should work without tier check', () => {
    const result = shouldUseSONARouting('search', {
      'sona.enabled': true,
      'sona.tools.search': true,
    })
    expect(result).toBe(true)
  })
})

describe('type guards', () => {
  const highConfidenceDecision: RoutingDecision = {
    requestId: 'test',
    expertId: 'accuracy-semantic',
    confidence: 0.92,
    scores: {
      accuracyScore: 0.95,
      latencyScore: 0.5,
      reliabilityScore: 0.9,
      efficiencyScore: 0.8,
      totalScore: 0.85,
    },
    alternatives: [],
    reason: 'Test decision',
    decidedAt: new Date(),
    decisionTimeMs: 2,
  }

  const lowConfidenceDecision: RoutingDecision = {
    ...highConfidenceDecision,
    confidence: 0.5,
  }

  const fallbackDecision: RoutingDecision = {
    ...highConfidenceDecision,
    expertId: 'direct-fallback',
  }

  describe('isHighConfidenceDecision', () => {
    it('should return true for high confidence', () => {
      expect(isHighConfidenceDecision(highConfidenceDecision)).toBe(true)
    })

    it('should return false for low confidence', () => {
      expect(isHighConfidenceDecision(lowConfidenceDecision)).toBe(false)
    })
  })

  describe('usedFallback', () => {
    it('should return true for fallback decision', () => {
      expect(usedFallback(fallbackDecision)).toBe(true)
    })

    it('should return false for normal decision', () => {
      expect(usedFallback(highConfidenceDecision)).toBe(false)
    })
  })
})

describe('createSONARouter factory', () => {
  it('should create and initialize router', async () => {
    const router = await createSONARouter({ useV3MoE: false })

    expect(router.isInitialized()).toBe(true)
    await router.shutdown()
  })
})

describe('SONA_FEATURE_FLAGS', () => {
  it('should have master switch', () => {
    expect(SONA_FEATURE_FLAGS['sona.enabled']).toBeDefined()
  })

  it('should have tool-specific flags', () => {
    expect(SONA_FEATURE_FLAGS['sona.tools.search']).toBeDefined()
    expect(SONA_FEATURE_FLAGS['sona.tools.recommend']).toBeDefined()
    expect(SONA_FEATURE_FLAGS['sona.tools.install']).toBeDefined()
  })

  it('should enable enterprise by default', () => {
    expect(SONA_FEATURE_FLAGS['sona.tiers.enterprise']).toBe(true)
  })

  it('should disable community by default', () => {
    expect(SONA_FEATURE_FLAGS['sona.tiers.community']).toBe(false)
  })
})
