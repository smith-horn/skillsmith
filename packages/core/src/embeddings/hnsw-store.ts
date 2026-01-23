/**
 * SMI-1519: HNSW Embedding Store
 *
 * High-performance vector storage using HNSW index for fast ANN search.
 * Uses claude-flow V3 VectorDB API with automatic fallback to brute-force.
 *
 * Enable via: SKILLSMITH_USE_HNSW=true
 * @see ADR-009: Embedding Service Fallback Strategy
 */

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
// IMPORTANT: Keep this type-only import here (prevents circular runtime dependency)
import type { SimilarityResult } from './index.js'

// V3 VectorDB types from claude-flow
import type { VectorDB } from 'claude-flow/v3/@claude-flow/cli/dist/src/ruvector/vector-db.js'

// Re-export types for public API
export type {
  HierarchicalNSW,
  HNSWSearchResult,
  HierarchicalNSWConstructor,
  HNSWConfig,
  HNSWEmbeddingStoreOptions,
  HNSWIndexStats,
  BatchInsertResult,
  IEmbeddingStore,
} from './hnsw-store.types.js'
export { DEFAULT_HNSW_CONFIG, HNSW_PRESETS } from './hnsw-store.types.js'

// Re-export factory functions
export { createHNSWStore, isHNSWAvailable, loadHNSWLib } from './hnsw-store.helpers.js'

// Internal imports
import type {
  HNSWConfig,
  HNSWEmbeddingStoreOptions,
  HNSWIndexStats,
  BatchInsertResult,
  IEmbeddingStore,
  HierarchicalNSW,
} from './hnsw-store.types.js'
import { DEFAULT_HNSW_CONFIG } from './hnsw-store.types.js'
import { shouldUseHNSW, validateDimensions, estimateMemoryUsage } from './hnsw-store.helpers.js'

/**
 * High-performance embedding storage using HNSW index.
 * Provides O(log n) approximate nearest neighbor search with SQLite persistence.
 */
export class HNSWEmbeddingStore implements IEmbeddingStore {
  private db: DatabaseType | null = null
  private index: HierarchicalNSW | null = null
  private readonly hnswEnabled: boolean
  private readonly config: HNSWConfig
  private readonly maxElements: number
  private readonly indexPath: string | undefined
  private readonly distanceMetric: 'cosine' | 'l2' | 'ip'
  private readonly autoSave: boolean
  private skillIdToLabel: Map<string, number> = new Map()
  private labelToSkillId: Map<number, string> = new Map()
  private nextLabel = 0
  private vectorDB: VectorDB | null = null
  private initPromise: Promise<void> | null = null

  constructor(options: HNSWEmbeddingStoreOptions = {}) {
    this.hnswEnabled = shouldUseHNSW(options.useHNSW)
    this.config = { ...DEFAULT_HNSW_CONFIG, ...options.hnswConfig }
    this.maxElements = options.maxElements ?? 100000
    this.indexPath = options.indexPath
    this.distanceMetric = options.distanceMetric ?? 'cosine'
    this.autoSave = options.autoSave ?? false

    if (options.dbPath) {
      this.initDatabase(options.dbPath)
    }

    // IMPORTANT: Keep dynamic import here for V3 lazy loading / graceful degradation
    if (this.hnswEnabled) {
      this.initPromise = this.initHNSWIndex()
    }
  }

  async ensureInitialized(): Promise<void> {
    if (this.initPromise) await this.initPromise
  }

