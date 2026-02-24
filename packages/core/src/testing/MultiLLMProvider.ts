/**
 * @fileoverview Multi-LLM Provider Chain for Skill Compatibility Testing
 * @module @skillsmith/core/testing/MultiLLMProvider
 * @see SMI-1523: Configure multi-LLM provider chain
 * @see SMI-2741: Split to meet 500-line standard
 *
 * Provides a unified interface for testing skills across multiple LLM providers:
 * - Claude (Anthropic) - Primary
 * - GPT (OpenAI) - Fallback 1
 * - Gemini (Google) - Fallback 2
 * - Cohere (Command) - Fallback 3
 * - Ollama (Local) - Fallback 4
 *
 * Features:
 * - Automatic failover with configurable strategy
 * - Health monitoring and circuit breaker pattern
 * - Cost-aware provider selection
 * - Skill compatibility testing across providers
 */

import { EventEmitter } from 'events'

// Re-export types for public API
export type {
  LLMProviderType,
  ProviderPriority,
  LoadBalanceStrategy,
  FailoverCondition,
  ProviderConfig,
  FallbackRule,
  FallbackStrategy,
  CircuitBreakerConfig,
  MultiLLMProviderConfig,
  HealthCheckResult,
  ProviderStatus,
  LLMRequest,
  LLMResponse,
  ProviderMetrics,
  SkillCompatibilityResult,
  ResolvedMultiLLMConfig,
} from './MultiLLMProvider.types.js'
export { DEFAULT_MULTI_LLM_CONFIG } from './MultiLLMProvider.types.js'

// Re-export helpers for consumers
export {
  CircuitBreaker,
  getErrorCondition,
  estimateTokens,
  calculateCost,
  calculateCompatibilityScore,
} from './MultiLLMProvider.helpers.js'
export type { CircuitState, CircuitBreakerMetrics } from './MultiLLMProvider.helpers.js'

// Re-export selection utilities for consumers
export {
  selectProvider,
  selectRoundRobin,
  selectLeastLoaded,
  selectByLatency,
  selectByCost,
  getFallbackProvider,
} from './MultiLLMProvider.selection.js'

// Re-export metrics utilities for consumers
export { aggregateMetrics, runCompatibilityTest } from './MultiLLMProvider.metrics.js'

// Internal imports
import type {
  LLMProviderType,
  MultiLLMProviderConfig,
  FallbackStrategy,
  HealthCheckResult,
  ProviderStatus,
  LLMRequest,
  LLMResponse,
  ProviderMetrics,
  SkillCompatibilityResult,
  ResolvedMultiLLMConfig,
} from './MultiLLMProvider.types.js'
import { DEFAULT_MULTI_LLM_CONFIG } from './MultiLLMProvider.types.js'
import {
  CircuitBreaker,
  estimateTokens,
  calculateCost,
  simulateRequest,
} from './MultiLLMProvider.helpers.js'
import { selectProvider, getFallbackProvider } from './MultiLLMProvider.selection.js'
import { aggregateMetrics, runCompatibilityTest } from './MultiLLMProvider.metrics.js'

// ============================================================================
// Multi-LLM Provider Implementation
// ============================================================================

/**
 * Multi-LLM Provider for skill compatibility testing
 *
 * Provides unified access to multiple LLM providers with automatic failover,
 * load balancing, and cost optimization.
 *
 * @example
 * ```typescript
 * const provider = new MultiLLMProvider()
 * await provider.initialize()
 *
 * // Complete a request with automatic failover
 * const response = await provider.complete({
 *   messages: [{ role: 'user', content: 'Explain this skill' }]
 * })
 *
 * // Test skill compatibility across providers
 * const compatibility = await provider.testSkillCompatibility('commit')
 * ```
 */
export class MultiLLMProvider extends EventEmitter {
  private config: ResolvedMultiLLMConfig
  private initialized = false
  private circuitBreakers: Map<LLMProviderType, CircuitBreaker> = new Map()
  private providerMetrics: Map<LLMProviderType, ProviderMetrics> = new Map()
  private activeRequests: Map<LLMProviderType, number> = new Map()
  private roundRobinIndex = 0

  // IMPORTANT: Keep V3 integration here for lazy loading / graceful degradation
  private v3ProviderManager: unknown = null

  constructor(config: MultiLLMProviderConfig = {}) {
    super()
    this.config = {
      ...DEFAULT_MULTI_LLM_CONFIG,
      ...config,
      providers: { ...DEFAULT_MULTI_LLM_CONFIG.providers, ...config.providers },
      fallbackStrategy: {
        ...DEFAULT_MULTI_LLM_CONFIG.fallbackStrategy,
        ...config.fallbackStrategy,
      } as FallbackStrategy,
    }
  }

