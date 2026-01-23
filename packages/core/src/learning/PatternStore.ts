/**
 * PatternStore with EWC++ for catastrophic forgetting prevention
 * @module @skillsmith/core/learning/PatternStore
 * @see https://arxiv.org/abs/1801.10112 (Progress & Compress)
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { EmbeddingService } from '../embeddings/index.js'

// Re-export public API types and constants
export type {
  EWCConfig,
  PatternStoreConfig,
  PatternOutcomeType,
  PatternOutcome,
  PatternRecommendationContext,
  SkillFeatures,
  Pattern,
  StoredPattern,
  PatternQuery,
  SimilarPattern,
  ConsolidationResult,
  PatternStoreMetrics,
  ConsolidationState,
  PatternRow,
} from './PatternStore.types.js'
export {
  DEFAULT_EWC_CONFIG,
  DEFAULT_PATTERN_STORE_CONFIG,
  PATTERN_REWARDS,
} from './PatternStore.types.js'
export type { IFisherInformationMatrix } from './PatternStore.helpers.js'
export { FisherInformationMatrix } from './PatternStore.helpers.js'

// Internal imports
import type {
  EWCConfig,
  PatternStoreConfig,
  PatternOutcome,
  Pattern,
  PatternQuery,
  SimilarPattern,
  ConsolidationResult,
  PatternStoreMetrics,
  ConsolidationState,
  PatternRow,
} from './PatternStore.types.js'
import { DEFAULT_EWC_CONFIG, DEFAULT_PATTERN_STORE_CONFIG } from './PatternStore.types.js'
import {
  PATTERN_STORE_SCHEMA,
  FisherInformationMatrix,
  contextToText,
  computeGradient,
  deserializeEmbedding,
  cosineSimilarity,
  importanceWeightedSimilarity,
  calculatePatternImportance,
  calculateDimensionImportance,
  rowToStoredPattern,
} from './PatternStore.helpers.js'
import {
  getPatternCount,
  getDatabaseSize,
  getSamplePatterns,
  getAllPatterns,
  updatePatternInDB,
  updatePatternImportance,
  updateAccessCount,
  deletePattern,
  loadFisherMatrixData,
  saveFisherMatrixData,
  recordConsolidation,
  getPatternsByOutcome,
  getAverageImportance,
  getHighImportanceCount,
  getConsolidationStats,
  getContextEmbeddings,
} from './PatternStore.queries.js'

/** PatternStore - EWC++ pattern storage for successful recommendation matches */
export class PatternStore {
  private db!: Database.Database
  private fisherMatrix!: FisherInformationMatrix
  private embeddingService!: EmbeddingService
  private consolidationState: ConsolidationState
  private config: Required<Omit<PatternStoreConfig, 'dbPath'>> & { dbPath?: string }
  private ewcConfig: EWCConfig
  private initialized = false
  private queryLatencies: number[] = []
  private maxQuerySamples = 100

