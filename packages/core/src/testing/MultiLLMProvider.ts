/**
 * @fileoverview Multi-LLM Provider Chain for Skill Compatibility Testing
 * @module @skillsmith/core/testing/MultiLLMProvider
 * @see SMI-1523: Configure multi-LLM provider chain
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

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Supported LLM providers
 */
export type LLMProviderType =
  | 'anthropic' // Claude
  | 'openai' // GPT
  | 'google' // Gemini
  | 'cohere' // Command
  | 'ollama' // Local models

/**
 * Provider priority for selection
 */
export type ProviderPriority = 'quality' | 'speed' | 'cost' | 'privacy'

/**
 * Load balancing strategies
 */
export type LoadBalanceStrategy = 'round-robin' | 'least-loaded' | 'latency-based' | 'cost-based'

/**
 * Failover condition triggers
 */
export type FailoverCondition = 'error' | 'rate_limit' | 'timeout' | 'cost' | 'unavailable'

/**
 * Provider configuration
 */
export interface ProviderConfig {
  /** Provider type */
  provider: LLMProviderType

  /** Model identifier */
  model: string

  /** API key (from environment) */
  apiKey?: string

  /** API URL (for Ollama/custom) */
  apiUrl?: string

  /** Whether provider is enabled */
  enabled: boolean

  /** Provider priority */
  priority: ProviderPriority

  /** Maximum concurrent requests */
  maxConcurrency?: number

  /** Request timeout in ms */
  timeoutMs?: number

  /** Cost per 1K tokens (input) */
  costPerInputToken?: number

  /** Cost per 1K tokens (output) */
  costPerOutputToken?: number
}

/**
 * Fallback rule configuration
 */
export interface FallbackRule {
  /** Condition that triggers fallback */
  condition: FailoverCondition

  /** Error codes that trigger this rule */
  errorCodes?: string[]

  /** Providers to try in order */
  fallbackProviders: LLMProviderType[]

  /** Fallback models (optional) */
  fallbackModels?: string[]

  /** Whether to retry original provider after cooling */
  retryOriginal: boolean

  /** Delay before retry in ms */
  retryDelayMs?: number
}

/**
 * Fallback strategy configuration
 */
export interface FallbackStrategy {
  /** Strategy name */
  name: string

  /** Whether fallback is enabled */
  enabled: boolean

  /** Fallback rules in priority order */
  rules: FallbackRule[]

  /** Maximum retry attempts */
  maxAttempts: number
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Request timeout in ms */
  timeoutMs: number

  /** Error percentage to open circuit */
  errorThresholdPercentage: number

  /** Time before trying half-open in ms */
  resetTimeoutMs: number

  /** Minimum requests before calculating error rate */
  volumeThreshold: number
}

/**
 * Multi-LLM provider configuration
 */
export interface MultiLLMProviderConfig {
  /** Provider configurations (optional, defaults available) */
  providers?: Partial<Record<LLMProviderType, ProviderConfig>>

  /** Default provider (optional, defaults to 'anthropic') */
  defaultProvider?: LLMProviderType

  /** Fallback strategy */
  fallbackStrategy?: FallbackStrategy

  /** Load balancing configuration */
  loadBalancing?: {
    enabled: boolean
    strategy: LoadBalanceStrategy
  }

  /** Cost optimization */
  costOptimization?: {
    enabled: boolean
    maxCostPerRequest?: number
    preferredProviders?: LLMProviderType[]
  }

  /** Circuit breaker configuration */
  circuitBreaker?: CircuitBreakerConfig

  /** Enable metrics collection */
  enableMetrics?: boolean

  /** Enable V3 ProviderManager integration */
  useV3Integration?: boolean
}

/**
 * Default multi-LLM provider configuration
 */
export const DEFAULT_MULTI_LLM_CONFIG: Required<
  Omit<MultiLLMProviderConfig, 'providers' | 'fallbackStrategy'>
