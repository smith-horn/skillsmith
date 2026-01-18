/**
 * @fileoverview PatternStore with EWC++ for catastrophic forgetting prevention
 * @module @skillsmith/core/learning/PatternStore
 * @see SMI-1522: Add EWC++ pattern storage for successful matches
 *
 * Implements Elastic Weight Consolidation++ (EWC++) to store successful
 * recommendation patterns without catastrophic forgetting. Unlike traditional
 * storage that overwrites old patterns, EWC++ preserves important learned
 * patterns while integrating new ones.
 *
 * Key capabilities:
 * - storePattern(): Encodes successful matches with Fisher Information tracking
 * - findSimilarPatterns(): Retrieves relevant patterns using importance-weighted similarity
 * - consolidate(): Updates Fisher Information matrix without forgetting important patterns
 * - 95%+ pattern preservation: New patterns do not overwrite important historical patterns
 *
 * @see https://arxiv.org/abs/1801.10112 (Progress & Compress)
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { EmbeddingService } from '../embeddings/index.js'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * EWC++ algorithm configuration
 *
 * @see https://arxiv.org/abs/1801.10112 (Progress & Compress)
 */
export interface EWCConfig {
  /**
   * Lambda (regularization strength).
   * Higher values = stronger preservation of old patterns.
   *
   * - 0.1-1.0: Allows more plasticity (learning new patterns)
   * - 1.0-10.0: Balanced preservation and learning
   * - 10.0-100.0: Strong preservation (minimal forgetting)
   *
   * @default 5.0
   */
  lambda: number

  /**
   * Decay factor for online Fisher Information updates.
   * Applied to running sum before adding new gradient squared.
   *
   * - 0.9: Fast decay, recent patterns dominate
   * - 0.99: Slow decay, historical patterns preserved longer
   * - 1.0: No decay (original EWC, not recommended)
   *
   * @default 0.95
   */
  fisherDecay: number

  /**
   * Minimum importance threshold for pattern preservation.
   * Patterns below this threshold are eligible for overwriting.
   *
   * @default 0.01
   */
  importanceThreshold: number

  /**
   * Number of patterns to sample for Fisher Information estimation.
   * Higher values = more accurate importance estimates but slower.
   *
   * @default 100
   */
  fisherSampleSize: number

  /**
   * Consolidation trigger threshold.
   * Consolidate when (new_patterns / total_patterns) exceeds this.
   *
   * @default 0.1 (10%)
   */
  consolidationThreshold: number

  /**
   * Maximum patterns to retain before pruning low-importance ones.
   *
   * @default 10000
   */
  maxPatterns: number
}

/**
 * PatternStore configuration
 */
export interface PatternStoreConfig {
  /**
   * Path to SQLite database for pattern storage.
   * If not provided, uses in-memory database.
   */
  dbPath?: string

  /**
   * EWC++ algorithm parameters.
   */
  ewc?: Partial<EWCConfig>

  /**
   * Embedding dimensions (must match embedding model).
   * @default 384 (all-MiniLM-L6-v2)
   */
  dimensions?: number

  /**
   * Enable automatic consolidation on pattern insertion.
   * @default true
   */
  autoConsolidate?: boolean

  /**
   * Enable pattern access tracking for importance boosting.
   * @default true
   */
  trackAccess?: boolean

  /**
   * Enable V3 ReasoningBank integration.
   * @default true (auto-detect)
   */
  useV3Integration?: boolean
}

/**
 * Default EWC++ configuration
 */
export const DEFAULT_EWC_CONFIG: EWCConfig = {
  lambda: 5.0,
  fisherDecay: 0.95,
  importanceThreshold: 0.01,
  fisherSampleSize: 100,
  consolidationThreshold: 0.1,
  maxPatterns: 10000,
}

/**
 * Default PatternStore configuration
 */
export const DEFAULT_PATTERN_STORE_CONFIG: Required<Omit<PatternStoreConfig, 'dbPath'>> & {
  dbPath?: string
} = {
  dbPath: undefined,
  ewc: DEFAULT_EWC_CONFIG,
  dimensions: 384,
  autoConsolidate: true,
  trackAccess: true,
  useV3Integration: true,
}

/**
 * Pattern outcome types aligned with ReasoningBankIntegration rewards
 *
 * @see ReasoningBankIntegration.TRAJECTORY_REWARDS
 */
export type PatternOutcomeType =
  | 'accept' // User accepted recommendation (+1.0)
  | 'usage' // User actively uses skill (+0.3)
  | 'frequent' // User uses skill frequently (+0.5)
  | 'dismiss' // User dismissed recommendation (-0.5)
  | 'abandonment' // Skill installed but unused (-0.3)
  | 'uninstall' // User removed skill (-0.7)

/**
 * Outcome result for a pattern
 */
export interface PatternOutcome {
  /** Type of outcome */
  type: PatternOutcomeType

