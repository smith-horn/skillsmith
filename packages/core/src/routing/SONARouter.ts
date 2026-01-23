/**
 * @fileoverview SONARouter - Specialized Optimized Network Architecture Router
 * @module @skillsmith/core/routing/SONARouter
 * @see SMI-1521: SONA routing for MCP tool optimization
 *
 * Routes MCP tool requests through an 8-expert MoE (Mixture of Experts)
 * network to optimize tool execution based on accuracy requirements,
 * latency constraints, and load distribution.
 */

import type {
  ExpertDefinition,
  ExpertId,
  ExpertState,
  ExpertStatus,
  RoutingDecision,
  RoutingScores,
  SONAMetrics,
  SONARouterConfig,
  ToolRequest,
  ToolResponse,
  ToolType,
  WeightProfile,
} from './types.js'

import { DEFAULT_SONA_CONFIG, TOOL_WEIGHTS } from './types.js'

// Import helpers
import type { V3MoERouter, V3SONAOptimizer } from './SONARouter.helpers.js'
import { LRUCache, MetricsCollector, hashObject } from './SONARouter.helpers.js'

// Re-export helpers for public API
export {
  LRUCache,
  MetricsCollector,
  shouldUseSONARouting,
  isHighConfidenceDecision,
  usedFallback,
} from './SONARouter.helpers.js'

export type {
  V3RoutingResult,
  V3MoERouter,
  V3RoutingSuggestion,
  V3SONAOptimizer,
} from './SONARouter.helpers.js'

// ============================================================================
// Main SONARouter Class
// ============================================================================

/**
 * SONARouter routes MCP tool requests through an 8-expert MoE network.
 */
