# SONARouter Architecture

**Issue**: SMI-1521: Implement SONA routing for MCP tool optimization
**Target**: 2.8-4.4x speed improvement
**Date**: January 2026

## Executive Summary

SONARouter (Specialized Optimized Network Architecture Router) routes MCP tool requests through an 8-expert Mixture of Experts (MoE) network to optimize tool execution based on accuracy requirements, latency constraints, and load distribution.

## 1. Class Diagram

```
+------------------------------------------------------------------+
|                         SONARouter                                |
+------------------------------------------------------------------+
| - config: SONARouterConfig                                        |
| - experts: Map<ExpertId, Expert>                                  |
| - metrics: MetricsCollector                                       |
| - loadBalancer: LoadBalancer                                      |
| - featureFlags: FeatureFlagService                                |
| - cache: RoutingCache                                             |
+------------------------------------------------------------------+
| + route(request: ToolRequest): Promise<RoutingDecision>           |
| + executeWithRouting(request: ToolRequest): Promise<ToolResponse> |
| + getExpertStatus(): ExpertStatus[]                               |
| + getMetrics(): SONAMetrics                                       |
| + warmup(): Promise<void>                                         |
| + shutdown(): Promise<void>                                       |
+------------------------------------------------------------------+
           |                    |                      |
           v                    v                      v
+-------------------+  +-------------------+  +--------------------+
|      Expert       |  |   LoadBalancer    |  |  MetricsCollector  |
+-------------------+  +-------------------+  +--------------------+
| - id: ExpertId    |  | - strategy: LBStr |  | - histograms: Map  |
| - type: ExpertType|  | - health: Map     |  | - counters: Map    |
| - weights: Map    |  | - queues: Map     |  | - gauges: Map      |
| - state: State    |  +-------------------+  +--------------------+
+-------------------+  | + select(experts) |  | + record(event)    |
| + canHandle(req)  |  | + reportHealth()  |  | + export()         |
| + execute(req)    |  | + getLoad()       |  | + reset()          |
| + getScore(req)   |  +-------------------+  +--------------------+
+-------------------+
           |
           v
+-------------------+     +-------------------+     +-------------------+
| AccuracyExpert    |     | LatencyExpert     |     | BalancedExpert    |
+-------------------+     +-------------------+     +-------------------+
| Optimizes for     |     | Optimizes for     |     | Balances both     |
| result quality    |     | response time     |     | accuracy/latency  |
+-------------------+     +-------------------+     +-------------------+

+------------------------------------------------------------------+
|                      RoutingCache                                 |
+------------------------------------------------------------------+
| - lru: LRUCache<string, RoutingDecision>                          |
| - ttl: number                                                     |
+------------------------------------------------------------------+
| + get(key: string): RoutingDecision | null                        |
| + set(key: string, decision: RoutingDecision): void               |
| + invalidate(pattern: string): void                               |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
|                    FeatureFlagService                             |
+------------------------------------------------------------------+
| - flags: Map<string, boolean>                                     |
| - overrides: Map<string, boolean>                                 |
+------------------------------------------------------------------+
| + isEnabled(flag: string): boolean                                |
| + getVariant(flag: string): string                                |
| + setOverride(flag: string, value: boolean): void                 |
+------------------------------------------------------------------+
```

## 2. TypeScript Interface Definitions

### 2.1 Core Configuration

```typescript
/**
 * @fileoverview SONARouter configuration and types
 * @module @skillsmith/core/routing/types
 * @see SMI-1521: SONA routing for MCP tool optimization
 */

/**
 * Expert identification
 */
export type ExpertId = string;

/**
 * Types of experts in the MoE network
 * - accuracy: Prioritizes result correctness over speed
 * - latency: Prioritizes response time
 * - balanced: Balances accuracy and latency
 * - specialized: Tool-specific optimization
 */
export type ExpertType = 'accuracy' | 'latency' | 'balanced' | 'specialized';

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
  | 'analyze';

/**
 * Weight profile for routing decisions
 * Values range from 0.0 to 1.0
 */
export interface WeightProfile {
  /** Weight for accuracy optimization */
  accuracy: number;
  /** Weight for latency optimization */
  latency: number;
  /** Weight for reliability/availability */
  reliability: number;
  /** Weight for resource efficiency */
  efficiency: number;
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
};
```