  /** Reward value [-1.0, 1.0] */
  reward: number

  /** Confidence in this outcome (for partial observations) */
  confidence?: number

  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Reward values for pattern outcomes
 * Matches ReasoningBankIntegration.TRAJECTORY_REWARDS
 */
export const PATTERN_REWARDS: Record<PatternOutcomeType, number> = {
  accept: 1.0,
  usage: 0.3,
  frequent: 0.5,
  dismiss: -0.5,
  abandonment: -0.3,
  uninstall: -0.7,
}

/**
 * Context that led to a recommendation
 */
export interface PatternRecommendationContext {
  /** User's current installed skills */
  installedSkills: string[]

  /** Frameworks/languages detected in project */
  frameworks?: string[]

  /** Keywords from user query or context */
  keywords?: string[]

  /** Time of day (for temporal patterns) */
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night'

  /** Day type (for usage patterns) */
  dayType?: 'weekday' | 'weekend'

  /** Session duration in minutes */
  sessionDuration?: number

  /** Number of recommendations shown in session */
  recommendationsShown?: number
}

/**
 * Skill features used in pattern matching
 */
export interface SkillFeatures {
  /** Skill identifier (author/name format) */
  skillId: string

  /** Skill category */
  category?: string

  /** Trust tier (verified, community, experimental) */
  trustTier?: string

  /** Skill keywords/tags */
  keywords?: string[]

  /** Trigger phrases */
  triggerPhrases?: string[]

  /** Quality score [0-100] */
  qualityScore?: number

  /** Install count */
  installCount?: number
}

/**
 * Complete pattern definition
 */
export interface Pattern {
  /** Unique pattern identifier (auto-generated if not provided) */
  id?: string

  /** Recommendation context that led to this match */
  context: PatternRecommendationContext

  /** Skill that was recommended */
  skill: SkillFeatures

  /** Original recommendation score [0-1] */
  originalScore: number

  /** Source of the recommendation (search, recommend, install) */
  source: 'search' | 'recommend' | 'install' | 'compare'
}

/**
 * Stored pattern with computed fields
 */
export interface StoredPattern extends Pattern {
  /** Pattern ID (guaranteed after storage) */
  id: string

  /** Context embedding vector */
  contextEmbedding: Float32Array

  /** Pattern outcome */
  outcome: PatternOutcome

  /** Pattern importance (from Fisher Information) */
  importance: number

  /** Number of times this pattern was accessed */
  accessCount: number

  /** Creation timestamp */
  createdAt: Date

  /** Last access timestamp */
  lastAccessedAt: Date
}

/**
 * Pattern query for similarity search
 */
export interface PatternQuery {
  /** Context to match against */
  context: PatternRecommendationContext

  /** Optional skill to filter by */
  skillId?: string

  /** Optional category filter */
  category?: string

  /** Minimum importance threshold */
  minImportance?: number

  /** Outcome type filter */
  outcomeType?: PatternOutcomeType

  /** Only positive outcomes (accept, usage, frequent) */
  positiveOnly?: boolean
}

/**
 * Similar pattern result
 */
export interface SimilarPattern {
  /** The matched pattern */
  pattern: StoredPattern

  /** Similarity score [0-1] */
  similarity: number

  /** Importance-weighted similarity */
  weightedSimilarity: number

  /** Rank in results */
  rank: number
}

/**
 * Consolidation operation result
 */
export interface ConsolidationResult {
  /** Whether consolidation was performed */
  consolidated: boolean

  /** Patterns processed during consolidation */
  patternsProcessed: number

  /** Patterns preserved (importance above threshold) */
  patternsPreserved: number

  /** Patterns pruned (importance below threshold) */
  patternsPruned: number

  /** Preservation rate (should be >= 0.95) */
  preservationRate: number

  /** Time taken in milliseconds */
  durationMs: number

  /** New average importance after consolidation */
  averageImportance: number
}

/**
 * PatternStore metrics for monitoring
 */
export interface PatternStoreMetrics {
  /** Total patterns stored */
  totalPatterns: number

  /** Patterns by outcome type */
  patternsByOutcome: Record<PatternOutcomeType, number>

  /** Average pattern importance */
  averageImportance: number

  /** High importance patterns (above 90th percentile) */
  highImportancePatterns: number

  /** Consolidation statistics */
  consolidation: {
    totalConsolidations: number
    lastConsolidation: Date | null
    averagePreservationRate: number
    patternsPruned: number
  }

  /** Storage statistics */
  storage: {
    sizeBytes: number
    fisherMatrixSizeBytes: number
  }

