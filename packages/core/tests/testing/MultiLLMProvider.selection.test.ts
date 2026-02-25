/**
 * SMI-2754: MultiLLMProvider Selection Strategy Tests
 *
 * Tests for selectProvider and getFallbackProvider covering all uncovered branches:
 * - cost-constraint branch
 * - least-loaded strategy
 * - latency-based strategy
 * - cost-based strategy
 * - default-provider fallback
 * - first-available fallback
 * - getFallbackProvider: no matching rule
 * - getFallbackProvider: matching rule with excluded current provider
 */

import { describe, it, expect } from 'vitest'
import {
  selectProvider,
  getFallbackProvider,
  selectRoundRobin,
  selectLeastLoaded,
  selectByLatency,
  selectByCost,
} from '../../src/testing/MultiLLMProvider.selection.js'
import type {
  LLMProviderType,
  ProviderStatus,
  ProviderMetrics,
  ResolvedMultiLLMConfig,
  FallbackRule,
} from '../../src/testing/MultiLLMProvider.types.js'

// ============================================================================
// Shared test fixtures
// ============================================================================

function makeConfig(overrides: Partial<ResolvedMultiLLMConfig> = {}): ResolvedMultiLLMConfig {
  return {
    defaultProvider: 'anthropic',
    providers: {
      anthropic: {
        provider: 'anthropic',
        model: 'claude-sonnet',
        enabled: true,
        priority: 'quality',
        costPerInputToken: 0.003,
        costPerOutputToken: 0.015,
      },
      openai: {
        provider: 'openai',
        model: 'gpt-4',
        enabled: true,
        priority: 'speed',
        costPerInputToken: 0.01,
        costPerOutputToken: 0.03,
      },
      google: {
        provider: 'google',
        model: 'gemini-pro',
        enabled: true,
        priority: 'cost',
        costPerInputToken: 0.00025,
        costPerOutputToken: 0.0005,
      },
    },
    loadBalancing: { enabled: false, strategy: 'round-robin' },
    costOptimization: { enabled: false },
    circuitBreaker: {
      timeoutMs: 30000,
      errorThresholdPercentage: 50,
      resetTimeoutMs: 60000,
      volumeThreshold: 10,
    },
    enableMetrics: false,
    useV3Integration: false,
    fallbackStrategy: {
      name: 'default',
      enabled: true,
      maxAttempts: 3,
      rules: [],
    },
    ...overrides,
  }
}

function makeStatus(currentLoad = 0): ProviderStatus {
  return {
    available: true,
    currentLoad,
    queueLength: 0,
    activeRequests: 0,
    circuitState: 'closed',
  }
}

function makeMetrics(avgLatencyMs = 100): ProviderMetrics {
  return {
    provider: 'anthropic',
    timestamp: new Date(),
    avgLatencyMs,
    errorRate: 0,
    successRate: 1,
    load: 0,
    totalCost: 0,
    totalRequests: 10,
    availability: 1,
  }
}

// ============================================================================
// selectRoundRobin
// ============================================================================

describe('selectRoundRobin', () => {
  it('selects provider at roundRobinIndex % providers.length and increments index', () => {
    const providers: LLMProviderType[] = ['anthropic', 'openai', 'google']
    const result = selectRoundRobin(providers, 1)
    expect(result.provider).toBe('openai')
    expect(result.nextIndex).toBe(2)
  })

  it('wraps around using modulo', () => {
    const providers: LLMProviderType[] = ['anthropic', 'openai']
    const result = selectRoundRobin(providers, 4)
    expect(result.provider).toBe('anthropic') // 4 % 2 = 0
  })
})

// ============================================================================
// selectLeastLoaded
// ============================================================================

describe('selectLeastLoaded', () => {
  it('selects the provider with the lowest currentLoad', () => {
    const providers: LLMProviderType[] = ['anthropic', 'openai', 'google']
    const loads: Record<string, number> = { anthropic: 0.8, openai: 0.2, google: 0.5 }
    const getStatus = (p: LLMProviderType) => makeStatus(loads[p])
    expect(selectLeastLoaded(providers, getStatus)).toBe('openai')
  })
})

// ============================================================================
// selectByLatency
// ============================================================================

describe('selectByLatency', () => {
  it('selects the provider with the lowest avgLatencyMs', () => {
    const providers: LLMProviderType[] = ['anthropic', 'openai', 'google']
    const latencies: Record<string, number> = { anthropic: 300, openai: 100, google: 200 }
    const getMetrics = (p: LLMProviderType): ProviderMetrics =>
      makeMetrics(latencies[p] ?? Infinity)
    expect(selectByLatency(providers, getMetrics)).toBe('openai')
  })

  it('treats missing metrics as Infinity latency', () => {
    const providers: LLMProviderType[] = ['anthropic', 'openai']
    const getMetrics = (p: LLMProviderType) => (p === 'openai' ? makeMetrics(50) : undefined)
    expect(selectByLatency(providers, getMetrics)).toBe('openai')
  })
})

// ============================================================================
// selectByCost
// ============================================================================