### 2.2 Expert Definitions

```typescript
/**
 * Expert state for health monitoring
 */
export type ExpertState = 'healthy' | 'degraded' | 'unhealthy' | 'warming_up';

/**
 * Expert capability declaration
 */
export interface ExpertCapability {
  /** Tools this expert can handle */
  supportedTools: ToolType[];
  /** Maximum concurrent requests */
  maxConcurrency: number;
  /** Average latency in milliseconds */
  avgLatencyMs: number;
  /** Accuracy score (0-1) based on historical performance */
  accuracyScore: number;
}

/**
 * Expert definition in the MoE network
 */
export interface ExpertDefinition {
  /** Unique expert identifier */
  id: ExpertId;
  /** Expert type classification */
  type: ExpertType;
  /** Name for logging/display */
  name: string;
  /** Detailed description */
  description: string;
  /** Declared capabilities */
  capabilities: ExpertCapability;
  /** Weight profile for routing decisions */
  weights: WeightProfile;
  /** Priority (higher = preferred when tied) */
  priority: number;
}

/**
 * Runtime expert status
 */
export interface ExpertStatus {
  /** Expert identifier */
  id: ExpertId;
  /** Current health state */
  state: ExpertState;
  /** Current load (0-1) */
  load: number;
  /** Active request count */
  activeRequests: number;
  /** Success rate (last 100 requests) */
  successRate: number;
  /** P95 latency in milliseconds */
  p95LatencyMs: number;
  /** Last health check timestamp */
  lastHealthCheck: Date;
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
      supportedTools: ['search', 'recommend', 'install', 'validate', 'compare', 'get_skill', 'uninstall', 'analyze'],
      maxConcurrency: 100,
      avgLatencyMs: 75,
      accuracyScore: 0.90,
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
];
```

### 2.3 Routing Decision Interface

```typescript
/**
 * Request context for routing decisions
 */
export interface ToolRequest {
  /** Request identifier for tracing */
  requestId: string;
  /** Tool being invoked */
  tool: ToolType;
  /** Tool arguments */
  arguments: Record<string, unknown>;
  /** Request timestamp */
  timestamp: Date;
  /** Optional priority override */
  priority?: 'high' | 'normal' | 'low';
  /** Optional latency constraint (ms) */
  maxLatencyMs?: number;
  /** Request metadata */
  metadata?: {
    /** User/session identifier */
    userId?: string;
    /** Source context (mcp, cli, api) */
    source?: string;
    /** Feature flags for this request */
    featureFlags?: Record<string, boolean>;
  };
}

/**
 * Routing decision made by SONARouter
 */
export interface RoutingDecision {
  /** Request this decision applies to */
  requestId: string;
  /** Selected expert */
  expertId: ExpertId;
  /** Confidence in this routing (0-1) */
  confidence: number;
  /** Score breakdown */
  scores: {
    /** Accuracy contribution */
    accuracyScore: number;
    /** Latency contribution */
    latencyScore: number;
    /** Reliability contribution */
    reliabilityScore: number;
    /** Efficiency contribution */
    efficiencyScore: number;
    /** Final weighted score */
    totalScore: number;
  };
  /** Alternative experts considered (top 3) */
  alternatives: Array<{
    expertId: ExpertId;
    score: number;
    reason: string;
  }>;
  /** Routing reasoning for debugging */
  reason: string;
  /** Decision timestamp */
  decidedAt: Date;
  /** Time to make decision (ms) */
  decisionTimeMs: number;
}

/**
 * Tool execution response
 */
export interface ToolResponse<T = unknown> {
  /** Request identifier */
  requestId: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Response data (if successful) */
  data?: T;
  /** Error information (if failed) */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  /** Execution metadata */
  meta: {
    /** Expert that handled the request */
    expertId: ExpertId;
    /** Total execution time (ms) */
    totalTimeMs: number;
    /** Routing decision time (ms) */
    routingTimeMs: number;
    /** Expert execution time (ms) */
    executionTimeMs: number;
    /** Whether cache was used */
    cacheHit: boolean;
    /** Whether fallback was triggered */
    usedFallback: boolean;
  };
}
```

