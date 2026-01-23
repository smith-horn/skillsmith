/**
 * @fileoverview PatternStore helper classes and utility functions
 * @module @skillsmith/core/learning/PatternStore.helpers
 *
 * Contains FisherInformationMatrix implementation, SQL schema, and utility functions.
 */

import type {
  PatternRecommendationContext,
  StoredPattern,
  PatternOutcome,
  PatternRow,
} from './PatternStore.types.js'

// ============================================================================
// SQL Schema
// ============================================================================

/**
 * SQLite schema for pattern storage
 */
export const PATTERN_STORE_SCHEMA = `
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
  getUpdateCount(): number
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
// Utility Functions
// ============================================================================

/**
 * Convert pattern context to text for embedding
 */
export function contextToText(context: PatternRecommendationContext): string {
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

/**
 * Compute gradient between two embeddings
 */
export function computeGradient(a: Float32Array, b: Float32Array): Float32Array {
  const gradient = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) {
    gradient[i] = a[i] - (b[i] ?? 0)
  }
  return gradient
}

/**
 * Deserialize embedding from buffer
 */
export function deserializeEmbedding(buffer: Buffer, dimensions: number): Float32Array {
  const floatArray = new Float32Array(dimensions)
  for (let i = 0; i < dimensions; i++) {
    floatArray[i] = buffer.readFloatLE(i * 4)
  }
  return floatArray
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

/**
 * Calculate importance-weighted similarity
 */
export function importanceWeightedSimilarity(
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

/**
 * Calculate pattern importance based on outcome and access patterns
 */
export function calculatePatternImportance(
  pattern: StoredPattern,
  outcome: PatternOutcome
): number {
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

/**
 * Calculate dimension-based importance using Fisher Information
 */
export function calculateDimensionImportance(
  pattern: StoredPattern,
  importanceVector: Float32Array,
  dimensions: number,
  lambda: number
): number {
  let baseImportance = Math.abs(pattern.outcome.reward)
  if (pattern.outcome.reward > 0) {
    baseImportance *= 1.5
  }

  const ageInDays = (Date.now() - pattern.createdAt.getTime()) / (24 * 60 * 60 * 1000)
  const recencyFactor = Math.exp(-ageInDays / 30)
  const accessFactor = 1 + Math.log(1 + pattern.accessCount)

  // Fisher dimension importance (EWC++ core)
  let dimensionImportance = 0
  for (let i = 0; i < dimensions; i++) {
    dimensionImportance += (importanceVector[i] ?? 0) * Math.abs(pattern.contextEmbedding[i] ?? 0)
  }
  dimensionImportance /= dimensions

  // Apply lambda regularization: higher lambda = stronger importance preservation
  const lambdaScaled = 1 + (lambda * dimensionImportance) / 10

  return baseImportance * recencyFactor * accessFactor * lambdaScaled
}

/**
 * Convert database row to StoredPattern
 */
export function rowToStoredPattern(row: PatternRow, dimensions: number): StoredPattern {
  return {
    id: row.pattern_id,
    context: JSON.parse(row.context_data),
    skill: JSON.parse(row.skill_features),
    originalScore: row.original_score,
    source: row.source as StoredPattern['source'],
    contextEmbedding: deserializeEmbedding(row.context_embedding, dimensions),
    outcome: {
      type: row.outcome_type as StoredPattern['outcome']['type'],
      reward: row.outcome_reward,
    },
    importance: row.importance,
    accessCount: row.access_count,
    createdAt: new Date(row.created_at * 1000),
    lastAccessedAt: new Date(row.last_accessed_at * 1000),
  }
}
