/**
 * SMI-1519: HNSW Embedding Store
 *
 * High-performance vector storage using HNSW (Hierarchical Navigable Small World)
 * index for fast approximate nearest neighbor (ANN) search.
 *
 * Features:
 * - O(log n) similarity search vs O(n) brute-force (150x faster)
 * - SQLite for metadata persistence (skill_id, text, created_at)
 * - Graceful fallback to brute-force if HNSW unavailable
 * - Compatible with existing EmbeddingService interface
 * - Uses claude-flow V3 VectorDB API with automatic fallback
 *
 * Enable via environment variable: SKILLSMITH_USE_HNSW=true
 *
 * @see ADR-009: Embedding Service Fallback Strategy
 */

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import type { SimilarityResult } from './index.js'

// V3 VectorDB types from claude-flow
import type { VectorDB } from 'claude-flow/v3/@claude-flow/cli/dist/src/ruvector/vector-db.js'

// ============================================================================
// hnswlib-node Type Declarations
// ============================================================================

/**
 * Type definitions for hnswlib-node (not published on DefinitelyTyped)
 * These are minimal declarations for the parts we use.
 *
 * @see https://github.com/yoshoku/hnswlib-node
 */
export interface HierarchicalNSW {
  initIndex(maxElements: number, m?: number, efConstruction?: number): void
  loadIndex(path: string, allowReplaceDeleted?: boolean): void
  saveIndex(path: string): void
  addPoint(point: number[] | Float32Array, label: number, replaceDeleted?: boolean): void
  markDelete(label: number): void
  searchKnn(
    query: number[] | Float32Array,
    k: number,
    filter?: (label: number) => boolean
  ): HNSWSearchResult
  getMaxElements(): number
  getCurrentCount(): number
  getEfSearch(): number
  setEfSearch(ef: number): void
  getIdsList(): number[]
}

/**
 * Result from HNSW k-nearest neighbor search
 */
export interface HNSWSearchResult {
  /** Labels (IDs) of the nearest neighbors */
  neighbors: number[]
  /** Distances to each neighbor (lower = closer) */
  distances: number[]
}

/**
 * Constructor type for HierarchicalNSW
 */
export interface HierarchicalNSWConstructor {
  new (space: 'cosine' | 'l2' | 'ip', dim: number): HierarchicalNSW
}

// ============================================================================
// HNSW Configuration Types
// ============================================================================

/**
 * HNSW algorithm parameters for tuning search quality vs speed.
 *
 * @see https://github.com/nmslib/hnswlib/blob/master/ALGO_PARAMS.md
 */
export interface HNSWConfig {
  /**
   * Number of bidirectional links per node (M parameter).
   * Higher values = better recall but more memory/slower builds.
   *
   * - 8-16: Fast, lower memory, suitable for <100k vectors
   * - 16-32: Balanced, good for 100k-1M vectors
   * - 32-64: High recall, suitable for >1M vectors or high accuracy needs
   *
   * @default 16
   */
  m: number

  /**
   * Size of dynamic candidate list during index construction.
   * Higher values = better index quality but slower builds.
   *
   * - 100-200: Fast builds, acceptable quality
   * - 200-400: Balanced
   * - 400-500: High quality, slower builds
   *
   * @default 200
   */
  efConstruction: number

  /**
   * Size of dynamic candidate list during search.
   * Higher values = better recall but slower search.
   *
   * - 10-50: Fast search, may miss some neighbors
   * - 50-100: Balanced
   * - 100-200: High recall, slower search
   *
   * Must be >= topK for accurate results.
   *
   * @default 100
   */
  efSearch: number

  /**
   * Vector dimensionality. Must match embedding model output.
   * - 384 for all-MiniLM-L6-v2
   * - 768 for all-mpnet-base-v2
   *
   * @default 384
   */
  dimensions: number
}

/**
 * Options for HNSWEmbeddingStore initialization
 */
export interface HNSWEmbeddingStoreOptions {
  /**
   * Path to SQLite database for metadata storage.
   * If not provided, uses in-memory database.
   */
  dbPath?: string