### 2.4 Metrics/Telemetry Interface

```typescript
/**
 * Histogram bucket configuration
 */
export interface HistogramBuckets {
  /** Bucket boundaries in ms */
  boundaries: number[];
  /** Counts per bucket */
  counts: number[];
}

/**
 * SONA metrics for observability
 */
export interface SONAMetrics {
  /** Total requests routed */
  totalRequests: number;
  /** Requests by tool type */
  requestsByTool: Record<ToolType, number>;
  /** Requests by expert */
  requestsByExpert: Record<ExpertId, number>;
  /** Cache statistics */
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
  };
  /** Latency histograms */
  latency: {
    routing: HistogramBuckets;
    execution: HistogramBuckets;
    total: HistogramBuckets;
  };
  /** Error statistics */
  errors: {
    total: number;
    byType: Record<string, number>;
    byExpert: Record<ExpertId, number>;
  };
  /** Expert health */
  expertHealth: Record<ExpertId, {
    state: ExpertState;
    load: number;
    successRate: number;
  }>;
  /** Speed improvement metrics */
  speedImprovement: {
    /** Baseline latency (without SONA) */
    baselineMs: number;
    /** Current average latency */
    currentMs: number;
    /** Improvement ratio (target: 2.8-4.4x) */
    improvementRatio: number;
  };
}

/**
 * Telemetry event for routing decisions
 */
export interface RoutingTelemetryEvent {
  eventType: 'routing_decision';
  timestamp: Date;
  requestId: string;
  tool: ToolType;
  selectedExpert: ExpertId;
  confidence: number;
  decisionTimeMs: number;
  expertCount: number;
  cacheHit: boolean;
}

/**
 * Telemetry event for execution results
 */
export interface ExecutionTelemetryEvent {
  eventType: 'execution_result';
  timestamp: Date;
  requestId: string;
  tool: ToolType;
  expertId: ExpertId;
  success: boolean;
  totalTimeMs: number;
  executionTimeMs: number;
  errorCode?: string;
}

/**
 * Metrics collector interface
 */
export interface MetricsCollector {
  /** Record a routing decision */
  recordRoutingDecision(event: RoutingTelemetryEvent): void;
  /** Record an execution result */
  recordExecutionResult(event: ExecutionTelemetryEvent): void;
  /** Record expert health check */
  recordHealthCheck(expertId: ExpertId, status: ExpertStatus): void;
  /** Get current metrics snapshot */
  getMetrics(): SONAMetrics;
  /** Export metrics in Prometheus format */
  exportPrometheus(): string;
  /** Reset all metrics */
  reset(): void;
}
```

### 2.5 Main Router Configuration

