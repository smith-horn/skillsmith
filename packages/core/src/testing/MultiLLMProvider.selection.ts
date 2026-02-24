/**
 * @fileoverview Multi-LLM Provider Selection Strategies
 * @module @skillsmith/core/testing/MultiLLMProvider.selection
 * @see SMI-1523: Configure multi-LLM provider chain
 * @see SMI-2741: Split from MultiLLMProvider.ts to meet 500-line standard
 *
 * Provider selection algorithms for the MultiLLMProvider:
 * - Round-robin load balancing
 * - Least-loaded selection
 * - Latency-based selection
 * - Cost-based selection
 * - Fallback provider resolution on error
 */

import type {
  LLMProviderType,
  ProviderMetrics,
  ProviderStatus,
  LLMRequest,
  ResolvedMultiLLMConfig,
  FallbackRule,
} from './MultiLLMProvider.types.js'
import { getErrorCondition } from './MultiLLMProvider.helpers.js'

/**
 * Select a provider using round-robin strategy
 *
 * @param providers - Available providers
 * @param roundRobinIndex - Current round-robin index (mutated)
 * @returns Selected provider and updated index
 */
export function selectRoundRobin(
  providers: LLMProviderType[],
  roundRobinIndex: number
): { provider: LLMProviderType; nextIndex: number } {
  const provider = providers[roundRobinIndex % providers.length]
  return { provider, nextIndex: roundRobinIndex + 1 }
}

/**
 * Select the provider with the lowest current load
 *
 * @param providers - Available providers
 * @param getStatus - Function to get provider status
 * @returns Selected provider
 */
export function selectLeastLoaded(
  providers: LLMProviderType[],
  getStatus: (provider: LLMProviderType) => ProviderStatus
): LLMProviderType {
  return providers.reduce((best, current) => {
    const bestStatus = getStatus(best)
    const currentStatus = getStatus(current)
    return currentStatus.currentLoad < bestStatus.currentLoad ? current : best
  })
}

/**
 * Select the provider with the lowest average latency
 *
 * @param providers - Available providers
 * @param getMetrics - Function to get provider metrics
 * @returns Selected provider
 */
export function selectByLatency(
  providers: LLMProviderType[],
  getMetrics: (provider: LLMProviderType) => ProviderMetrics | undefined
): LLMProviderType {
  return providers.reduce((best, current) => {
    const bestMetrics = getMetrics(best)
    const currentMetrics = getMetrics(current)
    const bestLatency = bestMetrics?.avgLatencyMs ?? Infinity
    const currentLatency = currentMetrics?.avgLatencyMs ?? Infinity
    return currentLatency < bestLatency ? current : best
  })
}

/**
 * Select the provider with the lowest cost per token
 *
 * @param providers - Available providers
 * @param config - Provider configuration
 * @returns Selected provider
 */
export function selectByCost(
  providers: LLMProviderType[],
  config: ResolvedMultiLLMConfig['providers']
): LLMProviderType {
  return providers.reduce((best, current) => {
    const configBest = config[best]
    const configCurrent = config[current]
    const costBest = (configBest?.costPerInputToken ?? 0) + (configBest?.costPerOutputToken ?? 0)
    const costCurrent =
      (configCurrent?.costPerInputToken ?? 0) + (configCurrent?.costPerOutputToken ?? 0)
    return costCurrent < costBest ? current : best
  })
}

/**
 * Select an appropriate provider for a request
 *
 * Considers cost constraints, load balancing strategy, and default provider.
 *
 * @param request - LLM request with optional constraints
 * @param available - Available (healthy) providers
 * @param config - Full multi-LLM config
 * @param roundRobinIndex - Current round-robin index
 * @param getStatus - Function to get provider status
 * @param getMetrics - Function to get provider metrics
 * @returns Selected provider and next round-robin index
 */
export function selectProvider(
  request: LLMRequest,
  available: LLMProviderType[],
  config: ResolvedMultiLLMConfig,
  roundRobinIndex: number,
  getStatus: (provider: LLMProviderType) => ProviderStatus,
  getMetrics: (provider: LLMProviderType) => ProviderMetrics | undefined
): { provider: LLMProviderType; nextRoundRobinIndex: number } {
  if (available.length === 0) {
    throw new Error('No providers available')
  }

  // Cost constraint check
  if (request.costConstraints?.maxCost && config.costOptimization.enabled) {
    const costSorted = [...available].sort((a, b) => {
      const configA = config.providers[a]
      const configB = config.providers[b]
      const costA = (configA?.costPerInputToken ?? 0) + (configA?.costPerOutputToken ?? 0)
      const costB = (configB?.costPerInputToken ?? 0) + (configB?.costPerOutputToken ?? 0)
      return costA - costB
    })
    return { provider: costSorted[0], nextRoundRobinIndex: roundRobinIndex }
  }

  // Load balancing
  if (config.loadBalancing.enabled) {
    switch (config.loadBalancing.strategy) {
      case 'round-robin': {
        const result = selectRoundRobin(available, roundRobinIndex)
        return { provider: result.provider, nextRoundRobinIndex: result.nextIndex }
      }
      case 'least-loaded':
        return {
          provider: selectLeastLoaded(available, getStatus),
          nextRoundRobinIndex: roundRobinIndex,
        }
      case 'latency-based':
        return {
          provider: selectByLatency(available, getMetrics),
          nextRoundRobinIndex: roundRobinIndex,
        }
      case 'cost-based':
        return {
          provider: selectByCost(available, config.providers),
          nextRoundRobinIndex: roundRobinIndex,
        }
    }
  }

  // Default to configured default
  if (available.includes(config.defaultProvider)) {
    return { provider: config.defaultProvider, nextRoundRobinIndex: roundRobinIndex }
  }

  return { provider: available[0], nextRoundRobinIndex: roundRobinIndex }
}

/**
 * Find the appropriate fallback provider after a failure
 *
 * @param currentProvider - Provider that failed
 * @param error - The error that caused the failure
 * @param rules - Fallback rules
 * @param available - Currently available providers
 * @returns Fallback provider or null if none available
 */
export function getFallbackProvider(
  currentProvider: LLMProviderType,
  error: unknown,
  rules: FallbackRule[],
  available: LLMProviderType[]
): LLMProviderType | null {
  const condition = getErrorCondition(error)
  const rule = rules.find((r) => r.condition === condition)

  if (!rule) return null

  for (const fallback of rule.fallbackProviders) {
    if (fallback !== currentProvider && available.includes(fallback)) {
      return fallback
    }
  }

  return null
}
