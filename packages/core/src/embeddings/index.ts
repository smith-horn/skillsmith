/**
 * SMI-584: Semantic Embeddings Service
 * SMI-754: Added fallback mode for deterministic mock embeddings
 * SMI-1127: Lazy loading of @xenova/transformers to avoid CLI crashes from sharp
 *
 * Uses all-MiniLM-L6-v2 model for fast, accurate skill embeddings.
 * Supports fallback mode for tests and when model unavailable.
 *
 * @see ADR-009: Embedding Service Fallback Strategy
 */

import Database from 'better-sqlite3'

// Lazy-loaded pipeline function - only loaded when embeddings are actually used
let pipelineModule: typeof import('@xenova/transformers') | null = null
let pipelineLoadPromise: Promise<typeof import('@xenova/transformers')> | null = null
let pipelineLoadFailed = false
let pipelineLoadError: Error | null = null

/**
 * Lazily load the @xenova/transformers module.
 * This avoids loading sharp at startup, which causes CLI crashes.
 */
async function loadTransformersModule(): Promise<typeof import('@xenova/transformers') | null> {
  // Return cached module if already loaded
  if (pipelineModule) {
    return pipelineModule
  }

  // Return null if we already tried and failed
  if (pipelineLoadFailed) {
    return null
  }

  // Start loading if not already in progress
  if (!pipelineLoadPromise) {
    pipelineLoadPromise = import('@xenova/transformers')
      .then((mod) => {
        pipelineModule = mod
        return mod
      })
      .catch((err) => {
        pipelineLoadFailed = true
        pipelineLoadError = err instanceof Error ? err : new Error(String(err))
        return null as unknown as typeof import('@xenova/transformers')
      })
  }

  const result = await pipelineLoadPromise
  return result || null
}

// Type for feature extraction pipeline output - defined without importing
type FeatureExtractionPipeline = {
  (
    text: string,
    options?: { pooling?: string; normalize?: boolean }
  ): Promise<{ data: Float32Array }>
}

export interface EmbeddingResult {
  skillId: string
  embedding: Float32Array
  text: string
}

export interface SimilarityResult {
  skillId: string
  score: number
}

/**
 * Options for EmbeddingService initialization
 */
export interface EmbeddingServiceOptions {
  /** Path to SQLite database for caching embeddings */
  dbPath?: string
  /**
   * Force fallback mode (deterministic mock embeddings).
   * If not specified, checks SKILLSMITH_USE_MOCK_EMBEDDINGS env var,
   * then falls back to real embeddings.
   */
  useFallback?: boolean
}

/**
 * Check if fallback mode should be used based on environment
 */
function shouldUseFallback(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit
  }
  // Check environment variable
  const envValue = process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS
  if (envValue !== undefined) {
    return envValue === 'true' || envValue === '1'
  }
  // Default to real embeddings
  return false
}

/**
 * Generate a deterministic hash from text for mock embeddings.
 * Uses a simple but effective string hashing algorithm.
 */
function hashText(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return hash
}

/**
 * Generate deterministic mock embedding based on text content.
 * Produces consistent vectors for the same input text.
 */