```typescript
/**
 * SONARouter configuration options
 */
export interface SONARouterConfig {
  /** Expert definitions (defaults to SONA_EXPERTS) */
  experts?: ExpertDefinition[];
  /** Enable routing cache (default: true) */
  enableCache?: boolean;
  /** Cache TTL in milliseconds (default: 60000) */
  cacheTtlMs?: number;
  /** Cache max size (default: 1000) */
  cacheMaxSize?: number;
  /** Load balancing strategy */
  loadBalanceStrategy?: 'round-robin' | 'least-connections' | 'weighted' | 'adaptive';
  /** Health check interval in ms (default: 5000) */
  healthCheckIntervalMs?: number;
  /** Enable metrics collection (default: true) */
  enableMetrics?: boolean;
  /** Feature flag service for gradual rollout */
  featureFlags?: FeatureFlagService;
  /** Fallback configuration */
  fallback?: {
    /** Enable fallback to direct execution (default: true) */
    enabled: boolean;
    /** Timeout before fallback triggers (ms) */
    timeoutMs: number;
    /** Max retries before fallback */
    maxRetries: number;
  };
}

/**
 * Default SONARouter configuration
 */
export const DEFAULT_SONA_CONFIG: Required<SONARouterConfig> = {
  experts: SONA_EXPERTS,
  enableCache: true,
  cacheTtlMs: 60000,
  cacheMaxSize: 1000,
  loadBalanceStrategy: 'adaptive',
  healthCheckIntervalMs: 5000,
  enableMetrics: true,
  featureFlags: null!, // Injected at runtime
  fallback: {
    enabled: true,
    timeoutMs: 5000,
    maxRetries: 2,
  },
};
```

## 3. Routing Algorithm

### 3.1 Pseudocode

```
ALGORITHM: SelectOptimalExpert

INPUT:
  - request: ToolRequest
  - experts: List<Expert>
  - config: SONARouterConfig

OUTPUT:
  - RoutingDecision

PROCEDURE:

1. CACHE CHECK
   cacheKey = generateCacheKey(request.tool, request.arguments)
   IF cache.has(cacheKey) AND NOT request.priority == 'high':
     cachedDecision = cache.get(cacheKey)
     IF cachedDecision.expertId is healthy:
       RETURN cachedDecision WITH cacheHit=true

2. FILTER ELIGIBLE EXPERTS
   eligibleExperts = []
   FOR each expert IN experts:
     IF expert.state == 'healthy' OR expert.state == 'degraded':
       IF request.tool IN expert.capabilities.supportedTools:
         IF expert.load < 0.9:  // Not overloaded
           eligibleExperts.add(expert)

   IF eligibleExperts.isEmpty():
     IF config.fallback.enabled:
       RETURN createFallbackDecision(request)
     ELSE:
       THROW NoEligibleExpertError

3. CALCULATE SCORES
   toolWeights = TOOL_WEIGHTS[request.tool]
   scoredExperts = []

   FOR each expert IN eligibleExperts:
     // Accuracy score based on historical performance
     accuracyScore = expert.capabilities.accuracyScore *
                     (1 - expert.load * 0.1)  // Slight penalty for load

     // Latency score (normalized, lower is better)
     latencyBaseline = 200  // ms
     latencyScore = max(0, 1 - (expert.capabilities.avgLatencyMs / latencyBaseline))

     // Apply latency constraint if specified
     IF request.maxLatencyMs:
       IF expert.capabilities.avgLatencyMs > request.maxLatencyMs:
         latencyScore = latencyScore * 0.5  // Heavy penalty

     // Reliability score based on success rate
     reliabilityScore = expert.status.successRate

     // Efficiency score (inverse of load)
     efficiencyScore = 1 - expert.load

     // Calculate weighted total
     totalScore = (
       toolWeights.accuracy * accuracyScore +
       toolWeights.latency * latencyScore +
       toolWeights.reliability * reliabilityScore +
       toolWeights.efficiency * efficiencyScore
     )

     // Priority boost for specialized experts
     IF expert.type == 'specialized' AND
        expert.capabilities.supportedTools.length == 1:
       totalScore = totalScore * 1.1

     // Priority tiebreaker
     totalScore = totalScore + (expert.priority / 10000)

     scoredExperts.add({
       expert: expert,
       scores: {
         accuracyScore,
         latencyScore,
         reliabilityScore,
         efficiencyScore,
         totalScore
       }
     })

4. SELECT BEST EXPERT
   scoredExperts.sortBy(totalScore, DESCENDING)

   selected = scoredExperts[0]
   alternatives = scoredExperts[1:4]  // Top 3 alternatives

   // Calculate confidence based on score margin
   IF alternatives.length > 0:
     scoreMargin = selected.scores.totalScore - alternatives[0].scores.totalScore
     confidence = min(1.0, 0.5 + scoreMargin * 2)
   ELSE:
     confidence = 1.0

5. BUILD DECISION
   decision = RoutingDecision {
     requestId: request.requestId,
     expertId: selected.expert.id,
     confidence: confidence,
     scores: selected.scores,
     alternatives: alternatives.map(alt => {
       expertId: alt.expert.id,
       score: alt.scores.totalScore,
       reason: generateAlternativeReason(alt)
     }),
     reason: generateDecisionReason(selected, toolWeights),
     decidedAt: now(),
     decisionTimeMs: elapsed()
   }

6. CACHE AND RETURN
   IF config.enableCache:
     cache.set(cacheKey, decision, ttl=config.cacheTtlMs)

   RETURN decision
```

