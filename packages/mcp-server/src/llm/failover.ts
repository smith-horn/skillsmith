/**
 * @fileoverview LLM Failover Chain for MCP Server
 * @module @skillsmith/mcp-server/llm/failover
 * @see SMI-1524: Implement LLM failover with circuit breaker
 *
 * Provides LLM failover capability for MCP tool handlers with:
 * - Automatic provider failover on errors
 * - Circuit breaker pattern for fault tolerance
 * - Health check endpoints for monitoring
 * - Cost-aware provider selection
 *
 * Wraps the core MultiLLMProvider for MCP server integration.
 *
 * @example
 * ```typescript
 * // Initialize in tool context
 * const failover = new LLMFailoverChain()
 * await failover.initialize()
 *
 * // Use in tool handlers
 * const response = await failover.complete({
 *   messages: [{ role: 'user', content: 'Analyze this skill' }]
 * })
 *
 * // Check health
 * const health = await failover.healthCheck()
 * ```
 */

import {
  MultiLLMProvider,
  createMultiLLMProvider,
  type MultiLLMProviderConfig,
  type LLMProviderType,
  type LLMRequest,
  type LLMResponse,
  type HealthCheckResult,
  type ProviderStatus,
  type ProviderMetrics,
  type SkillCompatibilityResult,
} from '@skillsmith/core/testing'

// Re-export types for convenience
export type {
  LLMProviderType,
  LLMRequest,
  LLMResponse,
  HealthCheckResult,
  ProviderStatus,
  ProviderMetrics,
  SkillCompatibilityResult,
}

/**
 * Configuration for LLMFailoverChain
 */
export interface LLMFailoverConfig extends MultiLLMProviderConfig {
  /**
   * Enable the failover chain (default: true)
   * Can be disabled via SKILLSMITH_LLM_FAILOVER_ENABLED=false
   */
  enabled?: boolean

  /**
   * Failover timeout in ms (default: 3000)
   * Maximum time before attempting failover
   * @see SMI-1524 Acceptance Criteria: Failover triggers within 3 seconds
   */
  failoverTimeoutMs?: number

  /**
   * Number of failures before circuit opens (default: 5)
   * @see SMI-1524 Acceptance Criteria: Circuit breaker opens after 5 failures
   */
  circuitOpenThreshold?: number

  /**
   * Circuit reset timeout in ms (default: 60000)
   * @see SMI-1524 Acceptance Criteria: Circuit resets after 60 seconds
   */
  circuitResetTimeoutMs?: number

  /**
   * Enable debug logging
   */
  debug?: boolean
}

/**
 * LLMFailover-specific config properties (not from MultiLLMProviderConfig)
 */
type LLMFailoverOwnConfig = {
  enabled: boolean
  failoverTimeoutMs: number
  circuitOpenThreshold: number
  circuitResetTimeoutMs: number
  debug: boolean
}

/**
 * Default configuration for MCP server LLM failover
 * Tuned for SMI-1524 acceptance criteria
 */
export const DEFAULT_LLM_FAILOVER_CONFIG: LLMFailoverOwnConfig = {
  enabled: true,
  failoverTimeoutMs: 3000, // 3 seconds per acceptance criteria
  circuitOpenThreshold: 5, // 5 failures per acceptance criteria
  circuitResetTimeoutMs: 60000, // 60 seconds per acceptance criteria
  debug: false,
}

/**
 * Health status for the failover chain
 */
export interface FailoverHealthStatus {
  /** Overall health */
  healthy: boolean

  /** Timestamp of health check */
  timestamp: Date

  /** Number of available providers */
  availableProviders: number

  /** Number of enabled providers */
  enabledProviders: number

  /** Per-provider health results */
  providers: Record<LLMProviderType, HealthCheckResult>

  /** Circuit breaker states */
  circuitStates: Record<LLMProviderType, 'closed' | 'open' | 'half-open'>

  /** Overall error rate */
  errorRate: number

  /** Average latency in ms */
  avgLatencyMs: number
}

/**
 * LLM Failover Chain for MCP Server
 *
 * Provides fault-tolerant LLM access for MCP tool handlers with automatic
 * failover, circuit breaker protection, and health monitoring.
 *
 * @example
 * ```typescript
 * const failover = new LLMFailoverChain({
 *   failoverTimeoutMs: 3000,
 *   circuitOpenThreshold: 5,
 *   circuitResetTimeoutMs: 60000
 * })
 *
 * await failover.initialize()
 *
 * // Complete a request with automatic failover
 * const response = await failover.complete({
 *   messages: [{ role: 'user', content: 'Help me understand this skill' }]
 * })
 *
 * // Get comprehensive health status
 * const health = await failover.getHealthStatus()
 * ```
 */