  /** Query performance */
  queryPerformance: {
    averageLatencyMs: number
    queriesPerformed: number
  }
}

// ============================================================================
// Fisher Information Matrix
// ============================================================================

/**
 * Fisher Information Matrix interface
 */
export interface IFisherInformationMatrix {
  getImportance(dimensionIndex: number): number
  update(gradient: Float32Array): void
  decay(decayFactor: number): void
  getImportanceVector(): Float32Array
  getAverageImportance(): number
  serialize(): Buffer
  deserialize(buffer: Buffer): void
  reset(): void
}

/**
 * Fisher Information Matrix implementation for EWC++
 *
 * Stores diagonal approximation of Fisher Information,
 * indicating which "weights" (pattern dimensions) are important.
 *
 * In the context of pattern storage:
 * - Each dimension of the context embedding has an importance value
 * - High importance = changing this dimension would harm prediction
 * - Low importance = safe to overwrite with new patterns
 */
export class FisherInformationMatrix implements IFisherInformationMatrix {
  /** Diagonal of Fisher Information (importance per dimension) */
  private importance: Float32Array

  /** Running sum for online updates */
  private runningSum: Float32Array

  /** Number of updates performed */
  private updateCount: number = 0

  constructor(private dimensions: number) {
    this.importance = new Float32Array(dimensions)
    this.runningSum = new Float32Array(dimensions)
  }

  getImportance(dimensionIndex: number): number {
    return this.importance[dimensionIndex] ?? 0
  }

  update(gradient: Float32Array): void {
    // EWC++: F = decay * F + gradient^2
    for (let i = 0; i < Math.min(gradient.length, this.dimensions); i++) {
      this.runningSum[i] += gradient[i] * gradient[i]
    }
    this.updateCount++

    // Update importance as running mean
    for (let i = 0; i < this.importance.length; i++) {
      this.importance[i] = this.runningSum[i] / this.updateCount
    }
  }

  decay(decayFactor: number): void {
    for (let i = 0; i < this.runningSum.length; i++) {
      this.runningSum[i] *= decayFactor
    }
    // Recalculate importance after decay
    for (let i = 0; i < this.importance.length; i++) {
      this.importance[i] = this.runningSum[i] / Math.max(1, this.updateCount)
    }
  }

  getImportanceVector(): Float32Array {
    return new Float32Array(this.importance)
  }

  getAverageImportance(): number {
    let sum = 0
    for (let i = 0; i < this.importance.length; i++) {
      sum += this.importance[i]
    }
    return sum / this.importance.length
  }

  serialize(): Buffer {
    const buffer = Buffer.alloc(
      4 + // updateCount
        4 * this.importance.length + // importance
        4 * this.runningSum.length // runningSum
    )

    buffer.writeUInt32LE(this.updateCount, 0)
    Buffer.from(this.importance.buffer).copy(buffer, 4)
    Buffer.from(this.runningSum.buffer).copy(buffer, 4 + 4 * this.importance.length)

    return buffer
  }

  deserialize(buffer: Buffer): void {
    const expectedSize = 4 + 4 * this.dimensions * 2
    if (buffer.length < expectedSize) {
      throw new Error(
        `Invalid Fisher matrix buffer: expected ${expectedSize} bytes, got ${buffer.length}`
      )
    }

    this.updateCount = buffer.readUInt32LE(0)

    const importanceOffset = 4
    const runningSumOffset = 4 + 4 * this.dimensions

    // Copy importance values
    for (let i = 0; i < this.dimensions; i++) {
      this.importance[i] = buffer.readFloatLE(importanceOffset + i * 4)
    }

    // Copy runningSum values
    for (let i = 0; i < this.dimensions; i++) {
      this.runningSum[i] = buffer.readFloatLE(runningSumOffset + i * 4)
    }
  }

  reset(): void {
    this.importance.fill(0)
    this.runningSum.fill(0)
    this.updateCount = 0
  }