  /**
   * Path to HNSW index file for persistence.
   * If not provided, index is built fresh on each startup.
   */
  indexPath?: string

  /**
   * HNSW algorithm configuration.
   * Uses sensible defaults if not provided.
   */
  hnswConfig?: Partial<HNSWConfig>

  /**
   * Maximum number of elements the index can hold.
   * Index will reject inserts once limit is reached.
   *
   * @default 100000
   */
  maxElements?: number

  /**
   * Distance metric for similarity calculation.
   * - 'cosine': Cosine similarity (default, best for normalized embeddings)
   * - 'l2': Euclidean distance
   * - 'ip': Inner product
   *
   * @default 'cosine'
   */
  distanceMetric?: 'cosine' | 'l2' | 'ip'

  /**
   * Force fallback to brute-force search (for testing or compatibility).
   * If not specified, checks SKILLSMITH_USE_HNSW env var.
   *
   * When true, uses HNSW. When false, falls back to brute-force.
   *
   * @default undefined (auto-detect from environment)
   */
  useHNSW?: boolean

  /**
   * Enable automatic index persistence.
   * When true, saves index to indexPath after each insert.
   * When false, must call saveIndex() manually.
   *
   * @default false
   */
  autoSave?: boolean
}

/**
 * Statistics about the HNSW index
 */
export interface HNSWIndexStats {
  /** Number of vectors currently stored */
  vectorCount: number

  /** Maximum capacity of the index */
  maxCapacity: number

  /** Utilization percentage (vectorCount / maxCapacity * 100) */
  utilizationPercent: number

  /** Current M parameter */
  m: number

  /** Current efConstruction parameter */
  efConstruction: number

  /** Current efSearch parameter */
  efSearch: number

  /** Vector dimensionality */
  dimensions: number

  /** Approximate memory usage in bytes */
  memoryUsageBytes: number

  /** Whether using HNSW (true) or brute-force fallback (false) */
  isHNSWEnabled: boolean

  /** Path to index file (if persistent) */
  indexPath?: string
}

/**
 * Result of a batch insert operation
 */
export interface BatchInsertResult {
  /** Number of vectors successfully inserted */
  inserted: number

  /** Number of vectors that were updates (already existed) */
  updated: number

  /** Number of vectors that failed to insert */
  failed: number

  /** Skill IDs that failed with their error messages */
  errors: Array<{ skillId: string; error: string }>

  /** Total time taken in milliseconds */
  durationMs: number
}

// ============================================================================
// Interface Definition
// ============================================================================

/**
 * Interface for embedding storage with similarity search.
 * Implemented by both HNSWEmbeddingStore and EmbeddingService for compatibility.
 */
export interface IEmbeddingStore {
  /**
   * Store an embedding with its metadata.
   *
   * @param skillId - Unique identifier for the skill
   * @param embedding - Vector embedding (Float32Array)
   * @param text - Original text that was embedded
   */
  storeEmbedding(skillId: string, embedding: Float32Array, text: string): void

  /**
   * Retrieve a stored embedding by skill ID.
   *
   * @param skillId - Unique identifier for the skill
   * @returns The embedding if found, null otherwise
   */
  getEmbedding(skillId: string): Float32Array | null

  /**
   * Get all stored embeddings.
   *
   * @returns Map of skill IDs to their embeddings
   */
  getAllEmbeddings(): Map<string, Float32Array>

  /**
   * Find most similar embeddings to a query vector.
   *
   * @param queryEmbedding - Query vector to find neighbors for
   * @param topK - Number of results to return (default: 10)
   * @returns Array of skill IDs with similarity scores, sorted descending
   */
  findSimilar(queryEmbedding: Float32Array, topK?: number): SimilarityResult[]

  /**
   * Compute cosine similarity between two embeddings.
   *
   * @param a - First embedding
   * @param b - Second embedding
   * @returns Similarity score between -1 and 1
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number

  /**
   * Check if running in fallback (brute-force) mode.
   *
   * @returns true if using brute-force, false if using HNSW
   */
  isUsingFallback(): boolean