export class LLMFailoverChain {
  private provider: MultiLLMProvider | null = null
  private config: LLMFailoverOwnConfig & MultiLLMProviderConfig
  private initialized = false
  private enabled: boolean
  private initializationPromise: Promise<void> | null = null

  constructor(config: LLMFailoverConfig = {}) {
    // Check environment variable for enable/disable
    const envEnabled = process.env.SKILLSMITH_LLM_FAILOVER_ENABLED
    this.enabled = envEnabled !== 'false' && config.enabled !== false

    // Merge configuration with defaults
    this.config = {
      ...DEFAULT_LLM_FAILOVER_CONFIG,
      ...config,
      // Override circuit breaker config to match SMI-1524 acceptance criteria
      circuitBreaker: {
        timeoutMs: config.failoverTimeoutMs ?? DEFAULT_LLM_FAILOVER_CONFIG.failoverTimeoutMs,
        errorThresholdPercentage: 50,
        resetTimeoutMs:
          config.circuitResetTimeoutMs ?? DEFAULT_LLM_FAILOVER_CONFIG.circuitResetTimeoutMs,
        volumeThreshold:
          config.circuitOpenThreshold ?? DEFAULT_LLM_FAILOVER_CONFIG.circuitOpenThreshold,
        ...config.circuitBreaker,
      },
    }

    if (this.config.debug) {
      console.log('[LLMFailoverChain] Configuration:', {
        enabled: this.enabled,
        failoverTimeoutMs: this.config.failoverTimeoutMs,
        circuitOpenThreshold: this.config.circuitOpenThreshold,
        circuitResetTimeoutMs: this.config.circuitResetTimeoutMs,
      })
    }
  }

  /**
   * Initialize the failover chain
   *
   * Must be called before using complete() or other methods.
   * Safe to call multiple times - will return existing promise if initialization is in progress.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // Return existing initialization promise if already in progress
    if (this.initializationPromise) {
      return this.initializationPromise
    }

    // Create and store the initialization promise
    this.initializationPromise = this.doInitialize()
    return this.initializationPromise
  }

  private async doInitialize(): Promise<void> {
    if (!this.enabled) {
      if (this.config.debug) {
        console.log('[LLMFailoverChain] Disabled - skipping initialization')
      }
      this.initialized = true
      return
    }

    this.provider = await createMultiLLMProvider(this.config)

    // Set up event listeners for debugging
    if (this.config.debug) {
      this.provider.on(
        'initialized',
        (data: { providers: LLMProviderType[]; defaultProvider: LLMProviderType }) => {
          console.log('[LLMFailoverChain] Provider initialized:', data)
        }
      )

      this.provider.on('provider_error', (data: { provider: LLMProviderType; error: Error }) => {
        console.log('[LLMFailoverChain] Provider error:', data)
      })

      this.provider.on('metrics', (metrics: ProviderMetrics) => {
        console.log('[LLMFailoverChain] Metrics:', metrics)
      })
    }

    this.initialized = true

    if (this.config.debug) {
      console.log('[LLMFailoverChain] Initialized successfully')
    }
  }

  /**
   * Check if the failover chain is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Check if the failover chain is enabled
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Complete an LLM request with automatic failover
   *
   * @param request - The LLM request
   * @returns The LLM response
   * @throws Error if not initialized or all providers fail
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    await this.ensureInitialized()

    if (!this.enabled || !this.provider) {
      throw new Error('LLM failover chain is disabled')
    }

    return this.provider.complete(request)
  }

  /**
   * Test skill compatibility across all providers
   *
   * @param skillId - The skill ID to test
   * @returns Compatibility results for each provider
   */
  async testSkillCompatibility(skillId: string): Promise<SkillCompatibilityResult> {
    await this.ensureInitialized()

    if (!this.enabled || !this.provider) {
      throw new Error('LLM failover chain is disabled')
    }

    return this.provider.testSkillCompatibility(skillId)
  }

  /**
   * Health check for a specific provider
   *
   * @param provider - The provider to check
   * @returns Health check result
   */
  async healthCheck(provider: LLMProviderType): Promise<HealthCheckResult> {
    await this.ensureInitialized()

    if (!this.enabled || !this.provider) {
      return {
        healthy: false,
        error: 'LLM failover chain is disabled',
        timestamp: new Date(),
      }
    }

    return this.provider.healthCheck(provider)
  }