  constructor(config: PatternStoreConfig = {}) {
    this.config = {
      ...DEFAULT_PATTERN_STORE_CONFIG,
      ...config,
      ewc: { ...DEFAULT_EWC_CONFIG, ...config.ewc },
    }
    this.ewcConfig = this.config.ewc as EWCConfig
    this.consolidationState = {
      lastConsolidation: null,
      patternsSinceLastConsolidation: 0,
      totalPatterns: 0,
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    this.db = new Database(this.config.dbPath || ':memory:')
    this.db.exec(PATTERN_STORE_SCHEMA)
    this.fisherMatrix = new FisherInformationMatrix(this.config.dimensions)
    this.loadFisherMatrix()
    this.embeddingService = new EmbeddingService({ useFallback: true })
    this.consolidationState.totalPatterns = getPatternCount(this.db)

    // IMPORTANT: Keep dynamic import here for lazy loading / graceful degradation
    if (this.config.useV3Integration) {
      await this.initializeV3Integration()
    }

    this.initialized = true
  }

  isInitialized(): boolean {
    return this.initialized
  }

  private async initializeV3Integration(): Promise<void> {
    try {
      await import(
        // @ts-expect-error - V3 types not available at compile time
        'claude-flow/v3/@claude-flow/cli/dist/src/intelligence/index.js'
      )
      console.log('[PatternStore] V3 ReasoningBank integration enabled')
    } catch {
      console.log('[PatternStore] V3 not available, using standalone mode')
    }
  }

  async storePattern(pattern: Pattern, outcome: PatternOutcome): Promise<string> {
    this.ensureInitialized()

    const contextText = contextToText(pattern.context)
    const contextEmbedding = await this.embeddingService.embed(contextText)

    const existingPatterns = await this.findSimilarPatterns(
      { context: pattern.context, skillId: pattern.skill.skillId, positiveOnly: false },
      5
    )

    if (existingPatterns.length > 0 && existingPatterns[0].similarity > 0.95) {
      const existingPattern = existingPatterns[0].pattern
      const gradient = computeGradient(contextEmbedding, existingPattern.contextEmbedding)
      this.fisherMatrix.update(gradient)

      const newImportance = calculatePatternImportance(existingPattern, outcome)
      updatePatternInDB(this.db, existingPattern.id, {
        importance: newImportance,
        accessCount: existingPattern.accessCount + 1,
      })
      return existingPattern.id
    }

    let baseImportance = Math.abs(outcome.reward)
    if (outcome.reward > 0) baseImportance *= 1.5
    if (outcome.confidence !== undefined) baseImportance *= outcome.confidence
    const importance = baseImportance * this.ewcConfig.importanceThreshold * 10

    const patternId = pattern.id || randomUUID()
    const stmt = this.db.prepare(`
      INSERT INTO patterns (
        pattern_id, context_embedding, skill_id, skill_features, context_data,
        outcome_type, outcome_reward, importance, original_score, source,
        access_count, created_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, unixepoch(), unixepoch())
    `)
    stmt.run(
      patternId,
      Buffer.from(contextEmbedding.buffer),
      pattern.skill.skillId,
      JSON.stringify(pattern.skill),
      JSON.stringify(pattern.context),
      outcome.type,
      outcome.reward,
      importance,
      pattern.originalScore,
      pattern.source
    )

    const avgEmbedding = await this.computeAverageEmbedding()
    const gradient = computeGradient(contextEmbedding, avgEmbedding)
    this.fisherMatrix.update(gradient)

    this.consolidationState.patternsSinceLastConsolidation++
    this.consolidationState.totalPatterns++

    if (this.config.autoConsolidate && this.shouldConsolidate()) {
      await this.consolidate()
    }

    this.saveFisherMatrix()
    return patternId
  }

  async findSimilarPatterns(query: PatternQuery, limit: number = 10): Promise<SimilarPattern[]> {
    this.ensureInitialized()
    const startTime = Date.now()

    const queryText = contextToText(query.context)
    const queryEmbedding = await this.embeddingService.embed(queryText)

    let sql = 'SELECT * FROM patterns WHERE 1=1'
    const params: unknown[] = []

    if (query.skillId) {
      sql += ' AND skill_id = ?'
      params.push(query.skillId)
    }
    if (query.category) {
      sql += " AND json_extract(skill_features, '$.category') = ?"
      params.push(query.category)
    }
    if (query.minImportance !== undefined) {
      sql += ' AND importance >= ?'
      params.push(query.minImportance)
    }
    if (query.outcomeType) {
      sql += ' AND outcome_type = ?'
      params.push(query.outcomeType)
    }
    if (query.positiveOnly) {
      sql += ' AND outcome_reward > 0'
    }

    const stmt = this.db.prepare(sql)
    const candidates = stmt.all(...params) as PatternRow[]
    const importanceVector = this.fisherMatrix.getImportanceVector()
    const results: SimilarPattern[] = []

    for (const candidate of candidates) {
      const candidateEmbedding = deserializeEmbedding(
        candidate.context_embedding,
        this.config.dimensions
      )
      const similarity = cosineSimilarity(queryEmbedding, candidateEmbedding)
      const weightedSimilarity = importanceWeightedSimilarity(
        queryEmbedding,
        candidateEmbedding,
        importanceVector
      )
      results.push({
        pattern: rowToStoredPattern(candidate, this.config.dimensions),
        similarity,
        weightedSimilarity,
        rank: 0,
      })
    }

    results.sort((a, b) => b.weightedSimilarity - a.weightedSimilarity)
    for (let i = 0; i < results.length; i++) {
      results[i].rank = i + 1
    }

    if (this.config.trackAccess) {
      for (const result of results.slice(0, limit)) {
        updateAccessCount(this.db, result.pattern.id)
      }
    }

    const latency = Date.now() - startTime
    this.queryLatencies.push(latency)
    if (this.queryLatencies.length > this.maxQuerySamples) {
      this.queryLatencies.shift()
    }

    return results.slice(0, limit)
  }

  async consolidate(): Promise<ConsolidationResult> {
    this.ensureInitialized()
    const startTime = Date.now()

    const totalPatterns = getPatternCount(this.db)
    const newPatternsRatio =
      totalPatterns > 0 ? this.consolidationState.patternsSinceLastConsolidation / totalPatterns : 0

    if (newPatternsRatio < this.ewcConfig.consolidationThreshold) {
      return {
        consolidated: false,
        patternsProcessed: 0,
        patternsPreserved: 0,
        patternsPruned: 0,
        preservationRate: 1.0,
        durationMs: 0,
        averageImportance: this.fisherMatrix.getAverageImportance(),
      }
    }

    this.fisherMatrix.decay(this.ewcConfig.fisherDecay)

    const samplePatterns = getSamplePatterns(
      this.db,
      this.ewcConfig.fisherSampleSize,
      this.config.dimensions
    )
    const avgEmbedding = await this.computeAverageEmbedding()

    for (const pattern of samplePatterns) {
      const gradient = computeGradient(pattern.contextEmbedding, avgEmbedding)
      this.fisherMatrix.update(gradient)
    }

    const allPatterns = getAllPatterns(this.db, this.config.dimensions)
    const importanceVector = this.fisherMatrix.getImportanceVector()

    for (const pattern of allPatterns) {
      const newImportance = calculateDimensionImportance(
        pattern,
        importanceVector,
        this.config.dimensions,
        this.ewcConfig.lambda
      )
      updatePatternImportance(this.db, pattern.id, newImportance)
    }

    let prunedCount = 0
    let preservedCount = 0
    const sortedPatterns = [...allPatterns].sort((a, b) => a.importance - b.importance)

    if (sortedPatterns.length > this.ewcConfig.maxPatterns) {
      const pruneCandidates = sortedPatterns.slice(
        0,
        sortedPatterns.length - this.ewcConfig.maxPatterns
      )
      for (const candidate of pruneCandidates) {
        if (candidate.importance < this.ewcConfig.importanceThreshold) {
          deletePattern(this.db, candidate.id)
          prunedCount++
        } else {
          preservedCount++
        }
      }
      preservedCount += this.ewcConfig.maxPatterns
    } else {
      for (const pattern of sortedPatterns) {
        if (pattern.importance < this.ewcConfig.importanceThreshold * 0.1) {
          deletePattern(this.db, pattern.id)
          prunedCount++
        } else {
          preservedCount++
        }
      }
    }

    const preservationRate = preservedCount / (preservedCount + prunedCount) || 1.0
    this.consolidationState.lastConsolidation = new Date()
    this.consolidationState.patternsSinceLastConsolidation = 0
    this.consolidationState.totalPatterns = getPatternCount(this.db)

    const durationMs = Date.now() - startTime
    const avgImportance = this.fisherMatrix.getAverageImportance()

    recordConsolidation(
      this.db,
      preservedCount + prunedCount,
      preservedCount,
      prunedCount,
      preservationRate,
      durationMs,
      avgImportance
    )

    this.saveFisherMatrix()

    return {
      consolidated: true,
      patternsProcessed: preservedCount + prunedCount,
      patternsPreserved: preservedCount,
      patternsPruned: prunedCount,
      preservationRate,
      durationMs,
      averageImportance: avgImportance,
    }
  }

  getPatternImportance(patternId: string): number {
    this.ensureInitialized()
    const stmt = this.db.prepare('SELECT importance FROM patterns WHERE pattern_id = ?')
    const result = stmt.get(patternId) as { importance: number } | undefined
    return result?.importance ?? 0
  }

  getMetrics(): PatternStoreMetrics {
    this.ensureInitialized()

    const totalPatterns = getPatternCount(this.db)
    const patternsByOutcome = getPatternsByOutcome(this.db)
    const averageImportance = getAverageImportance(this.db)
    const highImportancePatterns = getHighImportanceCount(this.db)
    const consolidationStats = getConsolidationStats(this.db)

    const avgLatency =
      this.queryLatencies.length > 0
        ? this.queryLatencies.reduce((a, b) => a + b, 0) / this.queryLatencies.length
        : 0

    return {
      totalPatterns,
      patternsByOutcome,
      averageImportance,
      highImportancePatterns,
      consolidation: {
        totalConsolidations: consolidationStats.total,
        lastConsolidation: consolidationStats.lastTimestamp
          ? new Date(consolidationStats.lastTimestamp * 1000)
          : null,
        averagePreservationRate: consolidationStats.avgRate ?? 1.0,
        patternsPruned: consolidationStats.totalPruned ?? 0,
      },
      storage: {
        sizeBytes: getDatabaseSize(this.db),
        fisherMatrixSizeBytes: 4 + this.config.dimensions * 4 * 2,
      },
      queryPerformance: {
        averageLatencyMs: avgLatency,
        queriesPerformed: this.queryLatencies.length,
      },
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
    }
  }

  // Private helpers
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('PatternStore not initialized. Call initialize() first.')
    }
  }

  private async computeAverageEmbedding(): Promise<Float32Array> {
    const rows = getContextEmbeddings(this.db, 100)
    if (rows.length === 0) {
      return new Float32Array(this.config.dimensions)
    }

    const sum = new Float32Array(this.config.dimensions)
    for (const row of rows) {
      const embedding = deserializeEmbedding(row.context_embedding, this.config.dimensions)
      for (let i = 0; i < embedding.length; i++) {
        sum[i] += embedding[i]
      }
    }

    for (let i = 0; i < sum.length; i++) {
      sum[i] /= rows.length
    }
    return sum
  }

  private shouldConsolidate(): boolean {
    if (this.consolidationState.lastConsolidation) {
      const hoursSinceLast =
        (Date.now() - this.consolidationState.lastConsolidation.getTime()) / (60 * 60 * 1000)
      if (hoursSinceLast < 1) return false
    }
    if (this.consolidationState.totalPatterns === 0) return false

    const newPatternsRatio =
      this.consolidationState.patternsSinceLastConsolidation / this.consolidationState.totalPatterns
    if (newPatternsRatio >= this.ewcConfig.consolidationThreshold) return true
    if (this.consolidationState.totalPatterns > this.ewcConfig.maxPatterns * 0.9) return true

    return false
  }

  private loadFisherMatrix(): void {
    const matrixData = loadFisherMatrixData(this.db)
    if (matrixData) {
      try {
        this.fisherMatrix.deserialize(matrixData)
      } catch {
        console.warn('[PatternStore] Fisher matrix data corrupted, resetting')
        this.fisherMatrix.reset()
      }
    }
  }

  private saveFisherMatrix(): void {
    const matrixData = this.fisherMatrix.serialize()
    saveFisherMatrixData(this.db, matrixData, this.fisherMatrix.getUpdateCount())
  }
}

/**
 * Create and initialize a PatternStore instance
 */
export async function createPatternStore(config: PatternStoreConfig = {}): Promise<PatternStore> {
  const store = new PatternStore(config)
  await store.initialize()
  return store
}
