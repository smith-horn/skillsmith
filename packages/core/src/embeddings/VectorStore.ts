/**
 * SMI-642: VectorStore - SQLite-based vector storage and similarity search
 *
 * Provides:
 * - Efficient vector storage using BLOB serialization
 * - Cosine similarity search with batched computation
 * - Index management for embeddings
 * - TTL-based expiration support
 */

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { cosineSimilarity as sharedCosineSimilarity } from './similarity.js'

export interface VectorEntry {
  id: string
  embedding: Float32Array
  metadata?: Record<string, unknown>
  createdAt: number
  expiresAt?: number
}

export interface SimilarityMatch {
  id: string
  score: number
  metadata?: Record<string, unknown>
}

export interface VectorStoreOptions {
  /** Database path (use :memory: for in-memory) */
  dbPath?: string
  /** Existing database connection to use */
  db?: DatabaseType
  /** Embedding dimension (default: 384 for all-MiniLM-L6-v2) */
  dimension?: number
  /** Table name for vectors (default: 'vectors') */
  tableName?: string
  /** Default TTL in seconds (optional) */
  defaultTtl?: number
}

export interface VectorStoreStats {
  totalVectors: number
  dimension: number
  tableName: string
  expiredCount: number
}

/**
 * Failed entry information for batch operations
 */
export interface FailedEntry {
  id: string
  reason: string
}

/**
 * Result of a batch store operation with detailed error information
 */
export interface BatchStoreResult {
  successCount: number
  failedEntries: FailedEntry[]
  totalProcessed: number
}

/**
 * Custom error class for VectorStore validation errors
 */
export class VectorStoreValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VectorStoreValidationError'
  }
}

/**
 * Custom error class for batch operation failures
 */
export class VectorStoreBatchError extends Error {
  public readonly failedEntries: FailedEntry[]
  public readonly successCount: number

  constructor(message: string, failedEntries: FailedEntry[], successCount: number) {
    super(message)
    this.name = 'VectorStoreBatchError'
    this.failedEntries = failedEntries
    this.successCount = successCount
  }
}

/**
 * SQLite-based vector store with cosine similarity search
 */
export class VectorStore {
  private readonly db: DatabaseType
  private readonly ownsDb: boolean
  private readonly dimension: number
  private readonly tableName: string
  private readonly defaultTtl?: number

  /**
   * Maximum allowed table name length (SQLite limit is 128, we use 64 for safety)
   */
  private static readonly MAX_TABLE_NAME_LENGTH = 64

  /**
   * Validates a table name to prevent SQL injection attacks.
   * Table names must:
   * - Not be empty or whitespace-only
   * - Start with a letter or underscore
   * - Contain only letters, numbers, and underscores
   * - Be no longer than 64 characters
   *
   * @param name - The table name to validate
   * @returns The validated table name (trimmed)
   * @throws VectorStoreValidationError if validation fails
   */
  private static validateTableName(name: string): string {
    // Check for empty or whitespace-only names
    if (!name || !name.trim()) {
      throw new VectorStoreValidationError('Table name cannot be empty or whitespace-only')
    }

    const trimmed = name.trim()

    // Check length
    if (trimmed.length > VectorStore.MAX_TABLE_NAME_LENGTH) {
      throw new VectorStoreValidationError(
        `Table name too long: max ${VectorStore.MAX_TABLE_NAME_LENGTH} characters, got ${trimmed.length}`
      )
    }

    // Only allow alphanumeric and underscores, must start with letter or underscore
    // This pattern prevents SQL injection by rejecting any special characters
    const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
    if (!validPattern.test(trimmed)) {
      throw new VectorStoreValidationError(
        `Invalid table name: "${trimmed}". Table names must start with a letter or underscore ` +
          'and contain only letters, numbers, and underscores.'
      )
    }

    return trimmed
  }

  constructor(options: VectorStoreOptions = {}) {
    this.dimension = options.dimension ?? 384
    this.tableName = VectorStore.validateTableName(options.tableName ?? 'vectors')
    this.defaultTtl = options.defaultTtl

    if (options.db) {
      this.db = options.db
      this.ownsDb = false
    } else {
      this.db = new Database(options.dbPath ?? ':memory:')
      this.ownsDb = true
    }

    this.initSchema()
  }

