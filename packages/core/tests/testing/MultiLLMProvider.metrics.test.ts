/**
 * SMI-2754: MultiLLMProvider Metrics Tests
 *
 * Tests for aggregateMetrics and runCompatibilityTest:
 * - aggregateMetrics with populated map
 * - aggregateMetrics with empty map (providerCount === 0 branch)
 * - runCompatibilityTest with all providers succeeding
 * - runCompatibilityTest with one provider throwing
 * - runCompatibilityTest result filtering (score >= 0.7)
 * - runCompatibilityTest with no providers
 */

import { describe, it, expect, vi } from 'vitest'
import {
  aggregateMetrics,
  runCompatibilityTest,
} from '../../src/testing/MultiLLMProvider.metrics.js'
import type {
  LLMProviderType,
  ProviderMetrics,
  LLMRequest,
  LLMResponse,
} from '../../src/testing/MultiLLMProvider.types.js'

function makeMetrics(
  provider: LLMProviderType,
  overrides: Partial<ProviderMetrics> = {}
): ProviderMetrics {
  return {
    provider,
    timestamp: new Date(),
    avgLatencyMs: 100,
    errorRate: 0,
    successRate: 1,
    load: 0,
    totalCost: 0.5,
    totalRequests: 10,
    availability: 1,
    ...overrides,
  }
}

function makeLLMResponse(provider: LLMProviderType, latencyMs = 200): LLMResponse {
  return {
    content: 'Test response content',
    provider,
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    cost: 0.001,
    latencyMs,
    usedFallback: false,
  }
}

// ============================================================================
// aggregateMetrics
// ============================================================================

describe('aggregateMetrics', () => {
  it('aggregates totals correctly from a populated map', () => {
    const metricsMap = new Map<LLMProviderType, ProviderMetrics>([
      [
        'anthropic',
        makeMetrics('anthropic', {
          totalRequests: 10,
          totalCost: 1.0,
          avgLatencyMs: 200,
          successRate: 0.9,
        }),
      ],
      [
        'openai',
        makeMetrics('openai', {
          totalRequests: 5,
          totalCost: 0.5,
          avgLatencyMs: 100,
          successRate: 0.8,
        }),
      ],
    ])

    const result = aggregateMetrics(metricsMap)

    expect(result.totalRequests).toBe(15)
    expect(result.totalCost).toBeCloseTo(1.5)
    // weighted avg: (200*10 + 100*5) / 15 = 2500/15 ≈ 166.67
    expect(result.avgLatencyMs).toBeCloseTo(166.67, 1)
    // avg success rate: (0.9 + 0.8) / 2 = 0.85
    expect(result.avgSuccessRate).toBeCloseTo(0.85)
    expect(result.providerBreakdown.anthropic).toBe(10)
    expect(result.providerBreakdown.openai).toBe(5)
  })

  it('returns zero values when map is empty (providerCount === 0)', () => {
    const metricsMap = new Map<LLMProviderType, ProviderMetrics>()
    const result = aggregateMetrics(metricsMap)

    expect(result.totalRequests).toBe(0)
    expect(result.totalCost).toBe(0)
    expect(result.avgLatencyMs).toBe(0)
    expect(result.avgSuccessRate).toBe(0)
  })
})

// ============================================================================
// runCompatibilityTest
// ============================================================================

describe('runCompatibilityTest', () => {
  it('records compatible=true with positive score when all providers succeed', async () => {
    const completer = vi
      .fn()
      .mockImplementation(async (req: LLMRequest) => makeLLMResponse(req.provider!, 100))

    const result = await runCompatibilityTest(
      'community/jest-helper',
      ['anthropic', 'openai'],
      completer
    )

    expect(result.skillId).toBe('community/jest-helper')
    expect(result.results.anthropic.compatible).toBe(true)
    expect(result.results.anthropic.score).toBeGreaterThan(0)
    expect(result.results.openai.compatible).toBe(true)
    expect(result.overallScore).toBeGreaterThan(0)
  })

  it('records compatible=false with score 0 when a provider throws', async () => {
    const completer = vi.fn().mockImplementation(async (req: LLMRequest) => {
      if (req.provider === 'openai') {
        throw new Error('Provider unavailable')
      }
      return makeLLMResponse(req.provider!, 200)
    })

    const result = await runCompatibilityTest(
      'community/jest-helper',
      ['anthropic', 'openai'],
      completer
    )

    expect(result.results.anthropic.compatible).toBe(true)
    expect(result.results.openai.compatible).toBe(false)
    expect(result.results.openai.score).toBe(0)
    expect(result.results.openai.error).toBe('Provider unavailable')
  })

  it('includes only providers with score >= 0.7 in recommendedProviders', async () => {
    const completer = vi.fn().mockImplementation(async (req: LLMRequest) => {
      // Low latency → high score (1 - 50/5000 + 0.3 = 1.29 → clamped to 1.0)
      if (req.provider === 'anthropic') {
        return makeLLMResponse('anthropic', 50)
      }
      // Very high latency → score of 0.3 (1 - 4900/5000 + 0.3 = 0.32)
      return makeLLMResponse('openai', 4900)
    })

    const result = await runCompatibilityTest(
      'community/test-skill',
      ['anthropic', 'openai'],
      completer
    )

    // anthropic has a high score (>= 0.7); openai has score ~0.32 (< 0.7)
    expect(result.recommendedProviders).toContain('anthropic')
    expect(result.recommendedProviders).not.toContain('openai')
  })

  it('returns overallScore 0 and empty recommendedProviders when no providers given', async () => {
    const completer = vi.fn()
    const result = await runCompatibilityTest('skill/empty', [], completer)

    expect(result.overallScore).toBe(0)
    expect(result.recommendedProviders).toHaveLength(0)
    expect(completer).not.toHaveBeenCalled()
  })

  it('sets testedAt to a Date close to now', async () => {
    const before = new Date()
    const completer = vi.fn().mockResolvedValue(makeLLMResponse('anthropic', 100))
    const result = await runCompatibilityTest('skill/time-check', ['anthropic'], completer)
    const after = new Date()

    expect(result.testedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(result.testedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 5)
  })

  it('handles non-Error throws by recording "Unknown error"', async () => {
    const completer = vi.fn().mockImplementationOnce(() => {
      throw 'string error thrown' // non-Error object
    })

    const result = await runCompatibilityTest('skill/string-throw', ['anthropic'], completer)

    expect(result.results.anthropic.compatible).toBe(false)
    expect(result.results.anthropic.error).toBe('Unknown error')
  })
})