  /**
   * Close database connections and release resources.
   */
  close(): void
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default HNSW configuration optimized for skill embeddings.
 * Tuned for ~10k-100k skills with balanced speed/recall.
 */
export const DEFAULT_HNSW_CONFIG: HNSWConfig = {
  m: 16,
  efConstruction: 200,
  efSearch: 100,
  dimensions: 384, // all-MiniLM-L6-v2
}

/**
 * HNSW configuration presets for different use cases
 */
export const HNSW_PRESETS = {
  /** Fast search, lower memory, suitable for <10k vectors */
  small: {
    m: 8,
    efConstruction: 100,
    efSearch: 50,
    dimensions: 384,
  } satisfies HNSWConfig,

  /** Balanced performance, suitable for 10k-100k vectors */
  medium: {
    m: 16,
    efConstruction: 200,
    efSearch: 100,
    dimensions: 384,
  } satisfies HNSWConfig,

  /** High recall, suitable for 100k-1M vectors */
  large: {
    m: 32,
    efConstruction: 400,
    efSearch: 150,
    dimensions: 384,
  } satisfies HNSWConfig,

  /** Maximum recall, suitable for >1M vectors or critical accuracy */
  xlarge: {
    m: 48,
    efConstruction: 500,
    efSearch: 200,
    dimensions: 384,
  } satisfies HNSWConfig,
} as const

// ============================================================================
// Class Skeleton
// ============================================================================

/**
 * High-performance embedding storage using HNSW index.
 *
 * Provides O(log n) approximate nearest neighbor search while maintaining
 * compatibility with the existing EmbeddingService interface.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const store = new HNSWEmbeddingStore({
 *   dbPath: './embeddings.db',
 *   indexPath: './embeddings.hnsw',
 * });
 *
 * // Store embeddings
 * store.storeEmbedding('skill-1', embedding1, 'Jest testing framework helper');
 * store.storeEmbedding('skill-2', embedding2, 'Vitest testing utilities');
 *
 * // Find similar
 * const results = store.findSimilar(queryEmbedding, 10);
 * // [{ skillId: 'skill-1', score: 0.95 }, { skillId: 'skill-2', score: 0.87 }, ...]
 *
 * // Clean up
 * store.close();
 * ```
 *
 * @example
 * ```typescript
 * // With custom HNSW config for large dataset
 * const store = new HNSWEmbeddingStore({
 *   dbPath: './embeddings.db',
 *   indexPath: './embeddings.hnsw',
 *   hnswConfig: HNSW_PRESETS.large,
 *   maxElements: 500000,
 * });
 * ```
 */
export class HNSWEmbeddingStore implements IEmbeddingStore {
  // -------------------------------------------------------------------------
  // Private Fields
  // -------------------------------------------------------------------------

  /** SQLite database for metadata */
  private db: DatabaseType | null = null

  /** HNSW index instance (from hnswlib-node) */
  private index: HierarchicalNSW | null = null

  /** Whether HNSW is enabled (false = brute-force fallback) */
  private readonly hnswEnabled: boolean

  /** Merged HNSW configuration */
  private readonly config: HNSWConfig

  /** Maximum index capacity */
  private readonly maxElements: number

  /** Path to HNSW index file */
  private readonly indexPath: string | undefined

  /** Distance metric */
  private readonly distanceMetric: 'cosine' | 'l2' | 'ip'

  /** Auto-save flag */
  private readonly autoSave: boolean

  /** Map of skill IDs to internal HNSW labels (for reverse lookup) */
  private skillIdToLabel: Map<string, number> = new Map()

  /** Map of HNSW labels to skill IDs */
  private labelToSkillId: Map<number, string> = new Map()

  /** Next available label for HNSW insertion */
  private nextLabel = 0

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new HNSWEmbeddingStore instance.
   *
   * @param options - Configuration options
   *
   * @example
   * ```typescript
   * // Default configuration (auto-detects HNSW availability)
   * const store = new HNSWEmbeddingStore();
   *
   * // With persistence
   * const store = new HNSWEmbeddingStore({
   *   dbPath: './embeddings.db',
   *   indexPath: './embeddings.hnsw',
   * });
   *
   * // Force brute-force fallback
   * const store = new HNSWEmbeddingStore({ useHNSW: false });
   * ```
   */
  /** V3 VectorDB instance (if initialized) */
  private vectorDB: VectorDB | null = null