  /**
   * Initialize the vector storage schema
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER
      )
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_created
      ON ${this.tableName}(created_at)
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires
      ON ${this.tableName}(expires_at)
    `)
  }

  /**
   * Store a vector with optional metadata
   */
  store(
    id: string,
    embedding: Float32Array,
    metadata?: Record<string, unknown>,
    ttl?: number
  ): void {
    if (embedding.length !== this.dimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimension}, got ${embedding.length}`
      )
    }

    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
    const metadataJson = metadata ? JSON.stringify(metadata) : null
    const now = Math.floor(Date.now() / 1000)
    const effectiveTtl = ttl ?? this.defaultTtl
    const expiresAt = effectiveTtl ? now + effectiveTtl : null

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ${this.tableName} (id, embedding, metadata, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    stmt.run(id, buffer, metadataJson, now, expiresAt)
  }

  /**
   * Batch store multiple vectors efficiently
   */
  storeBatch(
    entries: Array<{ id: string; embedding: Float32Array; metadata?: Record<string, unknown> }>,
    ttl?: number
  ): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ${this.tableName} (id, embedding, metadata, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const now = Math.floor(Date.now() / 1000)
    const effectiveTtl = ttl ?? this.defaultTtl
    const expiresAt = effectiveTtl ? now + effectiveTtl : null

    const insertMany = this.db.transaction((items: typeof entries) => {
      let count = 0
      for (const { id, embedding, metadata } of items) {
        if (embedding.length !== this.dimension) {
          console.warn(`Skipping ${id}: dimension mismatch`)
          continue
        }

        const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
        const metadataJson = metadata ? JSON.stringify(metadata) : null
        stmt.run(id, buffer, metadataJson, now, expiresAt)
        count++
      }
      return count
    })

    return insertMany(entries)
  }

  /**
   * Batch store multiple vectors with detailed result information.
   * Unlike storeBatch, this method returns information about failed entries
   * instead of silently skipping them.
   */
  storeBatchWithResult(
    entries: Array<{ id: string; embedding: Float32Array; metadata?: Record<string, unknown> }>,
    ttl?: number
  ): BatchStoreResult {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ${this.tableName} (id, embedding, metadata, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const now = Math.floor(Date.now() / 1000)
    const effectiveTtl = ttl ?? this.defaultTtl
    const expiresAt = effectiveTtl ? now + effectiveTtl : null

    const failedEntries: FailedEntry[] = []

    const insertMany = this.db.transaction((items: typeof entries) => {
      let count = 0
      for (const { id, embedding, metadata } of items) {
        if (embedding.length !== this.dimension) {
          failedEntries.push({
            id,
            reason: `Embedding dimension mismatch: expected ${this.dimension}, got ${embedding.length}`,
          })
          continue
        }

        const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
        const metadataJson = metadata ? JSON.stringify(metadata) : null
        stmt.run(id, buffer, metadataJson, now, expiresAt)
        count++
      }
      return count
    })

    const successCount = insertMany(entries)

    return {
      successCount,
      failedEntries,
      totalProcessed: entries.length,
    }
  }

  /**
   * Batch store multiple vectors in strict mode.
   * Throws VectorStoreBatchError if any entries fail validation.
   */
  storeBatchStrict(
    entries: Array<{ id: string; embedding: Float32Array; metadata?: Record<string, unknown> }>,
    ttl?: number
  ): number {
    const result = this.storeBatchWithResult(entries, ttl)

    if (result.failedEntries.length > 0) {
      throw new VectorStoreBatchError(
        `Batch store failed: ${result.failedEntries.length} of ${result.totalProcessed} entries failed`,
        result.failedEntries,
        result.successCount
      )
    }

    return result.successCount
  }

  /**
   * Retrieve a vector by ID
   */
  get(id: string): VectorEntry | null {
    this.cleanupExpired()

    const stmt = this.db.prepare(`
      SELECT id, embedding, metadata, created_at, expires_at
      FROM ${this.tableName}
      WHERE id = ?
        AND (expires_at IS NULL OR expires_at > unixepoch())
    `)

    const row = stmt.get(id) as
      | {
          id: string
          embedding: Buffer
          metadata: string | null
          created_at: number
          expires_at: number | null
        }
      | undefined

    if (!row) return null

    return {
      id: row.id,
      embedding: this.bufferToFloat32Array(row.embedding),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }
  }

  /**
   * Get multiple vectors by IDs
   */
  getMany(ids: string[]): Map<string, VectorEntry> {
    if (ids.length === 0) return new Map()

    this.cleanupExpired()

    const placeholders = ids.map(() => '?').join(',')
    const stmt = this.db.prepare(`
      SELECT id, embedding, metadata, created_at, expires_at
      FROM ${this.tableName}
      WHERE id IN (${placeholders})
        AND (expires_at IS NULL OR expires_at > unixepoch())
    `)

    const rows = stmt.all(...ids) as Array<{
      id: string
      embedding: Buffer
      metadata: string | null
      created_at: number
      expires_at: number | null
    }>

    const result = new Map<string, VectorEntry>()
    for (const row of rows) {
      result.set(row.id, {
        id: row.id,
        embedding: this.bufferToFloat32Array(row.embedding),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
      })
    }

    return result
  }

  /**
   * Get all stored vectors (for similarity search)
   */
  getAll(): Map<string, Float32Array> {
    this.cleanupExpired()

    const stmt = this.db.prepare(`
      SELECT id, embedding
      FROM ${this.tableName}
      WHERE expires_at IS NULL OR expires_at > unixepoch()
    `)

    const rows = stmt.all() as Array<{ id: string; embedding: Buffer }>
    const result = new Map<string, Float32Array>()

    for (const row of rows) {
      result.set(row.id, this.bufferToFloat32Array(row.embedding))
    }

    return result
  }

  /**
   * Delete a vector by ID
   */
  delete(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`)
    const result = stmt.run(id)
    return result.changes > 0
  }

  /**
   * Delete multiple vectors by IDs
   */
  deleteMany(ids: string[]): number {
    if (ids.length === 0) return 0

    const placeholders = ids.map(() => '?').join(',')
    const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`)
    const result = stmt.run(...ids)
    return result.changes
  }

  /**
   * Clear all vectors
   */
  clear(): number {
    const stmt = this.db.prepare(`DELETE FROM ${this.tableName}`)
    const result = stmt.run()
    return result.changes
  }

  /**
   * Find similar vectors using cosine similarity
   */
  findSimilar(
    queryEmbedding: Float32Array,
    topK: number = 10,
    minScore: number = 0
  ): SimilarityMatch[] {
    if (queryEmbedding.length !== this.dimension) {
      throw new Error(
        `Query dimension mismatch: expected ${this.dimension}, got ${queryEmbedding.length}`
      )
    }

    const allVectors = this.getAll()
    const results: SimilarityMatch[] = []

    for (const [id, embedding] of allVectors) {
      const score = this.cosineSimilarity(queryEmbedding, embedding)
      if (score >= minScore) {
        results.push({ id, score })
      }
    }

    // Sort by score descending and take topK
    results.sort((a, b) => b.score - a.score)
    const topResults = results.slice(0, topK)

    // Fetch metadata for top results
    if (topResults.length > 0) {
      const entries = this.getMany(topResults.map((r) => r.id))
      for (const result of topResults) {
        const entry = entries.get(result.id)
        if (entry?.metadata) {
          result.metadata = entry.metadata
        }
      }
    }

    return topResults
  }

  /**
   * Find similar vectors from a subset of IDs
   */
  findSimilarInSet(
    queryEmbedding: Float32Array,
    candidateIds: string[],
    topK: number = 10,
    minScore: number = 0
  ): SimilarityMatch[] {
    if (queryEmbedding.length !== this.dimension) {
      throw new Error(
        `Query dimension mismatch: expected ${this.dimension}, got ${queryEmbedding.length}`
      )
    }

    const entries = this.getMany(candidateIds)
    const results: SimilarityMatch[] = []

    for (const [id, entry] of entries) {
      const score = this.cosineSimilarity(queryEmbedding, entry.embedding)
      if (score >= minScore) {
        results.push({ id, score, metadata: entry.metadata })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  /**
   * Compute cosine similarity between two vectors.
   * Delegates to the shared similarity utility for consistency.
   * @see similarity.ts for the implementation
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    return sharedCosineSimilarity(a, b)
  }

  /**
   * Get storage statistics
   */
  getStats(): VectorStoreStats {
    const totalStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM ${this.tableName}
      WHERE expires_at IS NULL OR expires_at > unixepoch()
    `)
    const { count: totalVectors } = totalStmt.get() as { count: number }

    const expiredStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM ${this.tableName}
      WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()
    `)
    const { count: expiredCount } = expiredStmt.get() as { count: number }

    return {
      totalVectors,
      dimension: this.dimension,
      tableName: this.tableName,
      expiredCount,
    }
  }

  /**
   * Check if a vector exists
   */
  has(id: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM ${this.tableName}
      WHERE id = ?
        AND (expires_at IS NULL OR expires_at > unixepoch())
    `)
    return stmt.get(id) !== undefined
  }

  /**
   * Get vector count
   */
  size(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM ${this.tableName}
      WHERE expires_at IS NULL OR expires_at > unixepoch()
    `)
    const { count } = stmt.get() as { count: number }
    return count
  }

  /**
   * Cleanup expired entries
   */
  cleanupExpired(): number {
    const stmt = this.db.prepare(`
      DELETE FROM ${this.tableName}
      WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()
    `)
    const result = stmt.run()
    return result.changes
  }

  /**
   * Convert Buffer to Float32Array
   */
  private bufferToFloat32Array(buffer: Buffer): Float32Array {
    // Create a copy of the buffer to ensure proper alignment
    const arrayBuffer = new ArrayBuffer(buffer.length)
    const uint8View = new Uint8Array(arrayBuffer)
    uint8View.set(buffer)
    return new Float32Array(arrayBuffer)
  }

  /**
   * Close the database connection (if owned)
   */
  close(): void {
    if (this.ownsDb) {
      this.db.close()
    }
  }
}

export default VectorStore