### 3.2 Load Balancing Strategy

```
ALGORITHM: AdaptiveLoadBalancing

PURPOSE: Distribute requests across experts while maintaining SLA

PROCEDURE:

1. HEALTH-WEIGHTED DISTRIBUTION
   FOR each expert:
     baseWeight = expert.priority / sum(allPriorities)
     healthMultiplier =
       IF expert.state == 'healthy': 1.0
       ELSE IF expert.state == 'degraded': 0.5
       ELSE: 0.0
     loadMultiplier = 1 - (expert.load * 0.8)

     effectiveWeight = baseWeight * healthMultiplier * loadMultiplier

2. QUEUE-AWARE SCHEDULING
   IF expert.activeRequests >= expert.capabilities.maxConcurrency * 0.8:
     // Queue overflow prevention
     effectiveWeight = effectiveWeight * 0.3

3. LATENCY-ADAPTIVE ROUTING
   recentP95 = expert.metrics.latency.p95
   expectedP95 = expert.capabilities.avgLatencyMs * 1.5

   IF recentP95 > expectedP95:
     // Expert is slow, reduce traffic
     effectiveWeight = effectiveWeight * (expectedP95 / recentP95)

4. CIRCUIT BREAKER
   IF expert.errors.recentRate > 0.1:  // >10% error rate
     effectiveWeight = 0  // Take expert out of rotation temporarily
```

## 4. Integration Plan

### 4.1 Feature Flag Configuration

```typescript
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
  'sona.tiers.enterprise': true,  // Enterprise beta
  /** Enable metrics collection */
  'sona.metrics.enabled': true,
  /** Enable detailed tracing */
  'sona.tracing.enabled': false,
};

/**
 * Check if SONA should be used for a request
 */
export function shouldUseSONARouting(
  request: ToolRequest,
  flags: FeatureFlagService,
  userTier?: string
): boolean {
  // Master switch
  if (!flags.isEnabled('sona.enabled')) {
    return false;
  }

  // Tool-specific flag
  const toolFlag = `sona.tools.${request.tool}`;
  if (!flags.isEnabled(toolFlag)) {
    return false;
  }

  // Tier check
  if (userTier) {
    const tierFlag = `sona.tiers.${userTier}`;
    if (!flags.isEnabled(tierFlag)) {
      return false;
    }
  }

  // Percentage rollout
  const rolloutPercentage = flags.getVariant('sona.rollout.percentage');
  const requestHash = hashCode(request.requestId);
  return (requestHash % 100) < parseInt(rolloutPercentage);
}
```

### 4.2 MCP Tool Integration