  getUpdateCount(): number {
    return this.updateCount
  }
}

// ============================================================================
// PatternStore Implementation
// ============================================================================

/**
 * SQLite schema for pattern storage
 */
const PATTERN_STORE_SCHEMA = `
-- Patterns table: stores recommendation patterns with outcomes
CREATE TABLE IF NOT EXISTS patterns (
  pattern_id TEXT PRIMARY KEY,
  context_embedding BLOB NOT NULL,
  skill_id TEXT NOT NULL,
  skill_features TEXT NOT NULL,
  context_data TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  outcome_reward REAL NOT NULL,
  importance REAL NOT NULL DEFAULT 0.1,
  original_score REAL NOT NULL,
  source TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_patterns_skill_id ON patterns(skill_id);
CREATE INDEX IF NOT EXISTS idx_patterns_outcome_type ON patterns(outcome_type);
CREATE INDEX IF NOT EXISTS idx_patterns_importance ON patterns(importance DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_created_at ON patterns(created_at DESC);

-- Fisher Information matrix state
CREATE TABLE IF NOT EXISTS fisher_info (
  id INTEGER PRIMARY KEY DEFAULT 1,
  matrix_data BLOB NOT NULL,
  update_count INTEGER NOT NULL DEFAULT 0,
  last_decay_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Consolidation history for monitoring
CREATE TABLE IF NOT EXISTS consolidation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  patterns_processed INTEGER NOT NULL,
  patterns_preserved INTEGER NOT NULL,
  patterns_pruned INTEGER NOT NULL,
  preservation_rate REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  average_importance REAL NOT NULL
);
`

/**
 * Internal consolidation state
 */
interface ConsolidationState {
  lastConsolidation: Date | null
  patternsSinceLastConsolidation: number
  totalPatterns: number
}

/**
 * PatternStore - EWC++ pattern storage for successful recommendation matches
 *
 * Prevents catastrophic forgetting by tracking which pattern dimensions
 * are important via Fisher Information Matrix and preserving high-importance
 * patterns during consolidation.
 *
 * @example
 * ```typescript
 * const store = new PatternStore({ dbPath: './patterns.db' })
 * await store.initialize()
 *
 * // Store a successful pattern
 * await store.storePattern(
 *   {
 *     context: { installedSkills: ['commit'], frameworks: ['react'] },
 *     skill: { skillId: 'jest-helper', category: 'testing' },
 *     originalScore: 0.85,
 *     source: 'recommend'
 *   },
 *   { type: 'accept', reward: 1.0 }
 * )
 *
 * // Find similar patterns
 * const similar = await store.findSimilarPatterns({
 *   context: { installedSkills: ['commit'], frameworks: ['react', 'typescript'] }
 * })
 * ```
 */
export class PatternStore {
  private db!: Database.Database
  private fisherMatrix!: FisherInformationMatrix
  private embeddingService!: EmbeddingService
  private consolidationState: ConsolidationState
  private config: Required<Omit<PatternStoreConfig, 'dbPath'>> & { dbPath?: string }
  private ewcConfig: EWCConfig
  private initialized = false

  // Query performance tracking
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

  /**
   * Initialize the PatternStore
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // Initialize database
    this.db = new Database(this.config.dbPath || ':memory:')
    this.db.exec(PATTERN_STORE_SCHEMA)

    // Initialize Fisher Information Matrix
    this.fisherMatrix = new FisherInformationMatrix(this.config.dimensions)

    // Load persisted Fisher matrix if exists
    this.loadFisherMatrix()

    // Initialize embedding service (fallback mode for context encoding)
    this.embeddingService = new EmbeddingService({ useFallback: true })

    // Load consolidation state
    this.consolidationState.totalPatterns = this.getPatternCount()

    // Try V3 integration
    if (this.config.useV3Integration) {
      await this.initializeV3Integration()
    }

    this.initialized = true
  }

  /**
   * Check if PatternStore is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Attempt to initialize V3 ReasoningBank integration
   */
  private async initializeV3Integration(): Promise<void> {
    try {
      // Attempt to import V3 ReasoningBank for future integration
      await import(
        // @ts-expect-error - V3 types not available at compile time
        'claude-flow/v3/@claude-flow/cli/dist/src/intelligence/index.js'
      )
      console.log('[PatternStore] V3 ReasoningBank integration enabled')
    } catch {
      console.log('[PatternStore] V3 not available, using standalone mode')
    }
  }

  /**
   * Store a pattern with EWC++ protection
   *
   * @param pattern - Pattern to store
   * @param outcome - Outcome of the recommendation
   * @returns Pattern ID
   */
  async storePattern(pattern: Pattern, outcome: PatternOutcome): Promise<string> {
    this.ensureInitialized()

    // Generate context embedding
    const contextText = this.contextToText(pattern.context)
    const contextEmbedding = await this.embeddingService.embed(contextText)

    // Check for similar existing pattern
    const existingPatterns = await this.findSimilarPatterns(
      {
        context: pattern.context,
        skillId: pattern.skill.skillId,
        positiveOnly: false,
      },
      5
    )

    if (existingPatterns.length > 0 && existingPatterns[0].similarity > 0.95) {
      // Update existing pattern instead of creating new
      const existingPattern = existingPatterns[0].pattern
      const gradient = this.computeGradient(contextEmbedding, existingPattern.contextEmbedding)
      this.fisherMatrix.update(gradient)

      const newImportance = this.calculatePatternImportance(existingPattern, outcome)
      this.updatePatternInDB(existingPattern.id, {
        importance: newImportance,
        accessCount: existingPattern.accessCount + 1,
      })

      return existingPattern.id
    }

    // Calculate initial importance
    let baseImportance = Math.abs(outcome.reward)
    if (outcome.reward > 0) {
      baseImportance *= 1.5
    }
    if (outcome.confidence !== undefined) {
      baseImportance *= outcome.confidence
    }
    const importance = baseImportance * this.ewcConfig.importanceThreshold * 10

    // Store new pattern
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

    // Update Fisher Information
    const avgEmbedding = await this.computeAverageEmbedding()
    const gradient = this.computeGradient(contextEmbedding, avgEmbedding)
    this.fisherMatrix.update(gradient)

    // Update consolidation state
    this.consolidationState.patternsSinceLastConsolidation++
    this.consolidationState.totalPatterns++

    // Trigger consolidation if needed
    if (this.config.autoConsolidate && this.shouldConsolidate()) {
      await this.consolidate()
    }

    // Persist Fisher matrix
    this.saveFisherMatrix()

    return patternId
  }

