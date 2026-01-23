/**
 * Multi-LLM Provider Helper Functions and Classes
 * @module @skillsmith/core/testing/MultiLLMProvider.helpers
 */

import type {
  CircuitBreakerConfig,
  ProviderConfig,
  FailoverCondition,
  LLMResponse,
} from './MultiLLMProvider.types.js'

// ============================================================================
// Circuit Breaker Implementation
// ============================================================================

/** Circuit breaker state type */
export type CircuitState = 'closed' | 'open' | 'half-open'

/** Circuit breaker metrics */
export interface CircuitBreakerMetrics {
  failures: number
  successes: number
  errorRate: number
}

/**
 * Simple circuit breaker for provider failover
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failures = 0
  private successes = 0
  private lastFailureTime: Date | null = null
  private totalRequests = 0

  constructor(private config: CircuitBreakerConfig) {}

  getState(): CircuitState {
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

  getMetrics(): CircuitBreakerMetrics {
    const errorRate = this.totalRequests > 0 ? this.failures / this.totalRequests : 0
    return {
      failures: this.failures,
      successes: this.successes,
      errorRate,
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Determine error condition from error object
 */
export function getErrorCondition(error: unknown): FailoverCondition {
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

/**
 * Estimate token count from text
 * Rough estimate: ~4 characters per token
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Calculate cost from token counts
 */
export function calculateCost(
  config: ProviderConfig,
  inputTokens: number,
  outputTokens: number
): number {
  const inputCost = ((config.costPerInputToken ?? 0) * inputTokens) / 1000
  const outputCost = ((config.costPerOutputToken ?? 0) * outputTokens) / 1000
  return inputCost + outputCost
}

/**
 * Calculate compatibility score from response
 * Simple scoring based on latency and success
 */
export function calculateCompatibilityScore(response: LLMResponse): number {
  // Lower latency = higher score, max score 1.0
  const latencyScore = Math.max(0, 1 - response.latencyMs / 5000)
  return Math.min(1, latencyScore + 0.3) // Base 0.3 for successful response
}

/**
 * Simulate network request (for testing)
 */
export async function simulateRequest(_config: ProviderConfig): Promise<void> {
  // Simulate network latency (50-200ms)
  // In production, this would use _config to make actual API calls
  const latency = 50 + Math.random() * 150
  await new Promise((resolve) => setTimeout(resolve, latency))

  // Simulate occasional failures (5% rate)
  if (Math.random() < 0.05) {
    throw new Error('Simulated provider error')
  }
}