```typescript
/**
 * Integration with existing MCP tools
 *
 * The SONARouter wraps existing tool handlers to provide
 * optimized routing while maintaining backward compatibility.
 */

// File: packages/mcp-server/src/routing/sona-middleware.ts

import { SONARouter, shouldUseSONARouting } from '@skillsmith/core/routing';
import type { ToolContext } from '../context.js';
import type { McpToolRequest, McpToolResponse } from '../middleware/degradation.js';

/**
 * SONA routing middleware for MCP tools
 */
export function createSONAMiddleware(
  router: SONARouter,
  featureFlags: FeatureFlagService
) {
  return async function sonaMiddleware<T>(
    toolName: string,
    handler: (request: McpToolRequest) => Promise<T>,
    request: McpToolRequest,
    context: ToolContext
  ): Promise<T | McpToolResponse> {
    // Check if SONA should be used
    const toolRequest = {
      requestId: crypto.randomUUID(),
      tool: toolName as ToolType,
      arguments: request.arguments,
      timestamp: new Date(),
      metadata: {
        userId: context.distinctId,
        source: 'mcp',
      },
    };

    const shouldUseSona = shouldUseSONARouting(
      toolRequest,
      featureFlags,
      context.license?.tier
    );

    if (!shouldUseSona) {
      // Direct execution (bypass SONA)
      return handler(request);
    }

    // Route through SONA
    try {
      const response = await router.executeWithRouting(toolRequest);

      if (!response.success) {
        // SONA execution failed, fallback to direct
        console.warn(
          `[SONA] Routing failed for ${toolName}, using fallback:`,
          response.error?.message
        );
        return handler(request);
      }

      return response.data as T;
    } catch (error) {
      // SONA error, fallback to direct
      console.error(
        `[SONA] Error routing ${toolName}:`,
        (error as Error).message
      );
      return handler(request);
    }
  };
}

/**
 * Wrap all MCP tools with SONA routing
 */
export function wrapToolsWithSONARouting(
  tools: Map<string, ToolHandler>,
  router: SONARouter,
  featureFlags: FeatureFlagService
): Map<string, ToolHandler> {
  const middleware = createSONAMiddleware(router, featureFlags);
  const wrappedTools = new Map<string, ToolHandler>();

  for (const [name, handler] of tools) {
    wrappedTools.set(name, async (request, context) => {
      return middleware(name, handler, request, context);
    });
  }

  return wrappedTools;
}
```

### 4.3 Fallback Strategy

```typescript
/**
 * Fallback execution when SONA routing fails or is disabled
 */
export interface FallbackExecutor {
  /** Execute tool directly without routing */
  executeDirect<T>(
    tool: ToolType,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<T>;
}

/**
 * Fallback scenarios and handling
 */
export const FALLBACK_SCENARIOS = {
  /** No healthy experts available */
  NO_EXPERTS: {
    action: 'direct_execution',
    logLevel: 'warn',
    metric: 'sona.fallback.no_experts',
  },
  /** Routing timeout exceeded */
  ROUTING_TIMEOUT: {
    action: 'direct_execution',
    logLevel: 'warn',
    metric: 'sona.fallback.timeout',
  },
  /** Expert execution failed */
  EXPERT_FAILURE: {
    action: 'retry_then_direct',
    logLevel: 'error',
    metric: 'sona.fallback.expert_failure',
  },
  /** Feature flag disabled */
  FEATURE_DISABLED: {
    action: 'direct_execution',
    logLevel: 'debug',
    metric: 'sona.fallback.disabled',
  },
};

/**
 * Create fallback decision for direct execution
 */
export function createFallbackDecision(
  request: ToolRequest,
  reason: keyof typeof FALLBACK_SCENARIOS
): RoutingDecision {
  return {
    requestId: request.requestId,
    expertId: 'direct-fallback',
    confidence: 1.0,
    scores: {
      accuracyScore: 0,
      latencyScore: 0,
      reliabilityScore: 1.0,
      efficiencyScore: 0,
      totalScore: 0,
    },
    alternatives: [],
    reason: `Fallback: ${reason}`,
    decidedAt: new Date(),
    decisionTimeMs: 0,
  };
}
```

### 4.4 Rollout Plan

