/**
 * SMI-584: Semantic Embeddings Service
 * SMI-754: Added fallback mode for deterministic mock embeddings
 * SMI-1127: Lazy loading of @xenova/transformers to avoid CLI crashes
 *
 * Uses all-MiniLM-L6-v2 model for fast, accurate skill embeddings.
 * Supports fallback mode for tests and when model unavailable.
 *
 * @see ADR-009: Embedding Service Fallback Strategy
 */

import Database from 'better-sqlite3'

// Import types and utilities from extracted modules
export type {
  EmbeddingResult,
  SimilarityResult,
  EmbeddingServiceOptions,
  FeatureExtractionPipeline,
} from './embedding-types.js'

import type { FeatureExtractionPipeline } from './embedding-types.js'

import {
  shouldUseFallback,
  hashText,
  generateMockEmbedding,
  loadTransformersModule,
  isTransformersAvailable,
  checkTransformersAvailability,
  getTransformersLoadError,
} from './embedding-utils.js'

// Re-export test utilities
export const testUtils = {
  /** Generate a deterministic mock embedding (for testing) */
  generateMockEmbedding,
  /** Generate a hash from text (for testing) */
  hashText,
}

export class EmbeddingService {
  private model: FeatureExtractionPipeline | null = null
  private modelPromise: Promise<FeatureExtractionPipeline> | null = null
  private modelLoadFailed = false
  private db: Database.Database | null = null
  private readonly modelName = 'Xenova/all-MiniLM-L6-v2'
  private readonly embeddingDim = 384
  private readonly useFallback: boolean

  /**
   * Create an EmbeddingService instance.
   *
   * @param optionsOrDbPath - Options object or legacy dbPath string
   */
  constructor(optionsOrDbPath?: string | { dbPath?: string; useFallback?: boolean }) {
    const options =
      typeof optionsOrDbPath === 'string' ? { dbPath: optionsOrDbPath } : (optionsOrDbPath ?? {})

    this.useFallback = shouldUseFallback(options.useFallback)

    if (options.dbPath) {
      this.db = new Database(options.dbPath)
      this.initEmbeddingTable()
    }
  }

  /** Check if service is running in fallback (mock) mode */
  isUsingFallback(): boolean {
    return this.useFallback || this.modelLoadFailed
  }