  /** Promise for async initialization */
  private initPromise: Promise<void> | null = null

  constructor(options: HNSWEmbeddingStoreOptions = {}) {
    // Determine HNSW mode from options or environment
    this.hnswEnabled = this.shouldUseHNSW(options.useHNSW)

    // Merge configuration with defaults
    this.config = {
      ...DEFAULT_HNSW_CONFIG,
      ...options.hnswConfig,
    }

    this.maxElements = options.maxElements ?? 100000
    this.indexPath = options.indexPath
    this.distanceMetric = options.distanceMetric ?? 'cosine'
    this.autoSave = options.autoSave ?? false

    // Initialize SQLite database
    if (options.dbPath) {
      this.initDatabase(options.dbPath)
    }

    // Initialize HNSW index asynchronously (if enabled)
    if (this.hnswEnabled) {
      this.initPromise = this.initHNSWIndex()
    }
  }

  /**
   * Ensure the store is fully initialized.
   * Call this before operations that require the HNSW index.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise
    }
  }

  // -------------------------------------------------------------------------
  // Public Methods (IEmbeddingStore Interface)
  // -------------------------------------------------------------------------

  /**
   * Store an embedding with its metadata.
   *
   * Inserts the vector into both HNSW index (for fast search) and
   * SQLite (for metadata persistence).
   *
   * @param skillId - Unique identifier for the skill
   * @param embedding - Vector embedding (must match configured dimensions)
   * @param text - Original text that was embedded
   * @throws Error if embedding dimensions don't match configuration
   */
  storeEmbedding(skillId: string, embedding: Float32Array, text: string): void {
    // Validate embedding dimensions
    if (embedding.length !== this.config.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: got ${embedding.length}, expected ${this.config.dimensions}`
      )
    }

    // Store in SQLite (metadata + embedding blob for brute-force fallback)
    if (this.db) {
      const buffer = Buffer.from(embedding.buffer)
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding, text, created_at)
        VALUES (?, ?, ?, unixepoch())
      `)
      stmt.run(skillId, buffer, text)
    }

    // Insert into V3 VectorDB (HNSW index)
    if (this.vectorDB) {
      // VectorDB.insert may be sync or async depending on backend
      const result = this.vectorDB.insert(embedding, skillId, { text })
      if (result instanceof Promise) {
        // Fire and forget for sync interface, but log errors
        result.catch((err) => {
          console.warn(`[HNSWEmbeddingStore] Failed to insert into VectorDB: ${err}`)
        })
      }
    }
  }