export class SONARouter {
  private config: Required<Omit<SONARouterConfig, 'useV3MoE'>> & { useV3MoE?: boolean }
  private experts: Map<ExpertId, ExpertDefinition>
  private expertStatus: Map<ExpertId, ExpertStatus>
  private cache: LRUCache<string, RoutingDecision>
  private metrics: MetricsCollector
  private v3MoE: V3MoERouter | null = null
  private v3SONA: V3SONAOptimizer | null = null
  private initialized = false
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: SONARouterConfig = {}) {
    this.config = {
      ...DEFAULT_SONA_CONFIG,
      ...config,
      fallback: { ...DEFAULT_SONA_CONFIG.fallback, ...config.fallback },
    }

    this.experts = new Map()
    this.expertStatus = new Map()
    for (const expert of this.config.experts) {
      this.experts.set(expert.id, expert)
      this.expertStatus.set(expert.id, this.createInitialStatus(expert.id))
    }

    this.cache = new LRUCache(this.config.cacheMaxSize, this.config.cacheTtlMs)
    this.metrics = new MetricsCollector()
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return

    if (this.config.useV3MoE !== false) {
      await this.initializeV3MoE()
    }

    if (this.config.healthCheckIntervalMs > 0) {
      this.startHealthChecks()
    }

    this.initialized = true
  }

  isInitialized(): boolean {
    return this.initialized
  }

  isUsingV3MoE(): boolean {
    return this.v3MoE !== null
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
    this.cache.clear()
    this.initialized = false
  }

  // ==========================================================================
  // Routing
  // ==========================================================================

  async route(request: ToolRequest): Promise<RoutingDecision> {
    this.ensureInitialized()
    const startTime = Date.now()

    if (this.config.enableCache && request.priority !== 'high') {
      const cacheKey = this.generateCacheKey(request)
      const cached = this.cache.get(cacheKey)
      if (cached) {
        const decision = { ...cached, cacheHit: true }
        this.metrics.recordRouting(request.tool, decision.expertId, Date.now() - startTime, true)
        return decision
      }
    }

    const eligible = this.getEligibleExperts(request)
    if (eligible.length === 0) {
      return this.createFallbackDecision(request, 'NO_ELIGIBLE_EXPERTS', startTime)
    }

    const scoredExperts = this.scoreExperts(eligible, request)
    const decision = this.selectBestExpert(scoredExperts, request, startTime)

    if (this.config.enableCache) {
      const cacheKey = this.generateCacheKey(request)
      this.cache.set(cacheKey, decision)
    }

    this.metrics.recordRouting(request.tool, decision.expertId, decision.decisionTimeMs, false)

    return decision
  }

  async executeWithRouting<T>(
    request: ToolRequest,
    executor: (expertId: ExpertId, request: ToolRequest) => Promise<T>
  ): Promise<ToolResponse<T>> {
    const routingStart = Date.now()
    const decision = await this.route(request)
    const routingTimeMs = Date.now() - routingStart

    const executionStart = Date.now()
    try {
      const data = await executor(decision.expertId, request)
      const executionTimeMs = Date.now() - executionStart

      this.recordOutcome(request, decision.expertId, true)
      this.metrics.recordExecution(executionTimeMs)

      return {
        requestId: request.requestId,
        success: true,
        data,
        meta: {
          expertId: decision.expertId,
          totalTimeMs: routingTimeMs + executionTimeMs,
          routingTimeMs,
          executionTimeMs,
          cacheHit: decision.cacheHit ?? false,
          usedFallback: decision.expertId === 'direct-fallback',
        },
      }
    } catch (error) {
      const executionTimeMs = Date.now() - executionStart

      this.recordOutcome(request, decision.expertId, false)
      this.metrics.recordError(error instanceof Error ? error.name : 'UnknownError')

      if (this.config.fallback.enabled && decision.expertId !== 'direct-fallback') {
        try {
          const fallbackData = await executor('direct-fallback', request)
          return {
            requestId: request.requestId,
            success: true,
            data: fallbackData,
            meta: {
              expertId: 'direct-fallback',
              totalTimeMs: Date.now() - routingStart,
              routingTimeMs,
              executionTimeMs: Date.now() - executionStart - executionTimeMs,
              cacheHit: false,
              usedFallback: true,
            },
          }
        } catch {
          // Fallback also failed
        }
      }

      return {
        requestId: request.requestId,
        success: false,
        error: {
          code: error instanceof Error ? error.name : 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
        meta: {
          expertId: decision.expertId,
          totalTimeMs: routingTimeMs + executionTimeMs,
          routingTimeMs,
          executionTimeMs,
          cacheHit: decision.cacheHit ?? false,
          usedFallback: false,
        },
      }
    }
  }

  // ==========================================================================
  // Expert Management
  // ==========================================================================

  getExpertStatus(): ExpertStatus[] {
    return Array.from(this.expertStatus.values())
  }

  getExpert(expertId: ExpertId): ExpertDefinition | undefined {
    return this.experts.get(expertId)
  }

  updateExpertHealth(expertId: ExpertId, state: ExpertState, load?: number): void {
    const status = this.expertStatus.get(expertId)
    if (status) {
      status.state = state
      if (load !== undefined) status.load = load
      status.lastHealthCheck = new Date()
    }
  }

  // ==========================================================================
  // Metrics
  // ==========================================================================

  getMetrics(): Partial<SONAMetrics> {
    return this.metrics.getMetrics()
  }

  resetMetrics(): void {
    this.metrics.reset()
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SONARouter not initialized. Call initialize() first.')
    }
  }

  private createInitialStatus(expertId: ExpertId): ExpertStatus {
    return {
      id: expertId,
      state: 'healthy',
      load: 0,
      activeRequests: 0,
      successRate: 1.0,
      p95LatencyMs: 0,
      lastHealthCheck: new Date(),
    }
  }

  private async initializeV3MoE(): Promise<void> {
    try {
      const moeModule =
        await import('claude-flow/v3/@claude-flow/cli/dist/src/ruvector/moe-router.js')
      this.v3MoE = moeModule.getMoERouter()
      await this.v3MoE.initialize()

      const sonaModule =
        await import('claude-flow/v3/@claude-flow/cli/dist/src/memory/sona-optimizer.js')
      const sonaOptimizer = await sonaModule.getSONAOptimizer()
      await sonaOptimizer.initialize()
      this.v3SONA = sonaOptimizer

      console.log('[SONARouter] V3 MoE integration initialized')
    } catch {
      console.log('[SONARouter] V3 MoE not available, using local scoring algorithm')
      this.v3MoE = null
      this.v3SONA = null
    }
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks()
    }, this.config.healthCheckIntervalMs)
  }

  private runHealthChecks(): void {
    for (const [_expertId, status] of this.expertStatus) {
      if (status.load > 0.9) {
        status.state = 'degraded'
      } else if (status.load > 0.95) {
        status.state = 'unhealthy'
      } else {
        status.state = 'healthy'
      }
      status.lastHealthCheck = new Date()
    }
  }

  private generateCacheKey(request: ToolRequest): string {
    const argsHash = hashObject(request.arguments)
    return `${request.tool}:${argsHash}`
  }

  private getEligibleExperts(request: ToolRequest): ExpertDefinition[] {
    const eligible: ExpertDefinition[] = []

    for (const [, expert] of this.experts) {
      if (!expert.capabilities.supportedTools.includes(request.tool)) continue

      const status = this.expertStatus.get(expert.id)
      if (!status || status.state === 'unhealthy') continue
      if (status.load >= 0.95) continue

      eligible.push(expert)
    }

    return eligible
  }

  private scoreExperts(
    experts: ExpertDefinition[],
    request: ToolRequest
  ): Array<{ expert: ExpertDefinition; scores: RoutingScores }> {
    const toolWeights = TOOL_WEIGHTS[request.tool]
    const scoredExperts: Array<{ expert: ExpertDefinition; scores: RoutingScores }> = []

    for (const expert of experts) {
      const status = this.expertStatus.get(expert.id)!
      const scores = this.calculateScores(expert, status, toolWeights, request)
      scoredExperts.push({ expert, scores })
    }

    scoredExperts.sort((a, b) => b.scores.totalScore - a.scores.totalScore)
    return scoredExperts
  }

  private calculateScores(
    expert: ExpertDefinition,
    status: ExpertStatus,
    toolWeights: WeightProfile,
    request: ToolRequest
  ): RoutingScores {
    const accuracyScore = expert.capabilities.accuracyScore * (1 - status.load * 0.1)
    const latencyBaseline = 200
    let latencyScore = Math.max(0, 1 - expert.capabilities.avgLatencyMs / latencyBaseline)

    if (request.maxLatencyMs && expert.capabilities.avgLatencyMs > request.maxLatencyMs) {
      latencyScore = latencyScore * 0.5
    }

    const reliabilityScore = status.successRate
    const efficiencyScore = 1 - status.load

    let totalScore =
      toolWeights.accuracy * accuracyScore +
      toolWeights.latency * latencyScore +
      toolWeights.reliability * reliabilityScore +
      toolWeights.efficiency * efficiencyScore

    if (expert.type === 'specialized' && expert.capabilities.supportedTools.length === 1) {
      totalScore = totalScore * 1.1
    }

    totalScore = totalScore + expert.priority / 10000

    return { accuracyScore, latencyScore, reliabilityScore, efficiencyScore, totalScore }
  }

  private selectBestExpert(
    scoredExperts: Array<{ expert: ExpertDefinition; scores: RoutingScores }>,
    request: ToolRequest,
    startTime: number
  ): RoutingDecision {
    const selected = scoredExperts[0]
    const alternatives = scoredExperts.slice(1, 4)

    let confidence: number
    if (alternatives.length > 0) {
      const scoreMargin = selected.scores.totalScore - alternatives[0].scores.totalScore
      confidence = Math.min(1.0, 0.5 + scoreMargin * 2)
    } else {
      confidence = 1.0
    }

    return {
      requestId: request.requestId,
      expertId: selected.expert.id,
      confidence,
      scores: selected.scores,
      alternatives: alternatives.map((alt) => ({
        expertId: alt.expert.id,
        score: alt.scores.totalScore,
        reason: `${alt.expert.name}: score ${alt.scores.totalScore.toFixed(3)}`,
      })),
      reason: this.generateDecisionReason(selected.expert, selected.scores, request.tool),
      decidedAt: new Date(),
      decisionTimeMs: Date.now() - startTime,
    }
  }

  private generateDecisionReason(
    expert: ExpertDefinition,
    scores: RoutingScores,
    tool: ToolType
  ): string {
    const toolWeights = TOOL_WEIGHTS[tool]
    const primaryFactor = toolWeights.accuracy >= toolWeights.latency ? 'accuracy' : 'latency'
    return (
      `Selected ${expert.name} (${expert.type}) for ${tool}: ` +
      `optimized for ${primaryFactor} with score ${scores.totalScore.toFixed(3)}`
    )
  }

  private createFallbackDecision(
    request: ToolRequest,
    reason: string,
    startTime: number
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
      decisionTimeMs: Date.now() - startTime,
    }
  }

  private recordOutcome(request: ToolRequest, expertId: ExpertId, success: boolean): void {
    const status = this.expertStatus.get(expertId)
    if (status) {
      status.successRate = status.successRate * 0.99 + (success ? 0.01 : 0)
    }

    if (this.v3SONA) {
      this.v3SONA.processTrajectoryOutcome({
        trajectoryId: request.requestId,
        task: `${request.tool}:${JSON.stringify(request.arguments)}`,
        agent: expertId,
        success,
      })
    }

    if (this.v3MoE) {
      this.v3MoE.updateExpertWeights(expertId, success ? 1.0 : -0.5)
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and initialize a SONARouter instance
 */
export async function createSONARouter(config?: SONARouterConfig): Promise<SONARouter> {
  const router = new SONARouter(config)
  await router.initialize()
  return router
}
