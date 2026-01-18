/**
 * @fileoverview SONA Routing Module Exports
 * @module @skillsmith/core/routing
 * @see SMI-1521: SONA routing for MCP tool optimization
 */

// Main router
export {
  SONARouter,
  createSONARouter,
  shouldUseSONARouting,
  isHighConfidenceDecision,
  usedFallback,
} from './SONARouter.js'

// Types
export type {
  ExpertId,
  ExpertType,
  ExpertState,
  ExpertCapability,
  ExpertDefinition,
  ExpertStatus,
  ToolType,
  WeightProfile,
  ToolRequest,
  RoutingScores,
  RoutingAlternative,
  RoutingDecision,
  ToolResponse,
  HistogramBuckets,
  SONAMetrics,
  LoadBalanceStrategy,
  SONARouterConfig,
  SONAFeatureFlag,
} from './types.js'

// Constants
export { TOOL_WEIGHTS, SONA_EXPERTS, DEFAULT_SONA_CONFIG, SONA_FEATURE_FLAGS } from './types.js'