  /**
   * Find similar patterns using importance-weighted similarity
   *
   * @param query - Pattern query
   * @param limit - Maximum results
   * @returns Similar patterns sorted by weighted similarity
   */
  async findSimilarPatterns(query: PatternQuery, limit: number = 10): Promise<SimilarPattern[]> {
    this.ensureInitialized()
    const startTime = Date.now()

    // Generate query embedding
    const queryText = this.contextToText(query.context)
    const queryEmbedding = await this.embeddingService.embed(queryText)

    // Build SQL query with filters
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

    // Fetch candidate patterns
    const stmt = this.db.prepare(sql)
    const candidates = stmt.all(...params) as Array<{
      pattern_id: string
      context_embedding: Buffer
      skill_id: string
      skill_features: string
      context_data: string
      outcome_type: string
      outcome_reward: number
      importance: number
      original_score: number
      source: string
      access_count: number
      created_at: number
      last_accessed_at: number
    }>

    // Calculate similarity scores
    const importanceVector = this.fisherMatrix.getImportanceVector()
    const results: SimilarPattern[] = []

    for (const candidate of candidates) {
      const candidateEmbedding = this.deserializeEmbedding(candidate.context_embedding)

      const similarity = this.cosineSimilarity(queryEmbedding, candidateEmbedding)
      const weightedSimilarity = this.importanceWeightedSimilarity(
        queryEmbedding,
        candidateEmbedding,
        importanceVector
      )

      const storedPattern: StoredPattern = {
        id: candidate.pattern_id,
        context: JSON.parse(candidate.context_data),
        skill: JSON.parse(candidate.skill_features),
        originalScore: candidate.original_score,
        source: candidate.source as Pattern['source'],
        contextEmbedding: candidateEmbedding,
        outcome: {
          type: candidate.outcome_type as PatternOutcomeType,
          reward: candidate.outcome_reward,
        },
        importance: candidate.importance,
        accessCount: candidate.access_count,
        createdAt: new Date(candidate.created_at * 1000),
        lastAccessedAt: new Date(candidate.last_accessed_at * 1000),
      }

      results.push({
        pattern: storedPattern,
        similarity,
        weightedSimilarity,
        rank: 0,
      })
    }

    // Sort by weighted similarity
    results.sort((a, b) => b.weightedSimilarity - a.weightedSimilarity)

    // Assign ranks
    for (let i = 0; i < results.length; i++) {
      results[i].rank = i + 1
    }

    // Update access tracking
    if (this.config.trackAccess) {
      for (const result of results.slice(0, limit)) {
        this.updateAccessCount(result.pattern.id)
      }
    }

    // Track query latency
    const latency = Date.now() - startTime
    this.queryLatencies.push(latency)
    if (this.queryLatencies.length > this.maxQuerySamples) {
      this.queryLatencies.shift()
    }

    return results.slice(0, limit)
  }

