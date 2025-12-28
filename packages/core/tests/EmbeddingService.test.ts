/**
 * SMI-642: EmbeddingService and VectorStore Tests
 *
 * Tests:
 * - Embedding generation (mocked for fast testing)
 * - Vector storage and retrieval
 * - Cosine similarity computation
 * - Batch processing
 * - TTL expiration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { EmbeddingService, VectorStore } from '../src/embeddings/index.js'
import type { VectorEntry, SimilarityMatch } from '../src/embeddings/index.js'

// Mock @xenova/transformers to avoid model downloads in tests
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(async (text: string) => ({
    data: new Float32Array(384).fill(0.5),
  })),
}))

describe('VectorStore', () => {
  let db: Database.Database
  let vectorStore: VectorStore

  beforeEach(() => {
    db = new Database(':memory:')
    vectorStore = new VectorStore({ db, dimension: 384 })
  })

  afterEach(() => {
    vectorStore.close()
    db.close()
  })

  describe('storage operations', () => {
    it('should store and retrieve a vector', () => {
      const embedding = new Float32Array(384).fill(0.1)
      const metadata = { name: 'test-skill', category: 'utility' }

      vectorStore.store('skill-1', embedding, metadata)

      const result = vectorStore.get('skill-1')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('skill-1')
      expect(result!.embedding.length).toBe(384)
      expect(result!.embedding[0]).toBeCloseTo(0.1)
      expect(result!.metadata).toEqual(metadata)
    })

    it('should return null for non-existent vector', () => {
      const result = vectorStore.get('non-existent')
      expect(result).toBeNull()
    })

    it('should overwrite existing vector on store', () => {
      const embedding1 = new Float32Array(384).fill(0.1)
      const embedding2 = new Float32Array(384).fill(0.9)

      vectorStore.store('skill-1', embedding1)
      vectorStore.store('skill-1', embedding2)

      const result = vectorStore.get('skill-1')
      expect(result!.embedding[0]).toBeCloseTo(0.9)
    })

    it('should reject vectors with wrong dimension', () => {
      const wrongDimension = new Float32Array(256).fill(0.1)

      expect(() => vectorStore.store('skill-1', wrongDimension)).toThrow(
        'Embedding dimension mismatch'
      )
    })

    it('should check if vector exists', () => {
      const embedding = new Float32Array(384).fill(0.1)
      vectorStore.store('skill-1', embedding)

      expect(vectorStore.has('skill-1')).toBe(true)
      expect(vectorStore.has('skill-2')).toBe(false)
    })

    it('should return correct size', () => {
      expect(vectorStore.size()).toBe(0)

      const embedding = new Float32Array(384).fill(0.1)
      vectorStore.store('skill-1', embedding)
      vectorStore.store('skill-2', embedding)

      expect(vectorStore.size()).toBe(2)
    })
  })

  describe('batch operations', () => {
    it('should batch store multiple vectors', () => {
      const entries = [
        { id: 'skill-1', embedding: new Float32Array(384).fill(0.1) },
        { id: 'skill-2', embedding: new Float32Array(384).fill(0.2) },
        { id: 'skill-3', embedding: new Float32Array(384).fill(0.3) },
      ]

      const count = vectorStore.storeBatch(entries)

      expect(count).toBe(3)
      expect(vectorStore.size()).toBe(3)
    })

    it('should skip vectors with wrong dimension in batch', () => {
      const entries = [
        { id: 'skill-1', embedding: new Float32Array(384).fill(0.1) },
        { id: 'skill-2', embedding: new Float32Array(256).fill(0.2) }, // Wrong dimension
        { id: 'skill-3', embedding: new Float32Array(384).fill(0.3) },
      ]

      const count = vectorStore.storeBatch(entries)

      expect(count).toBe(2)
      expect(vectorStore.has('skill-1')).toBe(true)
      expect(vectorStore.has('skill-2')).toBe(false)
      expect(vectorStore.has('skill-3')).toBe(true)
    })

    it('should get multiple vectors at once', () => {
      const entries = [
        { id: 'skill-1', embedding: new Float32Array(384).fill(0.1), metadata: { v: 1 } },
        { id: 'skill-2', embedding: new Float32Array(384).fill(0.2), metadata: { v: 2 } },
        { id: 'skill-3', embedding: new Float32Array(384).fill(0.3), metadata: { v: 3 } },
      ]
      vectorStore.storeBatch(entries)

      const results = vectorStore.getMany(['skill-1', 'skill-3', 'non-existent'])

      expect(results.size).toBe(2)
      expect(results.has('skill-1')).toBe(true)
      expect(results.has('skill-3')).toBe(true)
      expect(results.has('non-existent')).toBe(false)
    })

    it('should get all vectors', () => {
      const entries = [
        { id: 'skill-1', embedding: new Float32Array(384).fill(0.1) },
        { id: 'skill-2', embedding: new Float32Array(384).fill(0.2) },
      ]
      vectorStore.storeBatch(entries)

      const all = vectorStore.getAll()

      expect(all.size).toBe(2)
      expect(all.has('skill-1')).toBe(true)
      expect(all.has('skill-2')).toBe(true)
    })
  })

  describe('delete operations', () => {
    it('should delete a vector', () => {
      const embedding = new Float32Array(384).fill(0.1)
      vectorStore.store('skill-1', embedding)

      expect(vectorStore.delete('skill-1')).toBe(true)
      expect(vectorStore.has('skill-1')).toBe(false)
    })

    it('should return false when deleting non-existent vector', () => {
      expect(vectorStore.delete('non-existent')).toBe(false)
    })

    it('should delete multiple vectors', () => {
      const entries = [
        { id: 'skill-1', embedding: new Float32Array(384).fill(0.1) },
        { id: 'skill-2', embedding: new Float32Array(384).fill(0.2) },
        { id: 'skill-3', embedding: new Float32Array(384).fill(0.3) },
      ]
      vectorStore.storeBatch(entries)

      const deleted = vectorStore.deleteMany(['skill-1', 'skill-3', 'non-existent'])

      expect(deleted).toBe(2)
      expect(vectorStore.size()).toBe(1)
      expect(vectorStore.has('skill-2')).toBe(true)
    })

    it('should clear all vectors', () => {
      const entries = [
        { id: 'skill-1', embedding: new Float32Array(384).fill(0.1) },
        { id: 'skill-2', embedding: new Float32Array(384).fill(0.2) },
      ]
      vectorStore.storeBatch(entries)

      const cleared = vectorStore.clear()

      expect(cleared).toBe(2)
      expect(vectorStore.size()).toBe(0)
    })
  })

  describe('similarity search', () => {
    it('should compute cosine similarity correctly', () => {
      // Identical vectors should have similarity 1.0
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([1, 0, 0])
      expect(vectorStore.cosineSimilarity(a, b)).toBeCloseTo(1.0)

      // Orthogonal vectors should have similarity 0
      const c = new Float32Array([1, 0, 0])
      const d = new Float32Array([0, 1, 0])
      expect(vectorStore.cosineSimilarity(c, d)).toBeCloseTo(0.0)

      // Opposite vectors should have similarity -1.0
      const e = new Float32Array([1, 0, 0])
      const f = new Float32Array([-1, 0, 0])
      expect(vectorStore.cosineSimilarity(e, f)).toBeCloseTo(-1.0)
    })

    it('should throw for dimension mismatch in similarity', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([1, 0])

      expect(() => vectorStore.cosineSimilarity(a, b)).toThrow('Vectors must have same dimension')
    })

    it('should find similar vectors', () => {
      // Store vectors with distinct directions (not just different magnitudes)
      // Vector 1: mostly in first half of dimensions
      const v1 = new Float32Array(384)
      for (let i = 0; i < 192; i++) v1[i] = 1

      // Vector 2: evenly distributed
      const v2 = new Float32Array(384).fill(0.5)

      // Vector 3: mostly in second half of dimensions
      const v3 = new Float32Array(384)
      for (let i = 192; i < 384; i++) v3[i] = 1

      vectorStore.store('skill-1', v1)
      vectorStore.store('skill-2', v2)
      vectorStore.store('skill-3', v3)

      // Query with same vector as skill-2 (should match exactly)
      const query = new Float32Array(384).fill(0.5)
      const results = vectorStore.findSimilar(query, 3)

      expect(results.length).toBe(3)
      // skill-2 should be most similar (identical direction)
      expect(results[0].id).toBe('skill-2')
      expect(results[0].score).toBeCloseTo(1.0)
    })

    it('should respect minScore filter', () => {
      // Vector 1: orthogonal direction (first half)
      const v1 = new Float32Array(384)
      for (let i = 0; i < 192; i++) v1[i] = 1

      // Vector 2: evenly distributed (query will match exactly)
      const v2 = new Float32Array(384).fill(0.5)

      // Vector 3: orthogonal direction (second half)
      const v3 = new Float32Array(384)
      for (let i = 192; i < 384; i++) v3[i] = 1

      vectorStore.store('skill-1', v1)
      vectorStore.store('skill-2', v2)
      vectorStore.store('skill-3', v3)

      const query = new Float32Array(384).fill(0.5)
      const results = vectorStore.findSimilar(query, 10, 0.99)

      // Only skill-2 (identical) should match with score >= 0.99
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('skill-2')
    })

    it('should find similar in subset of IDs', () => {
      vectorStore.store('skill-1', new Float32Array(384).fill(0.1))
      vectorStore.store('skill-2', new Float32Array(384).fill(0.5))
      vectorStore.store('skill-3', new Float32Array(384).fill(0.9))

      const query = new Float32Array(384).fill(0.5)
      const results = vectorStore.findSimilarInSet(query, ['skill-1', 'skill-3'], 10)

      expect(results.length).toBe(2)
      // Neither skill-2 should be in results
      expect(results.map((r) => r.id)).not.toContain('skill-2')
    })

    it('should include metadata in similarity results', () => {
      vectorStore.store('skill-1', new Float32Array(384).fill(0.5), { name: 'Test Skill' })

      const query = new Float32Array(384).fill(0.5)
      const results = vectorStore.findSimilar(query, 1)

      expect(results[0].metadata).toEqual({ name: 'Test Skill' })
    })
  })

  describe('TTL expiration', () => {
    it('should expire vectors after TTL', () => {
      // Create store with 1 second TTL
      const storeWithTtl = new VectorStore({ db, tableName: 'vectors_ttl', defaultTtl: 1 })

      const embedding = new Float32Array(384).fill(0.1)
      storeWithTtl.store('skill-1', embedding)

      // Should exist immediately
      expect(storeWithTtl.has('skill-1')).toBe(true)

      // Manually expire by updating the database
      db.prepare("UPDATE vectors_ttl SET expires_at = unixepoch() - 10 WHERE id = 'skill-1'").run()

      // Should be gone after cleanup
      storeWithTtl.cleanupExpired()
      expect(storeWithTtl.has('skill-1')).toBe(false)

      storeWithTtl.close()
    })

    it('should not expire vectors without TTL', () => {
      const embedding = new Float32Array(384).fill(0.1)
      vectorStore.store('skill-1', embedding) // No TTL

      // Cleanup should not affect it
      vectorStore.cleanupExpired()
      expect(vectorStore.has('skill-1')).toBe(true)
    })
  })

  describe('statistics', () => {
    it('should return accurate stats', () => {
      const entries = [
        { id: 'skill-1', embedding: new Float32Array(384).fill(0.1) },
        { id: 'skill-2', embedding: new Float32Array(384).fill(0.2) },
      ]
      vectorStore.storeBatch(entries)

      const stats = vectorStore.getStats()

      expect(stats.totalVectors).toBe(2)
      expect(stats.dimension).toBe(384)
      expect(stats.tableName).toBe('vectors')
      expect(stats.expiredCount).toBe(0)
    })
  })
})

describe('EmbeddingService', () => {
  let embeddingService: EmbeddingService

  beforeEach(() => {
    embeddingService = new EmbeddingService()
  })

  afterEach(() => {
    embeddingService.close()
  })

  describe('embedding storage integration', () => {
    it('should store and retrieve embeddings with database', () => {
      const serviceWithDb = new EmbeddingService(':memory:')

      const embedding = new Float32Array(384).fill(0.5)
      serviceWithDb.storeEmbedding('skill-1', embedding, 'Test skill description')

      const retrieved = serviceWithDb.getEmbedding('skill-1')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.length).toBe(384)

      serviceWithDb.close()
    })

    it('should get all embeddings', () => {
      const serviceWithDb = new EmbeddingService(':memory:')

      serviceWithDb.storeEmbedding('skill-1', new Float32Array(384).fill(0.1), 'Skill 1')
      serviceWithDb.storeEmbedding('skill-2', new Float32Array(384).fill(0.2), 'Skill 2')

      const all = serviceWithDb.getAllEmbeddings()
      expect(all.size).toBe(2)

      serviceWithDb.close()
    })

    it('should find similar skills', () => {
      const serviceWithDb = new EmbeddingService(':memory:')

      // Create distinct vector directions
      const v1 = new Float32Array(384)
      for (let i = 0; i < 192; i++) v1[i] = 1

      const v2 = new Float32Array(384).fill(0.5)

      const v3 = new Float32Array(384)
      for (let i = 192; i < 384; i++) v3[i] = 1

      serviceWithDb.storeEmbedding('skill-1', v1, 'Skill 1')
      serviceWithDb.storeEmbedding('skill-2', v2, 'Skill 2')
      serviceWithDb.storeEmbedding('skill-3', v3, 'Skill 3')

      const query = new Float32Array(384).fill(0.5)
      const similar = serviceWithDb.findSimilar(query, 2)

      expect(similar.length).toBe(2)
      expect(similar[0].skillId).toBe('skill-2') // Most similar (exact match)

      serviceWithDb.close()
    })
  })

  describe('cosine similarity', () => {
    it('should compute correct cosine similarity', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([1, 0, 0])
      expect(embeddingService.cosineSimilarity(a, b)).toBeCloseTo(1.0)

      const c = new Float32Array([1, 0, 0])
      const d = new Float32Array([0, 1, 0])
      expect(embeddingService.cosineSimilarity(c, d)).toBeCloseTo(0.0)
    })

    it('should throw for dimension mismatch', () => {
      const a = new Float32Array([1, 0])
      const b = new Float32Array([1, 0, 0])

      expect(() => embeddingService.cosineSimilarity(a, b)).toThrow(
        'Embeddings must have same dimension'
      )
    })

    it('should return 0 for zero vectors', () => {
      const a = new Float32Array([0, 0, 0])
      const b = new Float32Array([1, 0, 0])

      expect(embeddingService.cosineSimilarity(a, b)).toBe(0)
    })
  })
})
