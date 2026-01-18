/**
 * @fileoverview SONARouter Type Definitions
 * @module @skillsmith/core/routing/types
 * @see SMI-1521: SONA routing for MCP tool optimization
 *
 * Type definitions for the SONA (Specialized Optimized Network Architecture)
 * routing system that routes MCP tool requests through an 8-expert MoE network.
 */

// ============================================================================
// Expert Types
// ============================================================================

/**
 * Expert identification
 */
export type ExpertId = string

/**
 * Types of experts in the MoE network
 * - accuracy: Prioritizes result correctness over speed
 * - latency: Prioritizes response time
 * - balanced: Balances accuracy and latency
 * - specialized: Tool-specific optimization
 */
export type ExpertType = 'accuracy' | 'latency' | 'balanced' | 'specialized'

/**
 * Expert state for health monitoring
 */
export type ExpertState = 'healthy' | 'degraded' | 'unhealthy' | 'warming_up'

// ============================================================================
// Tool Types
// ============================================================================

/**
 * MCP tool types supported by SONARouter
 */
export type ToolType =
  | 'search'
  | 'recommend'
  | 'install'
  | 'validate'
  | 'compare'
  | 'get_skill'
  | 'uninstall'
  | 'analyze'

/**
 * Weight profile for routing decisions
 * Values range from 0.0 to 1.0
 */
export interface WeightProfile {
  /** Weight for accuracy optimization */
  accuracy: number
  /** Weight for latency optimization */
  latency: number
  /** Weight for reliability/availability */
  reliability: number
  /** Weight for resource efficiency */
  efficiency: number
}

/**
 * Tool-specific weight configurations
 * Based on SMI-1521 requirements:
 * - search: accuracy-weighted
 * - recommend: accuracy + personalization
 * - install: balanced (reliability important)
 * - validate: balanced
 * - compare: accuracy-weighted
 * - get_skill: low latency
 */
export const TOOL_WEIGHTS: Record<ToolType, WeightProfile> = {
  search: { accuracy: 0.7, latency: 0.2, reliability: 0.05, efficiency: 0.05 },
  recommend: { accuracy: 0.6, latency: 0.2, reliability: 0.1, efficiency: 0.1 },
  install: { accuracy: 0.3, latency: 0.2, reliability: 0.4, efficiency: 0.1 },
  validate: { accuracy: 0.4, latency: 0.3, reliability: 0.2, efficiency: 0.1 },
  compare: { accuracy: 0.65, latency: 0.2, reliability: 0.1, efficiency: 0.05 },
  get_skill: { accuracy: 0.2, latency: 0.6, reliability: 0.15, efficiency: 0.05 },
  uninstall: { accuracy: 0.2, latency: 0.3, reliability: 0.4, efficiency: 0.1 },
  analyze: { accuracy: 0.5, latency: 0.25, reliability: 0.15, efficiency: 0.1 },
}

// ============================================================================
// Expert Definitions
// ============================================================================

/**
 * Expert capability declaration
 */
export interface ExpertCapability {
  /** Tools this expert can handle */
  supportedTools: ToolType[]
  /** Maximum concurrent requests */
  maxConcurrency: number
  /** Average latency in milliseconds */
  avgLatencyMs: number
  /** Accuracy score (0-1) based on historical performance */
  accuracyScore: number
}

/**
 * Expert definition in the MoE network
 */
export interface ExpertDefinition {
  /** Unique expert identifier */
  id: ExpertId
  /** Expert type classification */
  type: ExpertType
  /** Name for logging/display */
  name: string
  /** Detailed description */
  description: string
  /** Declared capabilities */
  capabilities: ExpertCapability
  /** Weight profile for routing decisions */
  weights: WeightProfile
  /** Priority (higher = preferred when tied) */
  priority: number
}

/**
 * Runtime expert status
 */
export interface ExpertStatus {
  /** Expert identifier */
  id: ExpertId
  /** Current health state */
  state: ExpertState
  /** Current load (0-1) */
  load: number
  /** Active request count */
  activeRequests: number
  /** Success rate (last 100 requests) */
  successRate: number
  /** P95 latency in milliseconds */
  p95LatencyMs: number
  /** Last health check timestamp */
  lastHealthCheck: Date
}

/**
 * 8-Expert MoE Network Configuration
 * Designed for Skillsmith MCP tools
 */