function generateMockEmbedding(text: string, dimension: number): Float32Array {
  const embedding = new Float32Array(dimension)
  const baseHash = hashText(text)

  for (let i = 0; i < dimension; i++) {
    // Use sine wave with hash-based offset for pseudo-random but deterministic values
    const value = Math.sin(baseHash + i * 0.1) * 0.5 + 0.5
    embedding[i] = value
  }

  // Normalize the vector
  let norm = 0
  for (let i = 0; i < dimension; i++) {
    norm += embedding[i] * embedding[i]
  }
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dimension; i++) {
      embedding[i] /= norm
    }
  }

  return embedding
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
   *
   * @example
   * // Real embeddings (default)
   * const service = new EmbeddingService({ dbPath: './cache.db' });
   *
   * @example
   * // Forced fallback mode for tests
   * const service = new EmbeddingService({ useFallback: true });
   *
   * @example
   * // Environment-controlled (set SKILLSMITH_USE_MOCK_EMBEDDINGS=true)
   * const service = new EmbeddingService();
   */
  constructor(optionsOrDbPath?: string | EmbeddingServiceOptions) {
    // Support legacy string argument for backward compatibility
    const options: EmbeddingServiceOptions =
      typeof optionsOrDbPath === 'string' ? { dbPath: optionsOrDbPath } : (optionsOrDbPath ?? {})

    this.useFallback = shouldUseFallback(options.useFallback)

    if (options.dbPath) {
      this.db = new Database(options.dbPath)
      this.initEmbeddingTable()
    }
  }

  /**
   * Check if service is running in fallback (mock) mode
   */
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

  /**
   * Check if the transformers module is available without loading it.
   * This is a synchronous check that returns the current known state.
   *
   * @returns true if module is loaded, false if loading failed, undefined if not yet attempted
   */
  static isTransformersAvailable(): boolean | undefined {
    if (pipelineModule) return true
    if (pipelineLoadFailed) return false
    return undefined
  }

  /**
   * Check if embeddings functionality is available.
   * Attempts to load the transformers module if not yet loaded.
   *
   * @returns true if embeddings can be used, false otherwise
   */
  static async checkAvailability(): Promise<boolean> {
    const mod = await loadTransformersModule()
    return mod !== null
  }

  /**
   * Get the error that occurred when loading the transformers module, if any.
   */
  static getTransformersLoadError(): Error | null {
    return pipelineLoadError
  }

  /**
   * Lazily load the embedding model.
   * Returns null if in fallback mode or if model loading fails.
   */
  async loadModel(): Promise<FeatureExtractionPipeline | null> {
    // Skip loading if in fallback mode
    if (this.useFallback) {
      return null
    }

    // Return cached model if available
    if (this.model) return this.model

    // Return null if we already tried and failed
    if (this.modelLoadFailed) {
      return null
    }

    if (!this.modelPromise) {
      // Lazily load the transformers module first
      this.modelPromise = (async () => {
        const transformers = await loadTransformersModule()
        if (!transformers) {
          throw new Error(
            pipelineLoadError?.message ||
              'Failed to load @xenova/transformers module (sharp may not be available)'
          )
        }

        return transformers.pipeline('feature-extraction', this.modelName, {
          quantized: true, // Use quantized model for faster inference
        }) as Promise<FeatureExtractionPipeline>
      })()
    }

    try {
      this.model = await this.modelPromise
      return this.model
    } catch (error) {
      // Model loading failed - switch to fallback mode
      this.modelLoadFailed = true
      console.warn(
        `[EmbeddingService] Failed to load model "${this.modelName}", using fallback mode:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  /**
   * Generate embedding for a single text.
   * Uses real ONNX model when available, falls back to deterministic mock otherwise.
   */
  async embed(text: string): Promise<Float32Array> {
    // Truncate text if too long (model max is 256 tokens)
    const truncated = text.slice(0, 1000)

    // Use fallback if configured or model unavailable
    if (this.useFallback || this.modelLoadFailed) {
      return generateMockEmbedding(truncated, this.embeddingDim)
    }

    // Try to load and use real model
    const model = await this.loadModel()

    if (!model) {
      // Model loading failed, use fallback
      return generateMockEmbedding(truncated, this.embeddingDim)
    }

    const output = await model(truncated, {
      pooling: 'mean',
      normalize: true,
    })

    // Extract embedding data
    const embedding = new Float32Array(this.embeddingDim)
    for (let i = 0; i < this.embeddingDim; i++) {
      embedding[i] = output.data[i]
    }

    return embedding
  }

  /**
   * Batch embed multiple texts efficiently.
   * In fallback mode, processes synchronously for speed.
   */
  async embedBatch(texts: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = []

    // In fallback mode, process synchronously (much faster)
    if (this.useFallback || this.modelLoadFailed) {
      for (const { id, text } of texts) {
        const truncated = text.slice(0, 1000)
        const embedding = generateMockEmbedding(truncated, this.embeddingDim)
        results.push({ skillId: id, embedding, text })
      }
      return results
    }

    // Try to load model for real embeddings
    await this.loadModel()

    // Process in batches of 32 for efficiency
    const batchSize = 32
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)

      for (const { id, text } of batch) {
        const embedding = await this.embed(text)
        results.push({
          skillId: id,
          embedding,
          text,
        })
      }
    }

    return results
  }

  /**
   * Store embedding in SQLite cache
   */
  storeEmbedding(skillId: string, embedding: Float32Array, text: string): void {
    if (!this.db) return

    const buffer = Buffer.from(embedding.buffer)

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding, text, created_at)
      VALUES (?, ?, ?, unixepoch())
    `)

    stmt.run(skillId, buffer, text)
  }

  /**
   * Retrieve cached embedding
   */
  getEmbedding(skillId: string): Float32Array | null {
    if (!this.db) return null

    const stmt = this.db.prepare(`
      SELECT embedding FROM skill_embeddings WHERE skill_id = ?
    `)

    const row = stmt.get(skillId) as { embedding: Buffer } | undefined
    if (!row) return null

    return new Float32Array(
      row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength
      )
    )
  }

  /**
   * Get all cached embeddings
   */
  getAllEmbeddings(): Map<string, Float32Array> {
    if (!this.db) return new Map()

    const stmt = this.db.prepare(`
      SELECT skill_id, embedding FROM skill_embeddings
    `)

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

  /**
   * Compute cosine similarity between two embeddings
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have same dimension')
    }

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
   * Find most similar skills to a query embedding
   */
  findSimilar(queryEmbedding: Float32Array, topK: number = 10): SimilarityResult[] {
    const allEmbeddings = this.getAllEmbeddings()
    const results: SimilarityResult[] = []

    for (const [skillId, embedding] of allEmbeddings) {
      const score = this.cosineSimilarity(queryEmbedding, embedding)
      results.push({ skillId, score })
    }

    // Sort by similarity score descending
    results.sort((a, b) => b.score - a.score)

    return results.slice(0, topK)
  }

  /**
   * Pre-compute embeddings for all skills in database
   */
  async precomputeEmbeddings(
    skills: Array<{ id: string; name: string; description: string }>
  ): Promise<number> {
    let count = 0

    for (const skill of skills) {
      // Check if already cached
      const existing = this.getEmbedding(skill.id)
      if (existing) continue

      // Create text representation for embedding
      const text = `${skill.name} ${skill.description}`
      const embedding = await this.embed(text)

      this.storeEmbedding(skill.id, embedding, text)
      count++
    }

    return count
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

// Export testing utilities for use in test files
export const testUtils = {
  /** Generate a deterministic mock embedding (for testing) */
  generateMockEmbedding,
  /** Generate a hash from text (for testing) */
  hashText,
}

export default EmbeddingService