> & {
  providers: Partial<Record<LLMProviderType, ProviderConfig>>
  fallbackStrategy: FallbackStrategy
} = {
  providers: {
    anthropic: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      enabled: true,
      priority: 'quality',
      maxConcurrency: 50,
      timeoutMs: 60000,
      costPerInputToken: 0.003,
      costPerOutputToken: 0.015,
    },
    openai: {
      provider: 'openai',
      model: 'gpt-4-turbo-preview',
      enabled: true,
      priority: 'speed',
      maxConcurrency: 100,
      timeoutMs: 30000,
      costPerInputToken: 0.01,
      costPerOutputToken: 0.03,
    },
    google: {
      provider: 'google',
      model: 'gemini-pro',
      enabled: true,
      priority: 'cost',
      maxConcurrency: 60,
      timeoutMs: 45000,
      costPerInputToken: 0.00025,
      costPerOutputToken: 0.0005,
    },
    cohere: {
      provider: 'cohere',
      model: 'command-r-plus',
      enabled: true,
      priority: 'cost',
      maxConcurrency: 40,
      timeoutMs: 45000,
      costPerInputToken: 0.003,
      costPerOutputToken: 0.015,
    },
    ollama: {
      provider: 'ollama',
      model: 'llama2',
      apiUrl: 'http://localhost:11434',
      enabled: false, // Disabled by default (requires local setup)
      priority: 'privacy',
      maxConcurrency: 10,
      timeoutMs: 120000,
      costPerInputToken: 0,
      costPerOutputToken: 0,
    },
  },
  defaultProvider: 'anthropic',
  fallbackStrategy: {
    name: 'resilient',
    enabled: true,
    maxAttempts: 3,
    rules: [
      {
        condition: 'rate_limit',
        fallbackProviders: ['openai', 'google', 'cohere'],
        retryOriginal: false,
        retryDelayMs: 5000,
      },
      {
        condition: 'unavailable',
        fallbackProviders: ['openai', 'google', 'cohere', 'ollama'],
        retryOriginal: true,
        retryDelayMs: 10000,
      },
      {
        condition: 'timeout',
        fallbackProviders: ['openai', 'google'],
        retryOriginal: false,
        retryDelayMs: 2000,
      },
      {
        condition: 'error',
        fallbackProviders: ['openai', 'google', 'cohere'],
        retryOriginal: false,
      },
    ],
  },
  loadBalancing: {
    enabled: true,
    strategy: 'cost-based',
  },
  costOptimization: {
    enabled: true,
    maxCostPerRequest: 0.05, // $0.05 max per request
    preferredProviders: ['google', 'cohere', 'anthropic'],
  },
  circuitBreaker: {
    timeoutMs: 30000,
    errorThresholdPercentage: 50,
    resetTimeoutMs: 30000,
    volumeThreshold: 10,
  },
  enableMetrics: true,
  useV3Integration: true,
}

/**
 * Provider health check result
 */
export interface HealthCheckResult {
  /** Whether provider is healthy */
  healthy: boolean

  /** Latency in ms */
  latencyMs?: number

  /** Error message if unhealthy */
  error?: string

  /** Check timestamp */
  timestamp: Date

  /** Additional details */
  details?: Record<string, unknown>
}

/**
 * Provider status
 */
export interface ProviderStatus {
  /** Whether provider is available */
  available: boolean

  /** Current load (0-1) */
  currentLoad: number

  /** Queue length */
  queueLength: number

  /** Active requests */
  activeRequests: number

  /** Rate limit remaining */
  rateLimitRemaining?: number

  /** Rate limit reset time */
  rateLimitReset?: Date

  /** Circuit breaker state */
  circuitState: 'closed' | 'open' | 'half-open'
}

/**
 * LLM request
 */
export interface LLMRequest {
  /** Messages */
  messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: string
  }>

  /** Model override */
  model?: string

  /** Provider override */
  provider?: LLMProviderType

  /** Max tokens */
  maxTokens?: number

  /** Temperature */
  temperature?: number

  /** Cost constraints */
  costConstraints?: {
    maxCost: number
  }

  /** Request metadata */
  metadata?: Record<string, unknown>
}