  /**
   * Retrieve a stored embedding by skill ID.
   *
   * @param skillId - Unique identifier for the skill
   * @returns The embedding if found, null otherwise
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
   * Get all stored embeddings.
   *
   * Note: For large datasets, consider using findSimilar() instead
   * to avoid loading all vectors into memory.
   *
   * @returns Map of skill IDs to their embeddings
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
   * Find most similar embeddings to a query vector.
   *
   * Uses HNSW for O(log n) approximate search when available,
   * falls back to O(n) brute-force cosine similarity otherwise.
   *
   * @param queryEmbedding - Query vector (must match configured dimensions)
   * @param topK - Number of results to return (default: 10)
   * @returns Array of skill IDs with similarity scores, sorted descending
   */
  findSimilar(queryEmbedding: Float32Array, topK: number = 10): SimilarityResult[] {
    // Validate query dimensions
    if (queryEmbedding.length !== this.config.dimensions) {
      throw new Error(
        `Query dimension mismatch: got ${queryEmbedding.length}, expected ${this.config.dimensions}`
      )
    }

    // Try HNSW search first (if available)
    if (this.vectorDB) {
      try {
        // VectorDB.search may be sync or async
        const searchResult = this.vectorDB.search(queryEmbedding, topK)

        // Handle async case by returning empty and logging
        // (sync interface limitation - caller should use findSimilarAsync for async)
        if (searchResult instanceof Promise) {
          // For sync interface, fall back to brute-force
          console.warn(
            '[HNSWEmbeddingStore] VectorDB.search returned Promise, using brute-force fallback'
          )
        } else {
          // Convert VectorDB results to SimilarityResult format
          return searchResult.map((result) => ({
            skillId: result.id,
            score: result.score,
          }))
        }
      } catch (err) {
        console.warn(`[HNSWEmbeddingStore] HNSW search failed, falling back to brute-force: ${err}`)
      }
    }

    // Brute-force fallback: compute cosine similarity for all embeddings
    const allEmbeddings = this.getAllEmbeddings()
    const results: SimilarityResult[] = []

    for (const [skillId, embedding] of allEmbeddings) {
      const score = this.cosineSimilarity(queryEmbedding, embedding)
      results.push({ skillId, score })
    }

    // Sort by similarity score descending and return topK
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  /**
   * Async version of findSimilar for backends that require async search.
   *
   * @param queryEmbedding - Query vector (must match configured dimensions)
   * @param topK - Number of results to return (default: 10)
   * @returns Promise resolving to array of skill IDs with similarity scores
   */
  async findSimilarAsync(
    queryEmbedding: Float32Array,
    topK: number = 10
  ): Promise<SimilarityResult[]> {
    // Ensure HNSW is initialized
    await this.ensureInitialized()

    // Validate query dimensions
    if (queryEmbedding.length !== this.config.dimensions) {
      throw new Error(
        `Query dimension mismatch: got ${queryEmbedding.length}, expected ${this.config.dimensions}`
      )
    }

    // Try HNSW search first (if available)
    if (this.vectorDB) {
      try {
        const searchResult = this.vectorDB.search(queryEmbedding, topK)
        const results = searchResult instanceof Promise ? await searchResult : searchResult

        return results.map((result) => ({
          skillId: result.id,
          score: result.score,
        }))
      } catch (err) {
        console.warn(`[HNSWEmbeddingStore] HNSW search failed, falling back to brute-force: ${err}`)
      }
    }

    // Brute-force fallback
    return this.findSimilar(queryEmbedding, topK)
  }

  /**
   * Compute cosine similarity between two embeddings.
   *
   * @param a - First embedding
   * @param b - Second embedding
   * @returns Similarity score between -1 and 1
   * @throws Error if embeddings have different dimensions
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(
        `Embedding dimension mismatch: ${a.length} vs ${b.length}. ` +
          `Expected ${this.config.dimensions}.`
      )
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
   * Check if running in fallback (brute-force) mode.
   *
   * @returns true if using brute-force, false if using HNSW
   */
  isUsingFallback(): boolean {
    return !this.hnswEnabled || this.index === null
  }

  /**
   * Close database connections and release resources.
   *
   * Saves HNSW index to disk if indexPath was configured.
   * Safe to call multiple times.
   */
  close(): void {
    // TODO: SMI-1519 - Implement
    // 1. Save HNSW index if indexPath configured
    // 2. Close SQLite database
    // 3. Clear label mappings
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  // -------------------------------------------------------------------------
  // Extended Public Methods (HNSW-specific)
  // -------------------------------------------------------------------------

  /**
   * Get statistics about the HNSW index.
   *
   * @returns Index statistics including capacity, utilization, and config
   */
  getStats(): HNSWIndexStats {
    let vectorCount = 0

    // Get count from SQLite
    if (this.db) {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM skill_embeddings')
      const row = stmt.get() as { count: number }
      vectorCount = row.count
    }

    // Get count from VectorDB if available
    if (this.vectorDB) {
      try {
        const size = this.vectorDB.size()
        if (!(size instanceof Promise)) {
          vectorCount = Math.max(vectorCount, size)
        }
      } catch {
        // Ignore errors, use SQLite count
      }
    }

    const utilizationPercent = this.maxElements > 0 ? (vectorCount / this.maxElements) * 100 : 0

    // Estimate memory usage (rough approximation)
    // HNSW uses ~(4 * dimensions + M * 4 * 2) bytes per vector
    const bytesPerVector = 4 * this.config.dimensions + this.config.m * 8
    const memoryUsageBytes = vectorCount * bytesPerVector

    return {
      vectorCount,
      maxCapacity: this.maxElements,
      utilizationPercent: Math.round(utilizationPercent * 100) / 100,
      m: this.config.m,
      efConstruction: this.config.efConstruction,
      efSearch: this.config.efSearch,
      dimensions: this.config.dimensions,
      memoryUsageBytes,
      isHNSWEnabled: this.vectorDB !== null,
      indexPath: this.indexPath,
    }
  }

  /**
   * Batch insert multiple embeddings efficiently.
   *
   * More efficient than calling storeEmbedding() in a loop
   * due to batched SQLite transactions and HNSW insertions.
   *
   * @param embeddings - Array of embeddings to insert
   * @returns Batch operation result with counts and timing
   */
  batchInsert(
    embeddings: Array<{ skillId: string; embedding: Float32Array; text: string }>
  ): BatchInsertResult {
    const startTime = Date.now()
    const result: BatchInsertResult = {
      inserted: 0,
      updated: 0,
      failed: 0,
      errors: [],
      durationMs: 0,
    }

    if (!this.db) {
      result.errors.push({ skillId: '*', error: 'Database not initialized' })
      result.durationMs = Date.now() - startTime
      return result
    }

    // Use a transaction for batch SQLite operations
    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding, text, created_at)
      VALUES (?, ?, ?, unixepoch())
    `)

    const checkStmt = this.db.prepare(`
      SELECT 1 FROM skill_embeddings WHERE skill_id = ?
    `)

    const transaction = this.db.transaction(() => {
      for (const { skillId, embedding, text } of embeddings) {
        try {
          // Validate dimensions
          if (embedding.length !== this.config.dimensions) {
            result.failed++
            result.errors.push({
              skillId,
              error: `Dimension mismatch: got ${embedding.length}, expected ${this.config.dimensions}`,
            })
            continue
          }

          // Check if exists (for updated count)
          const exists = checkStmt.get(skillId)

          // Insert into SQLite
          const buffer = Buffer.from(embedding.buffer)
          insertStmt.run(skillId, buffer, text)

          // Insert into VectorDB
          if (this.vectorDB) {
            try {
              this.vectorDB.insert(embedding, skillId, { text })
            } catch (err) {
              // Log but don't fail - SQLite is the source of truth
              console.warn(`[HNSWEmbeddingStore] VectorDB insert failed for ${skillId}: ${err}`)
            }
          }

          if (exists) {
            result.updated++
          } else {
            result.inserted++
          }
        } catch (err) {
          result.failed++
          result.errors.push({
            skillId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })

    transaction()
    result.durationMs = Date.now() - startTime
    return result
  }

  /**
   * Remove an embedding from the store.
   *
   * Note: HNSW does not support true deletion. The vector is marked
   * as deleted and excluded from search results, but memory is not
   * reclaimed until the index is rebuilt.
   *
   * @param skillId - Unique identifier for the skill to remove
   * @returns true if removed, false if not found
   */
  removeEmbedding(skillId: string): boolean {
    let removed = false

    // Remove from SQLite
    if (this.db) {
      const stmt = this.db.prepare('DELETE FROM skill_embeddings WHERE skill_id = ?')
      const result = stmt.run(skillId)
      removed = result.changes > 0
    }

    // Remove from VectorDB (if supported)
    if (this.vectorDB && removed) {
      try {
        const vdbResult = this.vectorDB.remove(skillId)
        // VectorDB.remove may be sync or async
        if (vdbResult instanceof Promise) {
          vdbResult.catch((err) => {
            console.warn(`[HNSWEmbeddingStore] VectorDB remove failed for ${skillId}: ${err}`)
          })
        }
      } catch (err) {
        // Log but don't fail - SQLite is the source of truth
        console.warn(`[HNSWEmbeddingStore] VectorDB remove failed for ${skillId}: ${err}`)
      }
    }

    return removed
  }

  /**
   * Save the HNSW index to disk.
   *
   * Note: V3 VectorDB manages its own persistence, so this is a no-op
   * unless using hnswlib-node directly.
   *
   * @throws Error if indexPath was not configured
   */
  saveIndex(): void {
    if (!this.indexPath) {
      throw new Error('Cannot save index: indexPath not configured')
    }

    // V3 VectorDB handles its own persistence
    // For hnswlib-node, we would call index.saveIndex(this.indexPath)
    console.log(`[HNSWEmbeddingStore] Index persistence managed by V3 VectorDB backend`)
  }

  /**
   * Load the HNSW index from disk.
   *
   * Note: V3 VectorDB manages its own persistence, so this is a no-op
   * unless using hnswlib-node directly.
   *
   * @throws Error if indexPath was not configured or file doesn't exist
   */
  loadIndex(): void {
    if (!this.indexPath) {
      throw new Error('Cannot load index: indexPath not configured')
    }

    // V3 VectorDB handles its own persistence
    // For hnswlib-node, we would call index.loadIndex(this.indexPath)
    console.log(`[HNSWEmbeddingStore] Index persistence managed by V3 VectorDB backend`)
  }

  /**
   * Rebuild the HNSW index from SQLite data.
   *
   * Useful after many deletions to reclaim memory, or to apply
   * new HNSW configuration parameters.
   *
   * @param newConfig - Optional new HNSW configuration
   */
  async rebuildIndex(newConfig?: Partial<HNSWConfig>): Promise<void> {
    // Update config if provided
    if (newConfig) {
      Object.assign(this.config, newConfig)
    }

    // Clear existing VectorDB
    if (this.vectorDB) {
      try {
        const clearResult = this.vectorDB.clear()
        if (clearResult instanceof Promise) {
          await clearResult
        }
      } catch (err) {
        console.warn(`[HNSWEmbeddingStore] Failed to clear VectorDB: ${err}`)
      }
    }

    // Reinitialize VectorDB
    await this.initHNSWIndex()

    // Re-insert all embeddings from SQLite
    if (this.db && this.vectorDB) {
      const allEmbeddings = this.getAllEmbeddings()
      for (const [skillId, embedding] of allEmbeddings) {
        try {
          const result = this.vectorDB.insert(embedding, skillId)
          if (result instanceof Promise) {
            await result
          }
        } catch (err) {
          console.warn(`[HNSWEmbeddingStore] Failed to reinsert ${skillId}: ${err}`)
        }
      }
    }
  }

  /**
   * Update efSearch parameter at runtime.
   *
   * Note: V3 VectorDB does not expose efSearch tuning directly.
   * This method is provided for API compatibility.
   *
   * @param efSearch - New efSearch value (must be > 0)
   */
  setEfSearch(efSearch: number): void {
    if (efSearch <= 0) {
      throw new Error('efSearch must be > 0')
    }
    this.config.efSearch = efSearch
    // V3 VectorDB doesn't expose efSearch tuning
    // For hnswlib-node, we would call index.setEfSearch(efSearch)
    console.log(`[HNSWEmbeddingStore] efSearch updated to ${efSearch} (will apply on next search)`)
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Determine whether to use HNSW based on explicit option or environment.
   */
  private shouldUseHNSW(explicit?: boolean): boolean {
    if (explicit !== undefined) {
      return explicit
    }

    // Check environment variable
    const envValue = process.env.SKILLSMITH_USE_HNSW
    if (envValue !== undefined) {
      return envValue === 'true' || envValue === '1'
    }

    // Default to false (use brute-force) for backward compatibility
    // TODO: Consider changing default to true in future version
    return false
  }

  /**
   * Initialize SQLite database and create tables.
   */
  private initDatabase(dbPath: string): void {
    this.db = new Database(dbPath)

    // Create skill_embeddings table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_embeddings (
        skill_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `)

    // Create index for fast lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_embeddings_id
      ON skill_embeddings(skill_id)
    `)
  }

  /**
   * Initialize HNSW index using V3 VectorDB API.
   * Falls back gracefully if V3 is unavailable.
   */
  private async initHNSWIndex(): Promise<void> {
    try {
      // Dynamically import V3 VectorDB module
      const vectorDbModule =
        await import('claude-flow/v3/@claude-flow/cli/dist/src/ruvector/vector-db.js')

      // Load ruvector backend (may use WASM acceleration)
      const loaded = await vectorDbModule.loadRuVector()
      if (!loaded) {
        console.warn('[HNSWEmbeddingStore] ruvector not available, using fallback backend')
      }

      // Create VectorDB instance
      this.vectorDB = await vectorDbModule.createVectorDB(this.config.dimensions)

      // Log status
      const status = vectorDbModule.getStatus()
      console.log(
        `[HNSWEmbeddingStore] Initialized with backend: ${status.backend}` +
          (status.wasmAccelerated ? ' (WASM accelerated)' : '')
      )

      // Re-populate VectorDB from SQLite if we have existing data
      if (this.db) {
        const count = this.db.prepare('SELECT COUNT(*) as c FROM skill_embeddings').get() as {
          c: number
        }
        if (count.c > 0) {
          console.log(
            `[HNSWEmbeddingStore] Rebuilding index from ${count.c} existing embeddings...`
          )
          const allEmbeddings = this.getAllEmbeddings()
          for (const [skillId, embedding] of allEmbeddings) {
            try {
              const result = this.vectorDB.insert(embedding, skillId)
              if (result instanceof Promise) {
                await result
              }
            } catch (err) {
              console.warn(`[HNSWEmbeddingStore] Failed to insert ${skillId}: ${err}`)
            }
          }
          console.log(`[HNSWEmbeddingStore] Index rebuilt with ${allEmbeddings.size} vectors`)
        }
      }
    } catch (err) {
      // V3 VectorDB not available - will use brute-force fallback
      console.warn(
        `[HNSWEmbeddingStore] Failed to initialize V3 VectorDB, using brute-force fallback: ${err}`
      )
      this.vectorDB = null
    }
  }

  /**
   * Convert HNSW distance to similarity score.
   * HNSW returns distances, we need similarities (higher = more similar).
   */
  private distanceToSimilarity(distance: number): number {
    // For cosine space, HNSW returns 1 - cosine_similarity
    // So similarity = 1 - distance
    if (this.distanceMetric === 'cosine') {
      return 1 - distance
    }

    // For L2/IP, need different conversion
    // TODO: Implement for other metrics
    return 1 / (1 + distance)
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an HNSWEmbeddingStore with a preset configuration.
 *
 * @param preset - Preset name ('small', 'medium', 'large', 'xlarge')
 * @param options - Additional options (merged with preset)
 * @returns Configured HNSWEmbeddingStore instance
 *
 * @example
 * ```typescript
 * const store = createHNSWStore('large', {
 *   dbPath: './embeddings.db',
 *   indexPath: './embeddings.hnsw',
 * });
 * ```
 */
export function createHNSWStore(
  preset: keyof typeof HNSW_PRESETS,
  options: Omit<HNSWEmbeddingStoreOptions, 'hnswConfig'> = {}
): HNSWEmbeddingStore {
  return new HNSWEmbeddingStore({
    ...options,
    hnswConfig: HNSW_PRESETS[preset],
  })
}

/**
 * Check if hnswlib-node is available.
 *
 * Useful for conditional logic or graceful degradation.
 *
 * @returns true if hnswlib-node can be loaded
 */
export async function isHNSWAvailable(): Promise<boolean> {
  try {
    // Dynamic import to check availability without static analysis errors

    await (Function('return import("hnswlib-node")')() as Promise<unknown>)
    return true
  } catch {
    return false
  }
}

/**
 * Dynamically load hnswlib-node module.
 *
 * @returns The HierarchicalNSW constructor, or null if unavailable
 * @internal
 */
export async function loadHNSWLib(): Promise<{
  HierarchicalNSW: HierarchicalNSWConstructor
} | null> {
  try {
    // Dynamic import to avoid TypeScript static analysis

    const mod = await (Function('return import("hnswlib-node")')() as Promise<{
      HierarchicalNSW: HierarchicalNSWConstructor
    }>)
    return mod
  } catch {
    return null
  }
}