  /**
   * Get comprehensive health status for all providers
   * @see SMI-1524 Acceptance Criteria: Health check endpoint available
   *
   * @returns Complete health status
   */
  async getHealthStatus(): Promise<FailoverHealthStatus> {
    if (!this.initialized) {
      return {
        healthy: false,
        timestamp: new Date(),
        availableProviders: 0,
        enabledProviders: 0,
        providers: {} as Record<LLMProviderType, HealthCheckResult>,
        circuitStates: {} as Record<LLMProviderType, 'closed' | 'open' | 'half-open'>,
        errorRate: 1,
        avgLatencyMs: 0,
      }
    }

    if (!this.enabled || !this.provider) {
      return {
        healthy: false,
        timestamp: new Date(),
        availableProviders: 0,
        enabledProviders: 0,
        providers: {} as Record<LLMProviderType, HealthCheckResult>,
        circuitStates: {} as Record<LLMProviderType, 'closed' | 'open' | 'half-open'>,
        errorRate: 0,
        avgLatencyMs: 0,
      }
    }

    const enabledProviders = this.provider.getEnabledProviders()
    const availableProviders = this.provider.getAvailableProviders()

    // Get health status for each enabled provider
    const providers: Record<LLMProviderType, HealthCheckResult> = {} as Record<
      LLMProviderType,
      HealthCheckResult
    >
    const circuitStates: Record<LLMProviderType, 'closed' | 'open' | 'half-open'> = {} as Record<
      LLMProviderType,
      'closed' | 'open' | 'half-open'
    >

    for (const provider of enabledProviders) {
      providers[provider] = await this.provider.healthCheck(provider)
      const status = this.provider.getProviderStatus(provider)
      circuitStates[provider] = status.circuitState
    }

    // Calculate aggregate metrics
    const metrics = this.provider.getAggregatedMetrics()
    const healthyProviders = Object.values(providers).filter((p) => p.healthy).length

    return {
      healthy: healthyProviders > 0,
      timestamp: new Date(),
      availableProviders: availableProviders.length,
      enabledProviders: enabledProviders.length,
      providers,
      circuitStates,
      errorRate: 1 - metrics.avgSuccessRate,
      avgLatencyMs: metrics.avgLatencyMs,
    }
  }

  /**
   * Get provider status
   *
   * @param provider - The provider to check
   * @returns Provider status
   */
  getProviderStatus(provider: LLMProviderType): ProviderStatus | null {
    if (!this.enabled || !this.provider) {
      return null
    }

    return this.provider.getProviderStatus(provider)
  }

  /**
   * Get all enabled providers
   */
  getEnabledProviders(): LLMProviderType[] {
    if (!this.enabled || !this.provider) {
      return []
    }

    return this.provider.getEnabledProviders()
  }

  /**
   * Get all available providers (enabled with closed circuit)
   */
  getAvailableProviders(): LLMProviderType[] {
    if (!this.enabled || !this.provider) {
      return []
    }

    return this.provider.getAvailableProviders()
  }

  /**
   * Get metrics for all providers
   */
  getMetrics(): Map<LLMProviderType, ProviderMetrics> {
    if (!this.enabled || !this.provider) {
      return new Map()
    }

    return this.provider.getMetrics()
  }

  /**
   * Close the failover chain and release resources
   */
  close(): void {
    if (this.provider) {
      this.provider.close()
      this.provider = null
    }
    this.initialized = false
  }

  /**
   * Ensure the failover chain is initialized, waiting if initialization is in progress.
   * This handles the race condition where complete() is called while initialize() is running.
   */
  private async ensureInitialized(): Promise<void> {
    // If initialized, return immediately
    if (this.initialized) return

    // If initialization is in progress, wait for it
    if (this.initializationPromise) {
      await this.initializationPromise
      return
    }

    // Not initialized and no initialization in progress
    throw new Error('LLMFailoverChain not initialized. Call initialize() first.')
  }
}

/**
 * Create and initialize an LLMFailoverChain instance
 *
 * @param config - Configuration options
 * @returns Initialized LLMFailoverChain
 */
export async function createLLMFailoverChain(
  config: LLMFailoverConfig = {}
): Promise<LLMFailoverChain> {
  const chain = new LLMFailoverChain(config)
  await chain.initialize()
  return chain
}