  storeEmbedding(skillId: string, embedding: Float32Array, text: string): void {
    validateDimensions(embedding, this.config.dimensions, 'Embedding')

    if (this.db) {
      const buffer = Buffer.from(embedding.buffer)
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding, text, created_at)
        VALUES (?, ?, ?, unixepoch())
      `)
      stmt.run(skillId, buffer, text)
    }

    if (this.vectorDB) {
      const result = this.vectorDB.insert(embedding, skillId, { text })
      if (result instanceof Promise) {
        result.catch((err) => {
          console.warn(`[HNSWEmbeddingStore] Failed to insert into VectorDB: ${err}`)
        })
      }
    }
  }

  getEmbedding(skillId: string): Float32Array | null {
    if (!this.db) return null
    const stmt = this.db.prepare('SELECT embedding FROM skill_embeddings WHERE skill_id = ?')
    const row = stmt.get(skillId) as { embedding: Buffer } | undefined
    if (!row) return null
    return new Float32Array(
      row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength
      )
    )
  }

  getAllEmbeddings(): Map<string, Float32Array> {
    if (!this.db) return new Map()
    const stmt = this.db.prepare('SELECT skill_id, embedding FROM skill_embeddings')
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

  findSimilar(queryEmbedding: Float32Array, topK: number = 10): SimilarityResult[] {
    validateDimensions(queryEmbedding, this.config.dimensions)

    if (this.vectorDB) {
      try {
        const searchResult = this.vectorDB.search(queryEmbedding, topK)
        if (searchResult instanceof Promise) {
          console.warn('[HNSWEmbeddingStore] VectorDB.search returned Promise, using brute-force')
        } else {
          return searchResult.map((r) => ({ skillId: r.id, score: r.score }))
        }
      } catch (err) {
        console.warn(`[HNSWEmbeddingStore] HNSW search failed, falling back: ${err}`)
      }
    }

    // Brute-force fallback
    const allEmbeddings = this.getAllEmbeddings()
    const results: SimilarityResult[] = []
    for (const [skillId, embedding] of allEmbeddings) {
      results.push({ skillId, score: this.cosineSimilarity(queryEmbedding, embedding) })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  async findSimilarAsync(
    queryEmbedding: Float32Array,
    topK: number = 10
  ): Promise<SimilarityResult[]> {
    await this.ensureInitialized()
    validateDimensions(queryEmbedding, this.config.dimensions)

    if (this.vectorDB) {
      try {
        const searchResult = this.vectorDB.search(queryEmbedding, topK)
        const results = searchResult instanceof Promise ? await searchResult : searchResult
        return results.map((r) => ({ skillId: r.id, score: r.score }))
      } catch (err) {
        console.warn(`[HNSWEmbeddingStore] HNSW search failed, falling back: ${err}`)
      }
    }
    return this.findSimilar(queryEmbedding, topK)
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`)
    }
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

  isUsingFallback(): boolean {
    return !this.hnswEnabled || this.index === null
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  getStats(): HNSWIndexStats {
    let vectorCount = 0
    if (this.db) {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM skill_embeddings')
      vectorCount = (stmt.get() as { count: number }).count
    }
    if (this.vectorDB) {
      try {
        const size = this.vectorDB.size()
        if (!(size instanceof Promise)) vectorCount = Math.max(vectorCount, size)
      } catch {
        /* ignore */
      }
    }
    return {
      vectorCount,
      maxCapacity: this.maxElements,
      utilizationPercent: Math.round((vectorCount / this.maxElements) * 10000) / 100,
      m: this.config.m,
      efConstruction: this.config.efConstruction,
      efSearch: this.config.efSearch,
      dimensions: this.config.dimensions,
      memoryUsageBytes: estimateMemoryUsage(vectorCount, this.config.dimensions, this.config.m),
      isHNSWEnabled: this.vectorDB !== null,
      indexPath: this.indexPath,
    }
  }

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

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding, text, created_at)
      VALUES (?, ?, ?, unixepoch())
    `)
    const checkStmt = this.db.prepare('SELECT 1 FROM skill_embeddings WHERE skill_id = ?')

    const transaction = this.db.transaction(() => {
      for (const { skillId, embedding, text } of embeddings) {
        try {
          if (embedding.length !== this.config.dimensions) {
            result.failed++
            result.errors.push({ skillId, error: `Dimension mismatch: ${embedding.length}` })
            continue
          }
          const exists = checkStmt.get(skillId)
          insertStmt.run(skillId, Buffer.from(embedding.buffer), text)
          if (this.vectorDB) {
            try {
              this.vectorDB.insert(embedding, skillId, { text })
            } catch (err) {
              console.warn(`VectorDB insert failed for ${skillId}: ${err}`)
            }
          }
          if (exists) result.updated++
          else result.inserted++
        } catch (err) {
          result.failed++
          result.errors.push({ skillId, error: err instanceof Error ? err.message : String(err) })
        }
      }
    })

    transaction()
    result.durationMs = Date.now() - startTime
    return result
  }

  removeEmbedding(skillId: string): boolean {
    let removed = false
    if (this.db) {
      const stmt = this.db.prepare('DELETE FROM skill_embeddings WHERE skill_id = ?')
      removed = stmt.run(skillId).changes > 0
    }
    if (this.vectorDB && removed) {
      try {
        const vdbResult = this.vectorDB.remove(skillId)
        if (vdbResult instanceof Promise) {
          vdbResult.catch((err) => console.warn(`VectorDB remove failed: ${err}`))
        }
      } catch (err) {
        console.warn(`VectorDB remove failed: ${err}`)
      }
    }
    return removed
  }

  saveIndex(): void {
    if (!this.indexPath) throw new Error('Cannot save index: indexPath not configured')
    console.log('[HNSWEmbeddingStore] Index persistence managed by V3 VectorDB backend')
  }

  loadIndex(): void {
    if (!this.indexPath) throw new Error('Cannot load index: indexPath not configured')
    console.log('[HNSWEmbeddingStore] Index persistence managed by V3 VectorDB backend')
  }

  async rebuildIndex(newConfig?: Partial<HNSWConfig>): Promise<void> {
    if (newConfig) Object.assign(this.config, newConfig)
    if (this.vectorDB) {
      try {
        const clearResult = this.vectorDB.clear()
        if (clearResult instanceof Promise) await clearResult
      } catch (err) {
        console.warn(`Failed to clear VectorDB: ${err}`)
      }
    }
    await this.initHNSWIndex()
    if (this.db && this.vectorDB) {
      const allEmbeddings = this.getAllEmbeddings()
      for (const [skillId, embedding] of allEmbeddings) {
        try {
          const result = this.vectorDB.insert(embedding, skillId)
          if (result instanceof Promise) await result
        } catch (err) {
          console.warn(`Failed to reinsert ${skillId}: ${err}`)
        }
      }
    }
  }

  setEfSearch(efSearch: number): void {
    if (efSearch <= 0) throw new Error('efSearch must be > 0')
    this.config.efSearch = efSearch
    console.log(`[HNSWEmbeddingStore] efSearch updated to ${efSearch}`)
  }

  // Private methods
  private initDatabase(dbPath: string): void {
    this.db = new Database(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_embeddings (
        skill_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_skill_embeddings_id ON skill_embeddings(skill_id);
    `)
  }

  // IMPORTANT: Keep dynamic import here for V3 lazy loading / graceful degradation
  private async initHNSWIndex(): Promise<void> {
    try {
      const vectorDbModule =
        await import('claude-flow/v3/@claude-flow/cli/dist/src/ruvector/vector-db.js')
      const loaded = await vectorDbModule.loadRuVector()
      if (!loaded) console.warn('[HNSWEmbeddingStore] ruvector not available')

      this.vectorDB = await vectorDbModule.createVectorDB(this.config.dimensions)
      const status = vectorDbModule.getStatus()
      console.log(
        `[HNSWEmbeddingStore] Initialized: ${status.backend}${status.wasmAccelerated ? ' (WASM)' : ''}`
      )

      // Rebuild from SQLite
      if (this.db) {
        const count = this.db.prepare('SELECT COUNT(*) as c FROM skill_embeddings').get() as {
          c: number
        }
        if (count.c > 0) {
          console.log(`[HNSWEmbeddingStore] Rebuilding from ${count.c} embeddings...`)
          const allEmbeddings = this.getAllEmbeddings()
          for (const [skillId, embedding] of allEmbeddings) {
            try {
              const result = this.vectorDB.insert(embedding, skillId)
              if (result instanceof Promise) await result
            } catch (err) {
              console.warn(`Failed to insert ${skillId}: ${err}`)
            }
          }
          console.log(`[HNSWEmbeddingStore] Index rebuilt with ${allEmbeddings.size} vectors`)
        }
      }
    } catch (err) {
      console.warn(`[HNSWEmbeddingStore] V3 VectorDB unavailable, using brute-force: ${err}`)
      this.vectorDB = null
    }
  }

  private distanceToSimilarity(distance: number): number {
    if (this.distanceMetric === 'cosine') return 1 - distance
    return 1 / (1 + distance)
  }
}