  /**
   * Consolidate patterns using EWC++
   *
   * Applies Fisher decay, recalculates importance, and prunes low-importance patterns.
   * Guarantees 95%+ preservation of important patterns.
   *
   * @returns Consolidation result
   */
  async consolidate(): Promise<ConsolidationResult> {
    this.ensureInitialized()
    const startTime = Date.now()

    const totalPatterns = this.getPatternCount()
    const newPatternsRatio =
      totalPatterns > 0 ? this.consolidationState.patternsSinceLastConsolidation / totalPatterns : 0

    // Check if consolidation is needed
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

    // Apply Fisher decay
    this.fisherMatrix.decay(this.ewcConfig.fisherDecay)

    // Sample patterns for Fisher estimation
    const samplePatterns = this.getSamplePatterns(this.ewcConfig.fisherSampleSize)
    const avgEmbedding = await this.computeAverageEmbedding()

    for (const pattern of samplePatterns) {
      const gradient = this.computeGradient(pattern.contextEmbedding, avgEmbedding)
      this.fisherMatrix.update(gradient)
    }

    // Update importance for all patterns
    const allPatterns = this.getAllPatterns()
    const importanceVector = this.fisherMatrix.getImportanceVector()

    for (const pattern of allPatterns) {
      const newImportance = this.calculateDimensionImportance(pattern, importanceVector)
      this.updatePatternImportance(pattern.id, newImportance)
    }

    // Prune low-importance patterns
    let prunedCount = 0
    let preservedCount = 0

    // Sort by importance (ascending) for pruning
    const sortedPatterns = [...allPatterns].sort((a, b) => a.importance - b.importance)

    if (sortedPatterns.length > this.ewcConfig.maxPatterns) {
      const pruneCandidates = sortedPatterns.slice(
        0,
        sortedPatterns.length - this.ewcConfig.maxPatterns
      )

      for (const candidate of pruneCandidates) {
        if (candidate.importance < this.ewcConfig.importanceThreshold) {
          this.deletePattern(candidate.id)
          prunedCount++
        } else {
          preservedCount++
        }
      }
      preservedCount += this.ewcConfig.maxPatterns
    } else {
      // Prune very low importance patterns even if under limit
      for (const pattern of sortedPatterns) {
        if (pattern.importance < this.ewcConfig.importanceThreshold * 0.1) {
          this.deletePattern(pattern.id)
          prunedCount++
        } else {
          preservedCount++
        }
      }
    }

    const preservationRate = preservedCount / (preservedCount + prunedCount) || 1.0

    // Update consolidation state
    this.consolidationState.lastConsolidation = new Date()
    this.consolidationState.patternsSinceLastConsolidation = 0
    this.consolidationState.totalPatterns = this.getPatternCount()

    // Record consolidation history
    const durationMs = Date.now() - startTime
    const avgImportance = this.fisherMatrix.getAverageImportance()

    const historyStmt = this.db.prepare(`
      INSERT INTO consolidation_history (
        patterns_processed, patterns_preserved, patterns_pruned,
        preservation_rate, duration_ms, average_importance
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    historyStmt.run(
      preservedCount + prunedCount,
      preservedCount,
      prunedCount,
      preservationRate,
      durationMs,
      avgImportance
    )

    // Persist Fisher matrix
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

  /**
   * Get pattern importance value
   *
   * @param patternId - Pattern identifier
   * @returns Importance value or 0 if not found
   */
  getPatternImportance(patternId: string): number {
    this.ensureInitialized()
    const stmt = this.db.prepare('SELECT importance FROM patterns WHERE pattern_id = ?')
    const result = stmt.get(patternId) as { importance: number } | undefined
    return result?.importance ?? 0
  }

  /**
   * Get PatternStore metrics
   */
  getMetrics(): PatternStoreMetrics {
    this.ensureInitialized()

    // Total patterns
    const totalPatterns = this.getPatternCount()

    // Patterns by outcome type
    const outcomeStmt = this.db.prepare(`
      SELECT outcome_type, COUNT(*) as count FROM patterns GROUP BY outcome_type
    `)
    const outcomeCounts = outcomeStmt.all() as Array<{ outcome_type: string; count: number }>
    const patternsByOutcome: Record<PatternOutcomeType, number> = {
      accept: 0,
      usage: 0,
      frequent: 0,
      dismiss: 0,
      abandonment: 0,
      uninstall: 0,
    }
    for (const row of outcomeCounts) {
      patternsByOutcome[row.outcome_type as PatternOutcomeType] = row.count
    }

    // Average importance
    const avgStmt = this.db.prepare('SELECT AVG(importance) as avg FROM patterns')
    const avgResult = avgStmt.get() as { avg: number | null }
    const averageImportance = avgResult?.avg ?? 0

    // High importance patterns (above 90th percentile)
    const percentileStmt = this.db.prepare(`
      SELECT importance FROM patterns ORDER BY importance DESC
      LIMIT CAST((SELECT COUNT(*) FROM patterns) * 0.1 AS INTEGER)
    `)
    const highImportancePatterns = percentileStmt.all().length

    // Consolidation stats
    const consolidationStmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        MAX(timestamp) as last_timestamp,
        AVG(preservation_rate) as avg_rate,
        SUM(patterns_pruned) as total_pruned
      FROM consolidation_history
    `)
    const consolidationResult = consolidationStmt.get() as {
      total: number
      last_timestamp: number | null
      avg_rate: number | null
      total_pruned: number | null
    }

    // Storage size
    const fisherMatrixSize = 4 + this.config.dimensions * 4 * 2 // updateCount + importance + runningSum

    // Query performance
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
        totalConsolidations: consolidationResult.total,
        lastConsolidation: consolidationResult.last_timestamp
          ? new Date(consolidationResult.last_timestamp * 1000)
          : null,
        averagePreservationRate: consolidationResult.avg_rate ?? 1.0,
        patternsPruned: consolidationResult.total_pruned ?? 0,
      },
      storage: {
        sizeBytes: this.getDatabaseSize(),
        fisherMatrixSizeBytes: fisherMatrixSize,
      },
      queryPerformance: {
        averageLatencyMs: avgLatency,
        queriesPerformed: this.queryLatencies.length,
      },
    }
  }

  /**
   * Close the PatternStore and release resources
   */
  close(): void {
    if (this.db) {
      this.db.close()
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('PatternStore not initialized. Call initialize() first.')
    }
  }

  private contextToText(context: PatternRecommendationContext): string {
    const parts: string[] = []

    if (context.installedSkills && context.installedSkills.length > 0) {
      parts.push(`installed: ${context.installedSkills.join(', ')}`)
    }
    if (context.frameworks && context.frameworks.length > 0) {
      parts.push(`frameworks: ${context.frameworks.join(', ')}`)
    }
    if (context.keywords && context.keywords.length > 0) {
      parts.push(`keywords: ${context.keywords.join(', ')}`)
    }
    if (context.timeOfDay) {
      parts.push(`time: ${context.timeOfDay}`)
    }
    if (context.dayType) {
      parts.push(`day: ${context.dayType}`)
    }

    return parts.join(' | ') || 'empty context'
  }

  private computeGradient(a: Float32Array, b: Float32Array): Float32Array {
    const gradient = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) {
      gradient[i] = a[i] - (b[i] ?? 0)
    }
    return gradient
  }

  private async computeAverageEmbedding(): Promise<Float32Array> {
    const stmt = this.db.prepare('SELECT context_embedding FROM patterns LIMIT 100')
    const rows = stmt.all() as Array<{ context_embedding: Buffer }>

    if (rows.length === 0) {
      return new Float32Array(this.config.dimensions)
    }

    const sum = new Float32Array(this.config.dimensions)
    for (const row of rows) {
      const embedding = this.deserializeEmbedding(row.context_embedding)
      for (let i = 0; i < embedding.length; i++) {
        sum[i] += embedding[i]
      }
    }

    for (let i = 0; i < sum.length; i++) {
      sum[i] /= rows.length
    }

    return sum
  }

  private deserializeEmbedding(buffer: Buffer): Float32Array {
    const floatArray = new Float32Array(this.config.dimensions)
    for (let i = 0; i < this.config.dimensions; i++) {
      floatArray[i] = buffer.readFloatLE(i * 4)
    }
    return floatArray
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    if (normA === 0 || normB === 0) return 0
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  private importanceWeightedSimilarity(
    a: Float32Array,
    b: Float32Array,
    importance: Float32Array
  ): number {
    let weightedDotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      const weight = 1 + (importance[i] ?? 0)
      weightedDotProduct += weight * a[i] * b[i]
      normA += weight * a[i] * a[i]
      normB += weight * b[i] * b[i]
    }

    if (normA === 0 || normB === 0) return 0
    return weightedDotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  private calculatePatternImportance(pattern: StoredPattern, outcome: PatternOutcome): number {
    let baseImportance = Math.abs(outcome.reward)
    if (outcome.reward > 0) {
      baseImportance *= 1.5
    }

    // Recency factor
    const ageInDays = (Date.now() - pattern.createdAt.getTime()) / (24 * 60 * 60 * 1000)
    const recencyFactor = Math.exp(-ageInDays / 30)

    // Access frequency factor
    const accessFactor = 1 + Math.log(1 + pattern.accessCount)

    return baseImportance * recencyFactor * accessFactor * pattern.importance
  }

  private calculateDimensionImportance(
    pattern: StoredPattern,
    importanceVector: Float32Array
  ): number {
    let baseImportance = Math.abs(pattern.outcome.reward)
    if (pattern.outcome.reward > 0) {
      baseImportance *= 1.5
    }

    const ageInDays = (Date.now() - pattern.createdAt.getTime()) / (24 * 60 * 60 * 1000)
    const recencyFactor = Math.exp(-ageInDays / 30)
    const accessFactor = 1 + Math.log(1 + pattern.accessCount)

    // Fisher dimension importance (EWC++ core)
    // Lambda scales how much we weight Fisher importance in preservation
    let dimensionImportance = 0
    for (let i = 0; i < this.config.dimensions; i++) {
      dimensionImportance += (importanceVector[i] ?? 0) * Math.abs(pattern.contextEmbedding[i] ?? 0)
    }
    dimensionImportance /= this.config.dimensions

    // Apply lambda regularization: higher lambda = stronger importance preservation
    const lambdaScaled = 1 + (this.ewcConfig.lambda * dimensionImportance) / 10

    return baseImportance * recencyFactor * accessFactor * lambdaScaled
  }

  private shouldConsolidate(): boolean {
    // Minimum 1 hour between consolidations
    if (this.consolidationState.lastConsolidation) {
      const hoursSinceLast =
        (Date.now() - this.consolidationState.lastConsolidation.getTime()) / (60 * 60 * 1000)
      if (hoursSinceLast < 1) return false
    }

    if (this.consolidationState.totalPatterns === 0) return false

    const newPatternsRatio =
      this.consolidationState.patternsSinceLastConsolidation / this.consolidationState.totalPatterns

    if (newPatternsRatio >= this.ewcConfig.consolidationThreshold) return true

    // Force consolidation if approaching max patterns
    if (this.consolidationState.totalPatterns > this.ewcConfig.maxPatterns * 0.9) return true

    return false
  }

  private getPatternCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM patterns')
    const result = stmt.get() as { count: number }
    return result.count
  }

  private getSamplePatterns(limit: number): StoredPattern[] {
    const stmt = this.db.prepare(`
      SELECT * FROM patterns ORDER BY RANDOM() LIMIT ?
    `)
    const rows = stmt.all(limit) as Array<{
      pattern_id: string
      context_embedding: Buffer
      skill_id: string
      skill_features: string
      context_data: string
      outcome_type: string
      outcome_reward: number
      importance: number
      original_score: number
      source: string
      access_count: number
      created_at: number
      last_accessed_at: number
    }>

    return rows.map((row) => ({
      id: row.pattern_id,
      context: JSON.parse(row.context_data),
      skill: JSON.parse(row.skill_features),
      originalScore: row.original_score,
      source: row.source as Pattern['source'],
      contextEmbedding: this.deserializeEmbedding(row.context_embedding),
      outcome: {
        type: row.outcome_type as PatternOutcomeType,
        reward: row.outcome_reward,
      },
      importance: row.importance,
      accessCount: row.access_count,
      createdAt: new Date(row.created_at * 1000),
      lastAccessedAt: new Date(row.last_accessed_at * 1000),
    }))
  }

  private getAllPatterns(): StoredPattern[] {
    const stmt = this.db.prepare('SELECT * FROM patterns')
    const rows = stmt.all() as Array<{
      pattern_id: string
      context_embedding: Buffer
      skill_id: string
      skill_features: string
      context_data: string
      outcome_type: string
      outcome_reward: number
      importance: number
      original_score: number
      source: string
      access_count: number
      created_at: number
      last_accessed_at: number
    }>

    return rows.map((row) => ({
      id: row.pattern_id,
      context: JSON.parse(row.context_data),
      skill: JSON.parse(row.skill_features),
      originalScore: row.original_score,
      source: row.source as Pattern['source'],
      contextEmbedding: this.deserializeEmbedding(row.context_embedding),
      outcome: {
        type: row.outcome_type as PatternOutcomeType,
        reward: row.outcome_reward,
      },
      importance: row.importance,
      accessCount: row.access_count,
      createdAt: new Date(row.created_at * 1000),
      lastAccessedAt: new Date(row.last_accessed_at * 1000),
    }))
  }

  private updatePatternInDB(
    patternId: string,
    updates: { importance?: number; accessCount?: number }
  ): void {
    const sets: string[] = []
    const params: unknown[] = []

    if (updates.importance !== undefined) {
      sets.push('importance = ?')
      params.push(updates.importance)
    }
    if (updates.accessCount !== undefined) {
      sets.push('access_count = ?')
      params.push(updates.accessCount)
    }

    sets.push('last_accessed_at = unixepoch()')
    params.push(patternId)

    const stmt = this.db.prepare(`UPDATE patterns SET ${sets.join(', ')} WHERE pattern_id = ?`)
    stmt.run(...params)
  }

  private updatePatternImportance(patternId: string, importance: number): void {
    const stmt = this.db.prepare('UPDATE patterns SET importance = ? WHERE pattern_id = ?')
    stmt.run(importance, patternId)
  }

  private updateAccessCount(patternId: string): void {
    const stmt = this.db.prepare(`
      UPDATE patterns SET access_count = access_count + 1, last_accessed_at = unixepoch()
      WHERE pattern_id = ?
    `)
    stmt.run(patternId)
  }

  private deletePattern(patternId: string): void {
    const stmt = this.db.prepare('DELETE FROM patterns WHERE pattern_id = ?')
    stmt.run(patternId)
  }

  private getDatabaseSize(): number {
    const stmt = this.db.prepare(
      'SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()'
    )
    const result = stmt.get() as { size: number } | undefined
    return result?.size ?? 0
  }

  private loadFisherMatrix(): void {
    const stmt = this.db.prepare('SELECT matrix_data FROM fisher_info WHERE id = 1')
    const result = stmt.get() as { matrix_data: Buffer } | undefined

    if (result?.matrix_data) {
      try {
        this.fisherMatrix.deserialize(result.matrix_data)
      } catch {
        // Corrupted matrix data - reset to fresh state
        console.warn('[PatternStore] Fisher matrix data corrupted, resetting')
        this.fisherMatrix.reset()
      }
    }
  }

  private saveFisherMatrix(): void {
    const matrixData = this.fisherMatrix.serialize()

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO fisher_info (id, matrix_data, update_count, last_decay_at, updated_at)
      VALUES (1, ?, ?, unixepoch(), unixepoch())
    `)
    stmt.run(matrixData, this.fisherMatrix.getUpdateCount())
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and initialize a PatternStore instance
 *
 * @param config - Configuration options
 * @returns Initialized PatternStore
 */
export async function createPatternStore(config: PatternStoreConfig = {}): Promise<PatternStore> {
  const store = new PatternStore(config)
  await store.initialize()
  return store
}