describe('selectByCost', () => {
  it('selects the provider with the lowest combined cost per token', () => {
    const providers: LLMProviderType[] = ['anthropic', 'openai', 'google']
    const config = makeConfig()
    // google has 0.00025 + 0.0005 = 0.00075 (cheapest)
    expect(selectByCost(providers, config.providers)).toBe('google')
  })
})

// ============================================================================
// selectProvider
// ============================================================================

describe('selectProvider', () => {
  const available: LLMProviderType[] = ['anthropic', 'openai', 'google']
  const getStatus = (p: LLMProviderType) => makeStatus(p === 'openai' ? 0.1 : 0.9)
  const getMetrics = (p: LLMProviderType) => makeMetrics(p === 'google' ? 50 : 300)

  it('throws when available list is empty', () => {
    const config = makeConfig()
    expect(() => selectProvider({ messages: [] }, [], config, 0, getStatus, getMetrics)).toThrow(
      'No providers available'
    )
  })

  it('uses cost constraint branch when costConstraints.maxCost is set and costOptimization is enabled', () => {
    const config = makeConfig({ costOptimization: { enabled: true } })
    const result = selectProvider(
      { messages: [], costConstraints: { maxCost: 0.1 } },
      available,
      config,
      0,
      getStatus,
      getMetrics
    )
    // google is cheapest (0.00075 per token total)
    expect(result.provider).toBe('google')
    // round-robin index should be unchanged
    expect(result.nextRoundRobinIndex).toBe(0)
  })

  it('uses least-loaded strategy when load balancing is enabled with least-loaded', () => {
    const config = makeConfig({
      loadBalancing: { enabled: true, strategy: 'least-loaded' },
    })
    const result = selectProvider({ messages: [] }, available, config, 0, getStatus, getMetrics)
    expect(result.provider).toBe('openai') // lowest load (0.1)
  })

  it('uses latency-based strategy when load balancing is enabled with latency-based', () => {
    const config = makeConfig({
      loadBalancing: { enabled: true, strategy: 'latency-based' },
    })
    const result = selectProvider({ messages: [] }, available, config, 0, getStatus, getMetrics)
    expect(result.provider).toBe('google') // lowest latency (50ms)
  })

  it('uses cost-based strategy when load balancing is enabled with cost-based', () => {
    const config = makeConfig({
      loadBalancing: { enabled: true, strategy: 'cost-based' },
    })
    const result = selectProvider({ messages: [] }, available, config, 0, getStatus, getMetrics)
    expect(result.provider).toBe('google') // lowest cost
  })

  it('falls back to configured defaultProvider when load balancing is disabled', () => {
    const config = makeConfig({ loadBalancing: { enabled: false, strategy: 'round-robin' } })
    const result = selectProvider({ messages: [] }, available, config, 0, getStatus, getMetrics)
    expect(result.provider).toBe('anthropic') // default
  })

  it('falls back to first-available when defaultProvider is not in available list', () => {
    const config = makeConfig({
      defaultProvider: 'cohere',
      loadBalancing: { enabled: false, strategy: 'round-robin' },
    })
    const result = selectProvider(
      { messages: [] },
      ['openai', 'google'] as LLMProviderType[],
      config,
      0,
      getStatus,
      getMetrics
    )
    expect(result.provider).toBe('openai') // first available
  })
})

// ============================================================================
// getFallbackProvider
// ============================================================================

describe('getFallbackProvider', () => {
  const available: LLMProviderType[] = ['anthropic', 'openai', 'google']

  it('returns null when no rule matches the error condition', () => {
    const rules: FallbackRule[] = [
      {
        condition: 'rate_limit',
        fallbackProviders: ['openai'],
        retryOriginal: false,
      },
    ]
    // A generic error produces 'error' condition, no rule for that
    const result = getFallbackProvider('anthropic', new Error('generic fail'), rules, available)
    expect(result).toBeNull()
  })

  it('returns the first fallback provider that is not the current provider', () => {
    const rules: FallbackRule[] = [
      {
        condition: 'error',
        fallbackProviders: ['anthropic', 'openai', 'google'],
        retryOriginal: false,
      },
    ]
    // current=anthropic is excluded; openai is next available
    const result = getFallbackProvider('anthropic', new Error('provider error'), rules, available)
    expect(result).toBe('openai')
  })

  it('returns null when all fallback providers are either current or unavailable', () => {
    const rules: FallbackRule[] = [
      {
        condition: 'error',
        fallbackProviders: ['anthropic'], // only option is the current one
        retryOriginal: false,
      },
    ]
    const result = getFallbackProvider('anthropic', new Error('provider error'), rules, available)
    expect(result).toBeNull()
  })

  it('uses rate_limit condition when error message contains "rate limit"', () => {
    const rules: FallbackRule[] = [
      {
        condition: 'rate_limit',
        fallbackProviders: ['google'],
        retryOriginal: true,
      },
    ]
    const result = getFallbackProvider(
      'anthropic',
      new Error('rate limit exceeded'),
      rules,
      available
    )
    expect(result).toBe('google')
  })
})
