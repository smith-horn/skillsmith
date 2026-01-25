/**
 * @fileoverview Request/Response Type Definitions for SONARouter
 * @module @skillsmith/core/routing/request-types
 * @see SMI-1521: SONA routing for MCP tool optimization
 *
 * Type definitions for routing requests, decisions, and responses.
 */

import type { ExpertId, ToolType } from './expert-types.js'

// ============================================================================
// Request Types
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

// ============================================================================
// Routing Decision Types
// ============================================================================

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

// ============================================================================
// Response Types
// ============================================================================

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