export const SONA_EXPERTS: ExpertDefinition[] = [
  // Accuracy-focused experts
  {
    id: 'accuracy-semantic',
    type: 'accuracy',
    name: 'Semantic Search Expert',
    description: 'Optimizes semantic similarity matching for search and recommend',
    capabilities: {
      supportedTools: ['search', 'recommend', 'compare'],
      maxConcurrency: 50,
      avgLatencyMs: 150,
      accuracyScore: 0.95,
    },
    weights: { accuracy: 0.9, latency: 0.05, reliability: 0.03, efficiency: 0.02 },
    priority: 100,
  },
  {
    id: 'accuracy-validation',
    type: 'accuracy',
    name: 'Validation Expert',
    description: 'Thorough validation with complete error reporting',
    capabilities: {
      supportedTools: ['validate', 'analyze'],
      maxConcurrency: 30,
      avgLatencyMs: 200,
      accuracyScore: 0.98,
    },
    weights: { accuracy: 0.85, latency: 0.05, reliability: 0.08, efficiency: 0.02 },
    priority: 90,
  },
  // Latency-focused experts
  {
    id: 'latency-cache',
    type: 'latency',
    name: 'Cache-First Expert',
    description: 'Serves from cache with fallback to computation',
    capabilities: {
      supportedTools: ['search', 'get_skill', 'recommend'],
      maxConcurrency: 200,
      avgLatencyMs: 15,
      accuracyScore: 0.85,
    },
    weights: { accuracy: 0.2, latency: 0.7, reliability: 0.05, efficiency: 0.05 },
    priority: 80,
  },
  {
    id: 'latency-index',
    type: 'latency',
    name: 'Index Lookup Expert',
    description: 'Direct index lookups for known entities',
    capabilities: {
      supportedTools: ['get_skill', 'search'],
      maxConcurrency: 500,
      avgLatencyMs: 5,
      accuracyScore: 0.99,
    },
    weights: { accuracy: 0.3, latency: 0.6, reliability: 0.08, efficiency: 0.02 },
    priority: 85,
  },
  // Balanced experts
  {
    id: 'balanced-default',
    type: 'balanced',
    name: 'Default Balanced Expert',
    description: 'General-purpose balanced execution',
    capabilities: {
      supportedTools: [
        'search',
        'recommend',
        'install',
        'validate',
        'compare',
        'get_skill',
        'uninstall',
        'analyze',
      ],
      maxConcurrency: 100,
      avgLatencyMs: 75,
      accuracyScore: 0.9,
    },
    weights: { accuracy: 0.4, latency: 0.4, reliability: 0.15, efficiency: 0.05 },
    priority: 50,
  },
  {
    id: 'balanced-reliability',
    type: 'balanced',
    name: 'Reliability Expert',
    description: 'Prioritizes successful completion over speed',
    capabilities: {
      supportedTools: ['install', 'uninstall', 'validate'],
      maxConcurrency: 25,
      avgLatencyMs: 120,
      accuracyScore: 0.92,
    },
    weights: { accuracy: 0.3, latency: 0.2, reliability: 0.45, efficiency: 0.05 },
    priority: 70,
  },
  // Specialized experts
  {
    id: 'specialized-recommend',
    type: 'specialized',
    name: 'Recommendation Expert',
    description: 'ML-powered personalized recommendations',
    capabilities: {
      supportedTools: ['recommend'],
      maxConcurrency: 40,
      avgLatencyMs: 180,
      accuracyScore: 0.93,
    },
    weights: { accuracy: 0.65, latency: 0.15, reliability: 0.1, efficiency: 0.1 },
    priority: 95,
  },
  {
    id: 'specialized-compare',
    type: 'specialized',
    name: 'Comparison Expert',
    description: 'Deep feature comparison with scoring',
    capabilities: {
      supportedTools: ['compare', 'analyze'],
      maxConcurrency: 35,
      avgLatencyMs: 160,
      accuracyScore: 0.94,
    },
    weights: { accuracy: 0.7, latency: 0.1, reliability: 0.15, efficiency: 0.05 },
    priority: 88,
  },
]

// ============================================================================
// Request/Response Types
// ============================================================================

/**
 * Request context for routing decisions
 */
export interface ToolRequest {
  /** Request identifier for tracing */
  requestId: string
  /** Tool being invoked */
  tool: ToolType
  /** Tool arguments */
  arguments: Record<string, unknown>
  /** Request timestamp */
  timestamp: Date
  /** Optional priority override */
  priority?: 'high' | 'normal' | 'low'
  /** Optional latency constraint (ms) */
  maxLatencyMs?: number
  /** Request metadata */
  metadata?: {
    /** User/session identifier */
    userId?: string
    /** Source context (mcp, cli, api) */
    source?: string
    /** Feature flags for this request */
    featureFlags?: Record<string, boolean>
  }
}

/**
 * Score breakdown for routing decision
 */
export interface RoutingScores {
  /** Accuracy contribution */
  accuracyScore: number
  /** Latency contribution */
  latencyScore: number
  /** Reliability contribution */
  reliabilityScore: number
  /** Efficiency contribution */
  efficiencyScore: number
  /** Final weighted score */
  totalScore: number
}

/**
 * Alternative expert considered in routing
 */
export interface RoutingAlternative {
  expertId: ExpertId
  score: number
  reason: string
}

/**
 * Routing decision made by SONARouter
 */
export interface RoutingDecision {
  /** Request this decision applies to */
  requestId: string
  /** Selected expert */
  expertId: ExpertId
  /** Confidence in this routing (0-1) */
  confidence: number
  /** Score breakdown */
  scores: RoutingScores
  /** Alternative experts considered (top 3) */
  alternatives: RoutingAlternative[]
  /** Routing reasoning for debugging */
  reason: string
  /** Decision timestamp */
  decidedAt: Date
  /** Time to make decision (ms) */
  decisionTimeMs: number
  /** Whether from cache */
  cacheHit?: boolean
}

/**
 * Tool execution response
 */
export interface ToolResponse<T = unknown> {
  /** Request identifier */
  requestId: string
  /** Whether execution succeeded */
  success: boolean
  /** Response data (if successful) */
  data?: T
  /** Error information (if failed) */
  error?: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
  /** Execution metadata */
  meta: {
    /** Expert that handled the request */
    expertId: ExpertId
    /** Total execution time (ms) */
    totalTimeMs: number
    /** Routing decision time (ms) */
    routingTimeMs: number
    /** Expert execution time (ms) */
    executionTimeMs: number
    /** Whether cache was used */
    cacheHit: boolean
    /** Whether fallback was triggered */
    usedFallback: boolean
  }
}

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