/**
 * LLM response
 */
export interface LLMResponse {
  /** Response content */
  content: string

  /** Provider that handled the request */
  provider: LLMProviderType

  /** Model used */
  model: string

  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }

  /** Cost estimate */
  cost: number

  /** Latency in ms */
  latencyMs: number

  /** Whether fallback was used */
  usedFallback: boolean

  /** Fallback chain (if used) */
  fallbackChain?: LLMProviderType[]
}

/**
 * Provider metrics
 */
export interface ProviderMetrics {
  /** Provider */
  provider: LLMProviderType

  /** Timestamp */
  timestamp: Date

  /** Average latency in ms */
  avgLatencyMs: number

  /** Error rate (0-1) */
  errorRate: number

  /** Success rate (0-1) */
  successRate: number

  /** Current load (0-1) */
  load: number

  /** Total cost */
  totalCost: number

  /** Total requests */
  totalRequests: number

  /** Availability (0-1) */
  availability: number
}

/**
 * Skill compatibility test result
 */
export interface SkillCompatibilityResult {
  /** Skill ID */
  skillId: string

  /** Results by provider */
  results: Record<
    LLMProviderType,
    {
      compatible: boolean
      score: number
      latencyMs: number
      error?: string
      notes?: string
    }
  >

  /** Overall compatibility score (0-1) */
  overallScore: number

  /** Recommended providers */
  recommendedProviders: LLMProviderType[]

  /** Test timestamp */
  testedAt: Date
}

// ============================================================================
// Circuit Breaker Implementation
// ============================================================================

