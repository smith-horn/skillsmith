/**
 * @fileoverview Expert Type Definitions for SONARouter
 * @module @skillsmith/core/routing/expert-types
 * @see SMI-1521: SONA routing for MCP tool optimization
 *
 * Type definitions for experts in the SONA MoE network.
 */

// ============================================================================
// Expert Identification Types
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

// ============================================================================
// Weight Profile
// ============================================================================

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

// ============================================================================
// 8-Expert MoE Network Configuration
// ============================================================================

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
