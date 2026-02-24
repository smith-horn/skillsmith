/**
 * @fileoverview Multi-LLM Provider Metrics Aggregation and Compatibility Testing
 * @module @skillsmith/core/testing/MultiLLMProvider.metrics
 * @see SMI-1523: Configure multi-LLM provider chain
 * @see SMI-2741: Split from MultiLLMProvider.ts to meet 500-line standard
 *
 * Standalone functions for metrics aggregation and skill compatibility testing,
 * extracted to keep MultiLLMProvider.ts within the 500-line limit.
 */

import type {
  LLMProviderType,
  ProviderMetrics,
  SkillCompatibilityResult,
  LLMRequest,
  LLMResponse,
} from './MultiLLMProvider.types.js'
import { calculateCompatibilityScore } from './MultiLLMProvider.helpers.js'

// ============================================================================
// Aggregated Metrics
// ============================================================================

/**
 * Aggregate metrics across all providers into a summary object
 *
 * @param providerMetrics - Map of per-provider metrics
 * @returns Aggregated totals and averages
 */
export function aggregateMetrics(providerMetrics: Map<LLMProviderType, ProviderMetrics>): {
  totalRequests: number
  totalCost: number
  avgLatencyMs: number
  avgSuccessRate: number
  providerBreakdown: Record<LLMProviderType, number>
} {
  let totalRequests = 0,
    totalCost = 0,
    totalLatency = 0,
    totalSuccessRate = 0
  const providerBreakdown: Record<LLMProviderType, number> = {} as Record<LLMProviderType, number>

  for (const [provider, metrics] of providerMetrics) {
    totalRequests += metrics.totalRequests
    totalCost += metrics.totalCost
    totalLatency += metrics.avgLatencyMs * metrics.totalRequests
    totalSuccessRate += metrics.successRate
    providerBreakdown[provider] = metrics.totalRequests
  }

  const providerCount = providerMetrics.size

  return {
    totalRequests,
    totalCost,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
    avgSuccessRate: providerCount > 0 ? totalSuccessRate / providerCount : 0,
    providerBreakdown,
  }
}

// ============================================================================
// Skill Compatibility Testing
// ============================================================================

/**
 * Run a skill compatibility test across enabled providers
 *
 * @param skillId - Skill identifier to test
 * @param enabledProviders - List of enabled providers to test against
 * @param completer - Async function that executes an LLM request
 * @returns Compatibility result with per-provider scores and overall assessment
 */
export async function runCompatibilityTest(
  skillId: string,
  enabledProviders: LLMProviderType[],
  completer: (request: LLMRequest) => Promise<LLMResponse>
): Promise<SkillCompatibilityResult> {
  const results: SkillCompatibilityResult['results'] = {} as SkillCompatibilityResult['results']

  const testPrompt = `Analyze if you can effectively help a user with a skill called "${skillId}".
    Respond with a brief assessment of your capability.`

  for (const provider of enabledProviders) {
    const startTime = Date.now()

    try {
      const response = await completer({
        messages: [{ role: 'user', content: testPrompt }],
        provider,
        maxTokens: 100,
      })

      results[provider] = {
        compatible: true,
        score: calculateCompatibilityScore(response),
        latencyMs: response.latencyMs,
      }
    } catch (error) {
      results[provider] = {
        compatible: false,
        score: 0,
        latencyMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  const scores = Object.values(results)
    .filter((r) => r.compatible)
    .map((r) => r.score)
  const overallScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

  const recommendedProviders = Object.entries(results)
    .filter(([, r]) => r.compatible && r.score >= 0.7)
    .sort(([, a], [, b]) => b.score - a.score)
    .map(([p]) => p as LLMProviderType)

  return { skillId, results, overallScore, recommendedProviders, testedAt: new Date() }
}
