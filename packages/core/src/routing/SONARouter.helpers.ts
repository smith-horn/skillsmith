/**
 * SONARouter Helper Classes and Functions
 * @module @skillsmith/core/routing/SONARouter.helpers
 */

import type {
  ExpertId,
  RoutingDecision,
  SONAMetrics,
  SONARouterConfig,
  ToolType,
} from './types.js'

// ============================================================================
// V3 MoE Types (from claude-flow)
// ============================================================================

/**
 * V3 MoERouter result type
 */
export interface V3RoutingResult {
  experts: Array<{
    name: string
    index: number
    weight: number
    score: number
  }>
  allScores: number[]
  loadBalanceLoss: number
  entropy: number
}

/**
 * V3 MoERouter interface
 */
export interface V3MoERouter {
  initialize(): Promise<void>
  route(embedding: Float32Array | number[]): V3RoutingResult
  updateExpertWeights(expert: string | number, reward: number): void
  getStats(): Record<string, number | string>
}

/**
 * V3 SONAOptimizer suggestion
 */
export interface V3RoutingSuggestion {
  agent: string
  confidence: number
  usedQLearning: boolean
  source: 'sona-pattern' | 'q-learning' | 'keyword-match' | 'default'
  alternatives: Array<{ agent: string; score: number }>
  matchedKeywords?: string[]
}

/**
 * V3 SONAOptimizer interface
 */
export interface V3SONAOptimizer {
  initialize(): Promise<{ success: boolean; patternsLoaded: number }>
  getRoutingSuggestion(task: string): V3RoutingSuggestion
  processTrajectoryOutcome(outcome: {
    trajectoryId: string
    task: string
    agent: string
    success: boolean
  }): { learned: boolean; patternKey: string; confidence: number }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStats(): any
}

// ============================================================================
// LRU Cache Implementation
// ============================================================================

/**
 * Simple LRU cache for routing decisions
 */
export class LRUCache<K, V> {
  private cache: Map<K, { value: V; timestamp: number }>
  private readonly maxSize: number
  private readonly ttlMs: number

  constructor(maxSize: number, ttlMs: number) {
    this.cache = new Map()
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  get(key: K): V | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      return null
    }

    // Move to end (most recently used)
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.value
  }

  set(key: K, value: V): void {
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }

    this.cache.set(key, { value, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

// ============================================================================
// Metrics Collector
// ============================================================================

/**
 * Simple metrics collector for SONA routing
 */
export class MetricsCollector {
  private totalRequests = 0
  private requestsByTool: Partial<Record<ToolType, number>> = {}
  private requestsByExpert: Record<ExpertId, number> = {}
  private cacheHits = 0
  private cacheMisses = 0
  private totalRoutingTimeMs = 0
  private totalExecutionTimeMs = 0
  private errorCount = 0
  private errorsByType: Record<string, number> = {}

  recordRouting(
    tool: ToolType,
    expertId: ExpertId,
    routingTimeMs: number,
    cacheHit: boolean
  ): void {
    this.totalRequests++
    this.requestsByTool[tool] = (this.requestsByTool[tool] || 0) + 1
    this.requestsByExpert[expertId] = (this.requestsByExpert[expertId] || 0) + 1
    this.totalRoutingTimeMs += routingTimeMs

    if (cacheHit) {
      this.cacheHits++
    } else {
      this.cacheMisses++
    }
  }

  recordExecution(executionTimeMs: number): void {
    this.totalExecutionTimeMs += executionTimeMs
  }

  recordError(errorType: string): void {
    this.errorCount++
    this.errorsByType[errorType] = (this.errorsByType[errorType] || 0) + 1
  }

  getMetrics(): Partial<SONAMetrics> {
    const totalCache = this.cacheHits + this.cacheMisses
    const avgRoutingMs = this.totalRequests > 0 ? this.totalRoutingTimeMs / this.totalRequests : 0
    const avgExecutionMs =
      this.totalRequests > 0 ? this.totalExecutionTimeMs / this.totalRequests : 0

    return {
      totalRequests: this.totalRequests,
      requestsByTool: this.requestsByTool,
      requestsByExpert: this.requestsByExpert,
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: totalCache > 0 ? this.cacheHits / totalCache : 0,
      },
      errors: {
        total: this.errorCount,
        byType: this.errorsByType,
        byExpert: {},
      },
      speedImprovement: {
        baselineMs: 100, // Baseline without SONA
        currentMs: avgRoutingMs + avgExecutionMs,
        improvementRatio:
          avgRoutingMs + avgExecutionMs > 0 ? 100 / (avgRoutingMs + avgExecutionMs) : 1,
      },
    }
  }

  reset(): void {
    this.totalRequests = 0
    this.requestsByTool = {}
    this.requestsByExpert = {}
    this.cacheHits = 0
    this.cacheMisses = 0
    this.totalRoutingTimeMs = 0
    this.totalExecutionTimeMs = 0
    this.errorCount = 0
    this.errorsByType = {}
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if SONA routing should be used for a request
 */
export function shouldUseSONARouting(
  tool: ToolType,
  featureFlags: Record<string, boolean | number>,
  userTier?: string
): boolean {
  // Master switch
  if (!featureFlags['sona.enabled']) {
    return false
  }

  // Tool-specific flag
  const toolFlag = `sona.tools.${tool}` as keyof typeof featureFlags
  if (!featureFlags[toolFlag]) {
    return false
  }

  // Tier check
  if (userTier) {
    const tierFlag = `sona.tiers.${userTier}` as keyof typeof featureFlags
    if (!featureFlags[tierFlag]) {
      return false
    }
  }

  return true
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a routing decision indicates high confidence
 */
export function isHighConfidenceDecision(decision: RoutingDecision): boolean {
  return decision.confidence >= 0.8
}

/**
 * Check if a routing decision used fallback
 */
export function usedFallback(decision: RoutingDecision): boolean {
  return decision.expertId === 'direct-fallback'
}

// ============================================================================
// Hash Utility
// ============================================================================

/**
 * Generate a simple hash from an object (for cache keys)
 */
export function hashObject(obj: Record<string, unknown>): string {
  const str = JSON.stringify(obj, Object.keys(obj).sort())
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return hash.toString(36)
}

// ============================================================================
// Factory Helper (Stub for backwards compat - actual implementation in SONARouter.ts)
// ============================================================================

// Note: createSONARouter is now exported directly from SONARouter.ts to avoid
// circular dependency. This re-export is handled in the main file.