/**
 * Simple circuit breaker for provider failover
 */
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed'
  private failures = 0
  private successes = 0
  private lastFailureTime: Date | null = null
  private totalRequests = 0

  constructor(private config: CircuitBreakerConfig) {}

  getState(): 'closed' | 'open' | 'half-open' {
    if (this.state === 'open' && this.lastFailureTime) {
      const elapsed = Date.now() - this.lastFailureTime.getTime()
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = 'half-open'
      }
    }
    return this.state
  }

  recordSuccess(): void {
    this.successes++
    this.totalRequests++
    if (this.state === 'half-open') {
      this.state = 'closed'
      this.failures = 0
    }
  }

  recordFailure(): void {
    this.failures++
    this.totalRequests++
    this.lastFailureTime = new Date()

    if (this.totalRequests >= this.config.volumeThreshold) {
      const errorRate = this.failures / this.totalRequests
      if (errorRate * 100 >= this.config.errorThresholdPercentage) {
        this.state = 'open'
      }
    }
  }

  canExecute(): boolean {
    const state = this.getState()
    return state === 'closed' || state === 'half-open'
  }

  reset(): void {
    this.state = 'closed'
    this.failures = 0
    this.successes = 0
    this.totalRequests = 0
    this.lastFailureTime = null
  }

  getMetrics(): { failures: number; successes: number; errorRate: number } {
    const errorRate = this.totalRequests > 0 ? this.failures / this.totalRequests : 0
    return {
      failures: this.failures,
      successes: this.successes,
      errorRate,
    }
  }
}

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
  private config: Required<Omit<MultiLLMProviderConfig, 'providers' | 'fallbackStrategy'>> & {
    providers: Partial<Record<LLMProviderType, ProviderConfig>>
    fallbackStrategy: FallbackStrategy
  }
  private initialized = false
  private circuitBreakers: Map<LLMProviderType, CircuitBreaker> = new Map()
  private providerMetrics: Map<LLMProviderType, ProviderMetrics> = new Map()
  private activeRequests: Map<LLMProviderType, number> = new Map()
  private roundRobinIndex = 0

  // V3 integration
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
      },
    }
  }

  /**
   * Initialize the multi-LLM provider
   */
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

    // Try V3 integration
    if (this.config.useV3Integration) {
      await this.initializeV3Integration()
    }

    this.initialized = true
    this.emit('initialized', {
      providers: this.getEnabledProviders(),
      defaultProvider: this.config.defaultProvider,
    })
  }

  /**
   * Check if provider is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Attempt to initialize V3 ProviderManager integration
   */
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

  /**
   * Get enabled providers
   */
  getEnabledProviders(): LLMProviderType[] {
    return Object.entries(this.config.providers)
      .filter(([, config]) => config?.enabled)
      .map(([type]) => type as LLMProviderType)
  }

  /**
   * Get available providers (enabled + circuit closed)
   */
  getAvailableProviders(): LLMProviderType[] {
    return this.getEnabledProviders().filter((provider) => {
      const breaker = this.circuitBreakers.get(provider)
      return breaker?.canExecute() ?? false
    })
  }

  /**
   * Check provider health
   */
  async healthCheck(provider: LLMProviderType): Promise<HealthCheckResult> {
    const startTime = Date.now()

    try {
      // Simple health check - attempt minimal completion
      const config = this.config.providers[provider]
      if (!config?.enabled) {
        return {
          healthy: false,
          error: 'Provider not enabled',
          timestamp: new Date(),
        }
      }

      // In production, this would make an actual API call
      // For now, return healthy if circuit is closed
      const breaker = this.circuitBreakers.get(provider)
      const healthy = breaker?.canExecute() ?? false

      return {
        healthy,
        latencyMs: Date.now() - startTime,
        timestamp: new Date(),
        details: {
          circuitState: breaker?.getState() ?? 'unknown',
          model: config.model,
        },
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

  /**
   * Get provider status
   */
  getProviderStatus(provider: LLMProviderType): ProviderStatus {
    const breaker = this.circuitBreakers.get(provider)
    const activeReqs = this.activeRequests.get(provider) ?? 0
    const config = this.config.providers[provider]
    const maxConcurrency = config?.maxConcurrency ?? 50

    return {
      available: breaker?.canExecute() ?? false,
      currentLoad: activeReqs / maxConcurrency,
      queueLength: 0, // Would be tracked in production
      activeRequests: activeReqs,
      circuitState: breaker?.getState() ?? 'closed',
    }
  }

  /**
   * Complete a request with automatic failover
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureInitialized()

    const startTime = Date.now()
    const provider = request.provider ?? this.selectProvider(request)
    const fallbackChain: LLMProviderType[] = []

    let currentProvider = provider
    let attempts = 0
    const maxAttempts = this.config.fallbackStrategy.maxAttempts

    while (attempts < maxAttempts) {
      attempts++

      try {
        const response = await this.executeRequest(currentProvider, request)

        // Record success
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
        // Record failure
        this.circuitBreakers.get(currentProvider)?.recordFailure()
        this.updateMetrics(currentProvider, {
          success: false,
          latencyMs: Date.now() - startTime,
        })

        this.emit('provider_error', { provider: currentProvider, error })

        // Get fallback provider
        const fallbackProvider = this.getFallbackProvider(currentProvider, error)
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

  /**
   * Test skill compatibility across providers
   */
  async testSkillCompatibility(skillId: string): Promise<SkillCompatibilityResult> {
    this.ensureInitialized()

    const results: SkillCompatibilityResult['results'] = {} as SkillCompatibilityResult['results']
    const enabledProviders = this.getEnabledProviders()

    const testPrompt = `Analyze if you can effectively help a user with a skill called "${skillId}".
    Respond with a brief assessment of your capability.`

    for (const provider of enabledProviders) {
      const startTime = Date.now()

      try {
        const response = await this.complete({
          messages: [{ role: 'user', content: testPrompt }],
          provider,
          maxTokens: 100,
        })

        results[provider] = {
          compatible: true,
          score: this.calculateCompatibilityScore(response),
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

    // Calculate overall score
    const scores = Object.values(results)
      .filter((r) => r.compatible)
      .map((r) => r.score)
    const overallScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

    // Recommend providers (compatible with score > 0.7)
    const recommendedProviders = Object.entries(results)
      .filter(([, r]) => r.compatible && r.score >= 0.7)
      .sort(([, a], [, b]) => b.score - a.score)
      .map(([p]) => p as LLMProviderType)

    return {
      skillId,
      results,
      overallScore,
      recommendedProviders,
      testedAt: new Date(),
    }
  }

  /**
   * Get provider metrics
   */
  getMetrics(): Map<LLMProviderType, ProviderMetrics> {
    return new Map(this.providerMetrics)
  }

  /**
   * Get aggregated metrics
   */
  getAggregatedMetrics(): {
    totalRequests: number
    totalCost: number
    avgLatencyMs: number
    avgSuccessRate: number
    providerBreakdown: Record<LLMProviderType, number>
  } {
    let totalRequests = 0
    let totalCost = 0
    let totalLatency = 0
    let totalSuccessRate = 0
    const providerBreakdown: Record<LLMProviderType, number> = {} as Record<LLMProviderType, number>

    for (const [provider, metrics] of this.providerMetrics) {
      totalRequests += metrics.totalRequests
      totalCost += metrics.totalCost
      totalLatency += metrics.avgLatencyMs * metrics.totalRequests
      totalSuccessRate += metrics.successRate
      providerBreakdown[provider] = metrics.totalRequests
    }

    const providerCount = this.providerMetrics.size

    return {
      totalRequests,
      totalCost,
      avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
      avgSuccessRate: providerCount > 0 ? totalSuccessRate / providerCount : 0,
      providerBreakdown,
    }
  }

  /**
   * Close and cleanup
   *
   * After close, the provider cannot be used until initialize() is called again.
   */
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

  private selectProvider(request: LLMRequest): LLMProviderType {
    const available = this.getAvailableProviders()
    if (available.length === 0) {
      throw new Error('No providers available')
    }

    // Cost constraint check
    if (request.costConstraints?.maxCost && this.config.costOptimization.enabled) {
      const costSorted = available.sort((a, b) => {
        const configA = this.config.providers[a]
        const configB = this.config.providers[b]
        const costA = (configA?.costPerInputToken ?? 0) + (configA?.costPerOutputToken ?? 0)
        const costB = (configB?.costPerInputToken ?? 0) + (configB?.costPerOutputToken ?? 0)
        return costA - costB
      })
      return costSorted[0]
    }

    // Load balancing
    if (this.config.loadBalancing.enabled) {
      switch (this.config.loadBalancing.strategy) {
        case 'round-robin':
          return this.selectRoundRobin(available)
        case 'least-loaded':
          return this.selectLeastLoaded(available)
        case 'latency-based':
          return this.selectByLatency(available)
        case 'cost-based':
          return this.selectByCost(available)
      }
    }

    // Default to configured default
    if (available.includes(this.config.defaultProvider)) {
      return this.config.defaultProvider
    }

    return available[0]
  }

  private selectRoundRobin(providers: LLMProviderType[]): LLMProviderType {
    const selected = providers[this.roundRobinIndex % providers.length]
    this.roundRobinIndex++
    return selected
  }

  private selectLeastLoaded(providers: LLMProviderType[]): LLMProviderType {
    return providers.reduce((best, current) => {
      const bestStatus = this.getProviderStatus(best)
      const currentStatus = this.getProviderStatus(current)
      return currentStatus.currentLoad < bestStatus.currentLoad ? current : best
    })
  }

  private selectByLatency(providers: LLMProviderType[]): LLMProviderType {
    return providers.reduce((best, current) => {
      const bestMetrics = this.providerMetrics.get(best)
      const currentMetrics = this.providerMetrics.get(current)
      const bestLatency = bestMetrics?.avgLatencyMs ?? Infinity
      const currentLatency = currentMetrics?.avgLatencyMs ?? Infinity
      return currentLatency < bestLatency ? current : best
    })
  }

  private selectByCost(providers: LLMProviderType[]): LLMProviderType {
    return providers.reduce((best, current) => {
      const configBest = this.config.providers[best]
      const configCurrent = this.config.providers[current]
      const costBest = (configBest?.costPerInputToken ?? 0) + (configBest?.costPerOutputToken ?? 0)
      const costCurrent =
        (configCurrent?.costPerInputToken ?? 0) + (configCurrent?.costPerOutputToken ?? 0)
      return costCurrent < costBest ? current : best
    })
  }

  private getFallbackProvider(
    currentProvider: LLMProviderType,
    error: unknown
  ): LLMProviderType | null {
    if (!this.config.fallbackStrategy.enabled) return null

    const condition = this.getErrorCondition(error)
    const rule = this.config.fallbackStrategy.rules.find((r) => r.condition === condition)

    if (!rule) return null

    const available = this.getAvailableProviders()
    for (const fallback of rule.fallbackProviders) {
      if (fallback !== currentProvider && available.includes(fallback)) {
        return fallback
      }
    }

    return null
  }

  private getErrorCondition(error: unknown): FailoverCondition {
    if (error instanceof Error) {
      const message = error.message.toLowerCase()
      if (message.includes('rate limit') || message.includes('429')) {
        return 'rate_limit'
      }
      if (message.includes('timeout') || message.includes('timed out')) {
        return 'timeout'
      }
      if (
        message.includes('unavailable') ||
        message.includes('503') ||
        message.includes('connection')
      ) {
        return 'unavailable'
      }
    }
    return 'error'
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

    // Increment active requests
    const current = this.activeRequests.get(provider) ?? 0
    this.activeRequests.set(provider, current + 1)

    try {
      // Simulate request execution
      // In production, this would make actual API calls
      await this.simulateRequest(config)

      const latencyMs = Date.now() - startTime
      const inputTokens = this.estimateTokens(request.messages.map((m) => m.content).join(' '))
      const outputTokens = 100 // Simulated

      return {
        content: `[Simulated response from ${provider}]`,
        provider,
        model: request.model ?? config.model,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        cost: this.calculateCost(config, inputTokens, outputTokens),
        latencyMs,
        usedFallback: false,
      }
    } finally {
      // Decrement active requests
      const currentAfter = this.activeRequests.get(provider) ?? 1
      this.activeRequests.set(provider, Math.max(0, currentAfter - 1))
    }
  }

  private async simulateRequest(_config: ProviderConfig): Promise<void> {
    // Simulate network latency (50-200ms)
    // In production, this would use _config to make actual API calls
    const latency = 50 + Math.random() * 150
    await new Promise((resolve) => setTimeout(resolve, latency))

    // Simulate occasional failures (5% rate)
    if (Math.random() < 0.05) {
      throw new Error('Simulated provider error')
    }
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4)
  }

  private calculateCost(config: ProviderConfig, inputTokens: number, outputTokens: number): number {
    const inputCost = ((config.costPerInputToken ?? 0) * inputTokens) / 1000
    const outputCost = ((config.costPerOutputToken ?? 0) * outputTokens) / 1000
    return inputCost + outputCost
  }

  private calculateCompatibilityScore(response: LLMResponse): number {
    // Simple scoring based on latency and success
    // Lower latency = higher score, max score 1.0
    const latencyScore = Math.max(0, 1 - response.latencyMs / 5000)
    return Math.min(1, latencyScore + 0.3) // Base 0.3 for successful response
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

    // Update cost
    if (update.cost) {
      metrics.totalCost += update.cost
    }

    // Update load
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
 *
 * @param config - Configuration options
 * @returns Initialized MultiLLMProvider
 */
export async function createMultiLLMProvider(
  config: MultiLLMProviderConfig = {}
): Promise<MultiLLMProvider> {
  const provider = new MultiLLMProvider(config)
  await provider.initialize()
  return provider
}