  private initEmbeddingTable(): void {
    if (!this.db) return

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_embeddings (
        skill_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_skill
      ON skill_embeddings(skill_id)
    `)
  }

  /** Static: Check if the transformers module is available without loading it */
  static isTransformersAvailable(): boolean | undefined {
    return isTransformersAvailable()
  }

  /** Static: Check if embeddings functionality is available */
  static async checkAvailability(): Promise<boolean> {
    return checkTransformersAvailability()
  }

  /** Static: Get the error that occurred when loading the transformers module */
  static getTransformersLoadError(): Error | null {
    return getTransformersLoadError()
  }

  /** Lazily load the embedding model */
  async loadModel(): Promise<FeatureExtractionPipeline | null> {
    if (this.useFallback) return null
    if (this.model) return this.model
    if (this.modelLoadFailed) return null

    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const transformers = await loadTransformersModule()
        if (!transformers) {
          throw new Error(
            getTransformersLoadError()?.message ||
              'Failed to load @xenova/transformers module (sharp may not be available)'
          )
        }
        return transformers.pipeline('feature-extraction', this.modelName, {
          quantized: true,
        }) as Promise<FeatureExtractionPipeline>
      })()
    }

    try {
      this.model = await this.modelPromise
      return this.model
    } catch (error) {
      this.modelLoadFailed = true
      console.warn(
        `[EmbeddingService] Failed to load model "${this.modelName}", using fallback mode:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  /** Generate embedding for a single text */
  async embed(text: string): Promise<Float32Array> {
    const truncated = text.slice(0, 1000)

    if (this.useFallback || this.modelLoadFailed) {
      return generateMockEmbedding(truncated, this.embeddingDim)
    }

    const model = await this.loadModel()
    if (!model) {
      return generateMockEmbedding(truncated, this.embeddingDim)
    }

    const output = await model(truncated, { pooling: 'mean', normalize: true })
    const embedding = new Float32Array(this.embeddingDim)
    for (let i = 0; i < this.embeddingDim; i++) {
      embedding[i] = output.data[i]
    }
    return embedding
  }

  /** Batch embed multiple texts efficiently */
  async embedBatch(texts: Array<{ id: string; text: string }>): Promise<
    Array<{
      skillId: string
      embedding: Float32Array
      text: string
    }>
  > {
    const results: Array<{ skillId: string; embedding: Float32Array; text: string }> = []

    if (this.useFallback || this.modelLoadFailed) {
      for (const { id, text } of texts) {
        const truncated = text.slice(0, 1000)
        const embedding = generateMockEmbedding(truncated, this.embeddingDim)
        results.push({ skillId: id, embedding, text })
      }
      return results
    }

    await this.loadModel()
    const batchSize = 32
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      for (const { id, text } of batch) {
        const embedding = await this.embed(text)
        results.push({ skillId: id, embedding, text })
      }
    }
    return results
  }

  /** Store embedding in SQLite cache */
  storeEmbedding(skillId: string, embedding: Float32Array, text: string): void {
    if (!this.db) return
    const buffer = Buffer.from(embedding.buffer)
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding, text, created_at)
      VALUES (?, ?, ?, unixepoch())
    `)
    stmt.run(skillId, buffer, text)
  }

  /** Retrieve cached embedding */
  getEmbedding(skillId: string): Float32Array | null {
    if (!this.db) return null
    const stmt = this.db.prepare(`SELECT embedding FROM skill_embeddings WHERE skill_id = ?`)
    const row = stmt.get(skillId) as { embedding: Buffer } | undefined
    if (!row) return null
    return new Float32Array(
      row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength
      )
    )
  }

  /** Get all cached embeddings */
  getAllEmbeddings(): Map<string, Float32Array> {
    if (!this.db) return new Map()
    const stmt = this.db.prepare(`SELECT skill_id, embedding FROM skill_embeddings`)
    const rows = stmt.all() as Array<{ skill_id: string; embedding: Buffer }>
    const result = new Map<string, Float32Array>()
    for (const row of rows) {
      const embedding = new Float32Array(
        row.embedding.buffer.slice(
          row.embedding.byteOffset,
          row.embedding.byteOffset + row.embedding.byteLength
        )
      )
      result.set(row.skill_id, embedding)
    }
    return result
  }

  /** Compute cosine similarity between two embeddings */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) throw new Error('Embeddings must have same dimension')
    let dotProduct = 0,
      normA = 0,
      normB = 0
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    if (normA === 0 || normB === 0) return 0
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  /** Find most similar skills to a query embedding */
  findSimilar(
    queryEmbedding: Float32Array,
    topK: number = 10
  ): Array<{ skillId: string; score: number }> {
    const allEmbeddings = this.getAllEmbeddings()
    const results: Array<{ skillId: string; score: number }> = []
    for (const [skillId, embedding] of allEmbeddings) {
      const score = this.cosineSimilarity(queryEmbedding, embedding)
      results.push({ skillId, score })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  /** Pre-compute embeddings for all skills in database */
  async precomputeEmbeddings(
    skills: Array<{ id: string; name: string; description: string }>
  ): Promise<number> {
    let count = 0
    for (const skill of skills) {
      const existing = this.getEmbedding(skill.id)
      if (existing) continue
      const text = `${skill.name} ${skill.description}`
      const embedding = await this.embed(text)
      this.storeEmbedding(skill.id, embedding, text)
      count++
    }
    return count
  }

  /** Close database connection */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

export default EmbeddingService

// HNSW Store (SMI-1519)
export {
  HNSWEmbeddingStore,
  createHNSWStore,
  isHNSWAvailable,
  loadHNSWLib,
  DEFAULT_HNSW_CONFIG,
  HNSW_PRESETS,
} from './hnsw-store.js'

export type {
  IEmbeddingStore,
  HNSWConfig,
  HNSWEmbeddingStoreOptions,
  HNSWIndexStats,
  BatchInsertResult,
  HierarchicalNSW,
  HierarchicalNSWConstructor,
  HNSWSearchResult,
} from './hnsw-store.js'
