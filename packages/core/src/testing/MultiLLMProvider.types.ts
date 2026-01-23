/**
 * Multi-LLM Provider Type Definitions
 * @module @skillsmith/core/testing/MultiLLMProvider.types
 */

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
// Default Configuration
// ============================================================================

/** Full configuration type with required fields */
export type ResolvedMultiLLMConfig = Required<
  Omit<MultiLLMProviderConfig, 'providers' | 'fallbackStrategy'>
> & {
  providers: Partial<Record<LLMProviderType, ProviderConfig>>
  fallbackStrategy: FallbackStrategy
}

/**
 * Default multi-LLM provider configuration
 */
export const DEFAULT_MULTI_LLM_CONFIG: ResolvedMultiLLMConfig = {
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
