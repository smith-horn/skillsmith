/**
 * @fileoverview SONARouter Type Definitions
 * @module @skillsmith/core/routing/types
 * @see SMI-1521: SONA routing for MCP tool optimization
 *
 * Main barrel file for SONA routing types. Re-exports from modular type files.
 */

// Re-export expert types
export type {
  ExpertId,
  ExpertType,
  ExpertState,
  ToolType,
  WeightProfile,
  ExpertCapability,
  ExpertDefinition,
  ExpertStatus,
} from './expert-types.js'

export { TOOL_WEIGHTS, SONA_EXPERTS } from './expert-types.js'

// Re-export request/response types
export type {
  ToolRequest,
  RoutingScores,
  RoutingAlternative,
  RoutingDecision,
  ToolResponse,
} from './request-types.js'

// Import for local use
import type { ExpertId, ExpertState, ToolType, ExpertDefinition } from './expert-types.js'
import { SONA_EXPERTS } from './expert-types.js'

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Histogram bucket configuration
 */
export interface HistogramBuckets {
  /** Bucket boundaries in ms */
  boundaries: number[]
  /** Counts per bucket */
  counts: number[]
}

/**
 * SONA metrics for observability
 */
export interface SONAMetrics {
  /** Total requests routed */
  totalRequests: number
  /** Requests by tool type */
  requestsByTool: Partial<Record<ToolType, number>>
  /** Requests by expert */
  requestsByExpert: Record<ExpertId, number>
  /** Cache statistics */
  cache: {
    hits: number
    misses: number
    hitRate: number
  }
  /** Latency histograms */
  latency: {
    routing: HistogramBuckets
    execution: HistogramBuckets
    total: HistogramBuckets
  }
  /** Error statistics */
  errors: {
    total: number
    byType: Record<string, number>
    byExpert: Record<ExpertId, number>
  }
  /** Expert health */
  expertHealth: Record<
    ExpertId,
    {
      state: ExpertState
      load: number
      successRate: number
    }
  >
  /** Speed improvement metrics */
  speedImprovement: {
    /** Baseline latency (without SONA) */
    baselineMs: number
    /** Current average latency */
    currentMs: number
    /** Improvement ratio (target: 2.8-4.4x) */
    improvementRatio: number
  }
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Load balancing strategy
 */
export type LoadBalanceStrategy = 'round-robin' | 'least-connections' | 'weighted' | 'adaptive'

/**
 * SONARouter configuration options
 */
export interface SONARouterConfig {
  /** Expert definitions (defaults to SONA_EXPERTS) */
  experts?: ExpertDefinition[]
  /** Enable routing cache (default: true) */
  enableCache?: boolean
  /** Cache TTL in milliseconds (default: 60000) */
  cacheTtlMs?: number
  /** Cache max size (default: 1000) */
  cacheMaxSize?: number
  /** Load balancing strategy */
  loadBalanceStrategy?: LoadBalanceStrategy
  /** Health check interval in ms (default: 5000) */
  healthCheckIntervalMs?: number
  /** Enable metrics collection (default: true) */
  enableMetrics?: boolean
  /** Fallback configuration */
  fallback?: {
    /** Enable fallback to direct execution (default: true) */
    enabled: boolean
    /** Timeout before fallback triggers (ms) */
    timeoutMs: number
    /** Max retries before fallback */
    maxRetries: number
  }
  /** Enable V3 MoE integration (default: auto-detect) */
  useV3MoE?: boolean
}

/**
 * Default SONARouter configuration
 */
export const DEFAULT_SONA_CONFIG: Required<Omit<SONARouterConfig, 'useV3MoE'>> & {
  useV3MoE?: boolean
} = {
  experts: SONA_EXPERTS,
  enableCache: true,
  cacheTtlMs: 60000,
  cacheMaxSize: 1000,
  loadBalanceStrategy: 'adaptive',
  healthCheckIntervalMs: 5000,
  enableMetrics: true,
  fallback: {
    enabled: true,
    timeoutMs: 5000,
    maxRetries: 2,
  },
}

// ============================================================================
// Feature Flag Types
// ============================================================================

/**
 * Feature flags for gradual SONA rollout
 */
export const SONA_FEATURE_FLAGS = {
  /** Master switch for SONA routing */
  'sona.enabled': false,
  /** Enable for specific tools */
  'sona.tools.search': false,
  'sona.tools.recommend': false,
  'sona.tools.install': false,
  'sona.tools.validate': false,
  'sona.tools.compare': false,
  'sona.tools.get_skill': false,
  /** Percentage of traffic to route through SONA (0-100) */
  'sona.rollout.percentage': 0,
  /** Enable for specific user tiers */
  'sona.tiers.community': false,
  'sona.tiers.individual': false,
  'sona.tiers.team': false,
  'sona.tiers.enterprise': true, // Enterprise beta
  /** Enable metrics collection */
  'sona.metrics.enabled': true,
} as const

export type SONAFeatureFlag = keyof typeof SONA_FEATURE_FLAGS