  /** Initialize the multi-LLM provider */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // Initialize circuit breakers for each enabled provider
    for (const [providerType, providerConfig] of Object.entries(this.config.providers)) {
      if (providerConfig?.enabled) {
        this.circuitBreakers.set(
          providerType as LLMProviderType,
          new CircuitBreaker(this.config.circuitBreaker)
        )
        this.activeRequests.set(providerType as LLMProviderType, 0)
        this.initializeMetrics(providerType as LLMProviderType)
      }
    }

    // IMPORTANT: Keep dynamic import here for V3 lazy loading / graceful degradation
    if (this.config.useV3Integration) {
      await this.initializeV3Integration()
    }

    this.initialized = true
    this.emit('initialized', {
      providers: this.getEnabledProviders(),
      defaultProvider: this.config.defaultProvider,
    })
  }

  /** Check if provider is initialized */
  isInitialized(): boolean {
    return this.initialized
  }

  /** Get enabled providers */
  getEnabledProviders(): LLMProviderType[] {
    return Object.entries(this.config.providers)
      .filter(([, config]) => config?.enabled)
      .map(([type]) => type as LLMProviderType)
  }

  /** Get available providers (enabled + circuit closed) */
  getAvailableProviders(): LLMProviderType[] {
    return this.getEnabledProviders().filter((provider) => {
      const breaker = this.circuitBreakers.get(provider)
      return breaker?.canExecute() ?? false
    })
  }

  /** Check provider health */
  async healthCheck(provider: LLMProviderType): Promise<HealthCheckResult> {
    const startTime = Date.now()

    try {
      const config = this.config.providers[provider]
      if (!config?.enabled) {
        return { healthy: false, error: 'Provider not enabled', timestamp: new Date() }
      }

      const breaker = this.circuitBreakers.get(provider)
      const healthy = breaker?.canExecute() ?? false

      return {
        healthy,
        latencyMs: Date.now() - startTime,
        timestamp: new Date(),
        details: { circuitState: breaker?.getState() ?? 'unknown', model: config.model },
      }
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      }
    }
  }

  /** Get provider status */
  getProviderStatus(provider: LLMProviderType): ProviderStatus {
    const breaker = this.circuitBreakers.get(provider)
    const activeReqs = this.activeRequests.get(provider) ?? 0
    const config = this.config.providers[provider]
    const maxConcurrency = config?.maxConcurrency ?? 50

    return {
      available: breaker?.canExecute() ?? false,
      currentLoad: activeReqs / maxConcurrency,
      queueLength: 0,
      activeRequests: activeReqs,
      circuitState: breaker?.getState() ?? 'closed',
    }
  }

  /** Complete a request with automatic failover */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureInitialized()

    const startTime = Date.now()
    const provider = request.provider ?? this.doSelectProvider(request)
    const fallbackChain: LLMProviderType[] = []

    let currentProvider = provider
    let attempts = 0
    const maxAttempts = this.config.fallbackStrategy.maxAttempts

    while (attempts < maxAttempts) {
      attempts++

      try {
        const response = await this.executeRequest(currentProvider, request)

        this.circuitBreakers.get(currentProvider)?.recordSuccess()
        this.updateMetrics(currentProvider, {
          success: true,
          latencyMs: Date.now() - startTime,
          cost: response.cost,
        })

        return {
          ...response,
          usedFallback: fallbackChain.length > 0,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        }
      } catch (error) {
        this.circuitBreakers.get(currentProvider)?.recordFailure()
        this.updateMetrics(currentProvider, { success: false, latencyMs: Date.now() - startTime })
        this.emit('provider_error', { provider: currentProvider, error })

        const fallbackProvider = this.doGetFallbackProvider(currentProvider, error)
        if (fallbackProvider && attempts < maxAttempts) {
          fallbackChain.push(currentProvider)
          currentProvider = fallbackProvider
          continue
        }

        throw error
      }
    }

    throw new Error(`All providers failed after ${maxAttempts} attempts`)
  }

  /** Test skill compatibility across providers */
  async testSkillCompatibility(skillId: string): Promise<SkillCompatibilityResult> {
    this.ensureInitialized()
    return runCompatibilityTest(skillId, this.getEnabledProviders(), (req) => this.complete(req))
  }

  /** Get provider metrics */
  getMetrics(): Map<LLMProviderType, ProviderMetrics> {
    return new Map(this.providerMetrics)
  }

  /** Get aggregated metrics */
  getAggregatedMetrics(): {
    totalRequests: number
    totalCost: number
    avgLatencyMs: number
    avgSuccessRate: number
    providerBreakdown: Record<LLMProviderType, number>
  } {
    return aggregateMetrics(this.providerMetrics)
  }

  /** Close and cleanup */
  close(): void {
    this.circuitBreakers.clear()
    this.providerMetrics.clear()
    this.activeRequests.clear()
    this.removeAllListeners()
    this.initialized = false
    this.v3ProviderManager = null
    this.roundRobinIndex = 0
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MultiLLMProvider not initialized. Call initialize() first.')
    }
  }

  // IMPORTANT: Keep dynamic import here for V3 lazy loading / graceful degradation
  private async initializeV3Integration(): Promise<void> {
    try {
      const { ProviderManager } = await import(
        // @ts-expect-error - V3 types not available at compile time
        'claude-flow/providers'
      )

      this.v3ProviderManager = new ProviderManager(console, null, {
        providers: this.config.providers,
        defaultProvider: this.config.defaultProvider,
        fallbackStrategy: this.config.fallbackStrategy,
        loadBalancing: this.config.loadBalancing,
        costOptimization: this.config.costOptimization,
        monitoring: { enabled: this.config.enableMetrics, metricsInterval: 60000 },
      })

      this.emit('v3_integration', { enabled: true })
    } catch {
      this.emit('v3_integration', { enabled: false, reason: 'V3 not available' })
    }
  }

  private doSelectProvider(request: LLMRequest): LLMProviderType {
    const available = this.getAvailableProviders()
    const result = selectProvider(
      request,
      available,
      this.config,
      this.roundRobinIndex,
      (p) => this.getProviderStatus(p),
      (p) => this.providerMetrics.get(p)
    )
    this.roundRobinIndex = result.nextRoundRobinIndex
    return result.provider
  }

  private doGetFallbackProvider(
    currentProvider: LLMProviderType,
    error: unknown
  ): LLMProviderType | null {
    if (!this.config.fallbackStrategy.enabled) return null
    const available = this.getAvailableProviders()
    return getFallbackProvider(
      currentProvider,
      error,
      this.config.fallbackStrategy.rules,
      available
    )
  }

  private async executeRequest(
    provider: LLMProviderType,
    request: LLMRequest
  ): Promise<LLMResponse> {
    const config = this.config.providers[provider]
    if (!config) {
      throw new Error(`Provider ${provider} not configured`)
    }

    const startTime = Date.now()

    const current = this.activeRequests.get(provider) ?? 0
    this.activeRequests.set(provider, current + 1)

    try {
      await simulateRequest(config)

      const latencyMs = Date.now() - startTime
      const inputTokens = estimateTokens(request.messages.map((m) => m.content).join(' '))
      const outputTokens = 100 // Simulated

      return {
        content: `[Simulated response from ${provider}]`,
        provider,
        model: request.model ?? config.model,
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        cost: calculateCost(config, inputTokens, outputTokens),
        latencyMs,
        usedFallback: false,
      }
    } finally {
      const currentAfter = this.activeRequests.get(provider) ?? 1
      this.activeRequests.set(provider, Math.max(0, currentAfter - 1))
    }
  }

  private initializeMetrics(provider: LLMProviderType): void {
    this.providerMetrics.set(provider, {
      provider,
      timestamp: new Date(),
      avgLatencyMs: 0,
      errorRate: 0,
      successRate: 1,
      load: 0,
      totalCost: 0,
      totalRequests: 0,
      availability: 1,
    })
  }

  private updateMetrics(
    provider: LLMProviderType,
    update: { success: boolean; latencyMs: number; cost?: number }
  ): void {
    const metrics = this.providerMetrics.get(provider)
    if (!metrics) return

    metrics.totalRequests++
    metrics.timestamp = new Date()

    // Rolling average for latency
    metrics.avgLatencyMs =
      (metrics.avgLatencyMs * (metrics.totalRequests - 1) + update.latencyMs) /
      metrics.totalRequests

    // Update success/error rates
    const breaker = this.circuitBreakers.get(provider)
    if (breaker) {
      const breakerMetrics = breaker.getMetrics()
      metrics.errorRate = breakerMetrics.errorRate
      metrics.successRate = 1 - breakerMetrics.errorRate
    }

    if (update.cost) {
      metrics.totalCost += update.cost
    }

    const status = this.getProviderStatus(provider)
    metrics.load = status.currentLoad

    this.emit('metrics', metrics)
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and initialize a MultiLLMProvider instance
 */
export async function createMultiLLMProvider(
  config: MultiLLMProviderConfig = {}
): Promise<MultiLLMProvider> {
  const provider = new MultiLLMProvider(config)
  await provider.initialize()
  return provider
}