```
PHASE 1: Internal Testing (Week 1-2)
  - Enable for internal team only (sona.rollout.percentage = 0)
  - All feature flags enabled in dev environment
  - Collect baseline metrics
  - Target: Validate routing algorithm correctness

PHASE 2: Enterprise Beta (Week 3-4)
  - Enable for Enterprise tier only
  - sona.tiers.enterprise = true
  - sona.rollout.percentage = 10
  - Monitor error rates and latency
  - Target: <1% error rate, >2x speed improvement

PHASE 3: Gradual Rollout (Week 5-8)
  - Increase rollout percentage: 10% -> 25% -> 50% -> 100%
  - Enable for Team tier at 25%
  - Enable for Individual tier at 50%
  - Enable for Community tier at 100%
  - Target: 2.8-4.4x speed improvement across all tools

PHASE 4: Full Production (Week 9+)
  - sona.enabled = true for all tiers
  - Remove percentage-based rollout
  - Monitor and tune expert weights
  - Add new specialized experts as needed
```

## 5. File Structure

```
packages/core/src/
  routing/
    index.ts                    # Public exports
    types.ts                    # Type definitions (Section 2)
    SONARouter.ts               # Main router implementation
    experts/
      index.ts                  # Expert exports
      Expert.ts                 # Base expert class
      AccuracyExpert.ts         # Accuracy-focused expert
      LatencyExpert.ts          # Latency-focused expert
      BalancedExpert.ts         # Balanced expert
      SpecializedExpert.ts      # Tool-specific expert
    load-balancer/
      index.ts
      LoadBalancer.ts           # Load balancing implementation
      strategies/
        AdaptiveStrategy.ts
        RoundRobinStrategy.ts
        WeightedStrategy.ts
    cache/
      index.ts
      RoutingCache.ts           # LRU cache for routing decisions
    metrics/
      index.ts
      MetricsCollector.ts       # Metrics collection
      PrometheusExporter.ts     # Prometheus format export
    feature-flags/
      index.ts
      FeatureFlagService.ts     # Feature flag management
    __tests__/
      SONARouter.test.ts
      routing-algorithm.test.ts
      load-balancer.test.ts
      experts.test.ts

packages/mcp-server/src/
  routing/
    index.ts                    # MCP-specific routing exports
    sona-middleware.ts          # MCP tool integration (Section 4.2)
    fallback.ts                 # Fallback handling (Section 4.3)
```

## 6. Performance Targets

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Search latency | 75ms | 20ms | P50 |
| Recommend latency | 180ms | 50ms | P50 |
| Install latency | 120ms | 80ms | P50 |
| Validate latency | 100ms | 40ms | P50 |
| Compare latency | 160ms | 45ms | P50 |
| Get_skill latency | 30ms | 8ms | P50 |
| Routing overhead | N/A | <5ms | P95 |
| Cache hit rate | N/A | >60% | Average |
| Speed improvement | 1.0x | 2.8-4.4x | Overall |

## 7. Monitoring & Alerts

```yaml
# Prometheus alerting rules for SONA
groups:
  - name: sona_alerts
    rules:
      - alert: SONAHighLatency
        expr: histogram_quantile(0.95, sona_execution_duration_seconds) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "SONA routing latency is high"

      - alert: SONAExpertUnhealthy
        expr: sona_expert_health_status == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "SONA expert {{ $labels.expert_id }} is unhealthy"

      - alert: SONAHighErrorRate
        expr: rate(sona_errors_total[5m]) / rate(sona_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "SONA error rate exceeds 5%"

      - alert: SONASpeedImprovementBelow
        expr: sona_speed_improvement_ratio < 2.0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "SONA speed improvement below 2x target"
```

## 8. References

- [SMI-1521: Implement SONA routing for MCP tool optimization](https://linear.app/smith-horn/issue/SMI-1521)
- [ADR-019: MoE Network Architecture](docs/adr/019-moe-network-architecture.md) (pending)
- [Claude-Flow v3 Migration Plan](docs/execution/migration-plan.md)
- [Existing Router Implementation](packages/core/src/analysis/router.ts)
