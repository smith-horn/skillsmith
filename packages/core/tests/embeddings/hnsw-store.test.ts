/**
 * SMI-1519: HNSW Embedding Store Tests
 *
 * Tests for the hybrid HNSW + SQLite embedding storage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HNSWEmbeddingStore,
  DEFAULT_HNSW_CONFIG,
  HNSW_PRESETS,
  createHNSWStore,
  isHNSWAvailable,
} from '../../src/embeddings/hnsw-store.js'

describe('HNSWEmbeddingStore', () => {
  let store: HNSWEmbeddingStore
  let testDbPath: string

  beforeEach(() => {
    // Create unique test database path
    const testDir = join(tmpdir(), 'skillsmith-hnsw-tests')
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true })
    }
    testDbPath = join(testDir, `test-${Date.now()}.db`)
  })

  afterEach(() => {
    if (store) {
      store.close()
    }
    // Clean up test database
    if (existsSync(testDbPath)) {
      try {
        unlinkSync(testDbPath)
      } catch {
        // Ignore cleanup errors
      }
    }
  })

  describe('constructor', () => {
    it('should throw when dbPath is passed (use HNSWEmbeddingStore.create instead)', () => {
      expect(() => new HNSWEmbeddingStore({ dbPath: testDbPath })).toThrow(
        '[HNSWEmbeddingStore] Cannot open a database file in the sync constructor'
      )
    })

    it('async factory should create store with default config', async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath })
      expect(store).toBeInstanceOf(HNSWEmbeddingStore)
    })

    it('async factory should create store with custom config', async () => {
      store = await HNSWEmbeddingStore.create({
        dbPath: testDbPath,
        hnswConfig: {
          m: 32,
          efConstruction: 400,
          efSearch: 150,
          dimensions: 384,
        },
        maxElements: 50000,
      })
      expect(store).toBeInstanceOf(HNSWEmbeddingStore)
    })

    it('should use brute-force fallback when useHNSW is false', async () => {
      store = await HNSWEmbeddingStore.create({
        dbPath: testDbPath,
        useHNSW: false,
      })
      expect(store.isUsingFallback()).toBe(true)
    })
  })

  describe('storeEmbedding', () => {
    beforeEach(async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath, useHNSW: false })
    })

    it('should store embedding successfully', () => {
      const embedding = new Float32Array(384).fill(0.1)
      store.storeEmbedding('skill-1', embedding, 'Test skill description')

      const retrieved = store.getEmbedding('skill-1')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.length).toBe(384)
    })

    it('should reject embedding with wrong dimensions', () => {
      const wrongDimEmbedding = new Float32Array(768).fill(0.1)
      expect(() => {
        store.storeEmbedding('skill-1', wrongDimEmbedding, 'Test')
      }).toThrow('Embedding dimension mismatch')
    })

    it('should update existing embedding on re-store', () => {
      const embedding1 = new Float32Array(384).fill(0.1)
      const embedding2 = new Float32Array(384).fill(0.2)

      store.storeEmbedding('skill-1', embedding1, 'Original text')
      store.storeEmbedding('skill-1', embedding2, 'Updated text')

      const retrieved = store.getEmbedding('skill-1')
      expect(retrieved).not.toBeNull()
      expect(retrieved![0]).toBeCloseTo(0.2)
    })
  })

  describe('getEmbedding', () => {
    beforeEach(async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath, useHNSW: false })
    })

    it('should return null for non-existent skill', () => {
      const result = store.getEmbedding('non-existent')
      expect(result).toBeNull()
    })

    it('should return stored embedding', () => {
      const embedding = new Float32Array(384)
      for (let i = 0; i < 384; i++) {
        embedding[i] = i / 384
      }
      store.storeEmbedding('skill-1', embedding, 'Test')

      const retrieved = store.getEmbedding('skill-1')
      expect(retrieved).not.toBeNull()
      expect(retrieved![0]).toBeCloseTo(0 / 384)
      expect(retrieved![100]).toBeCloseTo(100 / 384)
    })
  })

  describe('getAllEmbeddings', () => {
    beforeEach(async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath, useHNSW: false })
    })

    it('should return empty map for empty store', () => {
      const all = store.getAllEmbeddings()
      expect(all.size).toBe(0)
    })

    it('should return all stored embeddings', () => {
      store.storeEmbedding('skill-1', new Float32Array(384).fill(0.1), 'Skill 1')
      store.storeEmbedding('skill-2', new Float32Array(384).fill(0.2), 'Skill 2')
      store.storeEmbedding('skill-3', new Float32Array(384).fill(0.3), 'Skill 3')

      const all = store.getAllEmbeddings()
      expect(all.size).toBe(3)
      expect(all.has('skill-1')).toBe(true)
      expect(all.has('skill-2')).toBe(true)
      expect(all.has('skill-3')).toBe(true)
    })
  })

  describe('findSimilar', () => {
    beforeEach(async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath, useHNSW: false })
    })

    it('should return empty array for empty store', () => {
      const query = new Float32Array(384).fill(0.1)
      const results = store.findSimilar(query, 10)
      expect(results).toEqual([])
    })

    it('should find similar embeddings (brute-force fallback)', () => {
      // Create embeddings with known similarities
      const embedding1 = new Float32Array(384).fill(0.1)
      const embedding2 = new Float32Array(384).fill(0.2)
      const embedding3 = new Float32Array(384).fill(0.9)

      store.storeEmbedding('similar-high', embedding3, 'High similarity')
      store.storeEmbedding('similar-low', embedding1, 'Low similarity')
      store.storeEmbedding('similar-mid', embedding2, 'Mid similarity')

      // Query with vector close to embedding3
      const query = new Float32Array(384).fill(0.85)
      const results = store.findSimilar(query, 3)

      expect(results.length).toBe(3)
      // Highest similarity should be first
      expect(results[0].skillId).toBe('similar-high')
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })

    it('should respect topK limit', () => {
      for (let i = 0; i < 20; i++) {
        store.storeEmbedding(`skill-${i}`, new Float32Array(384).fill(i / 20), `Skill ${i}`)
      }

      const query = new Float32Array(384).fill(0.5)
      const results = store.findSimilar(query, 5)

      expect(results.length).toBe(5)
    })

    it('should reject query with wrong dimensions', () => {
      const wrongDimQuery = new Float32Array(768).fill(0.1)
      expect(() => {
        store.findSimilar(wrongDimQuery, 10)
      }).toThrow('Query dimension mismatch')
    })
  })

  describe('cosineSimilarity', () => {
    beforeEach(async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath, useHNSW: false })
    })

    it('should return 1 for identical normalized vectors', () => {
      const v = new Float32Array(384)
      for (let i = 0; i < 384; i++) {
        v[i] = 1 / Math.sqrt(384)
      }
      const similarity = store.cosineSimilarity(v, v)
      expect(similarity).toBeCloseTo(1.0)
    })

    it('should return 0 for orthogonal vectors', () => {
      const v1 = new Float32Array(4).fill(0)
      const v2 = new Float32Array(4).fill(0)
      v1[0] = 1
      v2[1] = 1
      const similarity = store.cosineSimilarity(v1, v2)
      expect(similarity).toBeCloseTo(0)
    })

    it('should throw for dimension mismatch', () => {
      const v1 = new Float32Array(384).fill(0.1)
      const v2 = new Float32Array(768).fill(0.1)
      expect(() => store.cosineSimilarity(v1, v2)).toThrow('Embedding dimension mismatch')
    })
  })

  describe('batchInsert', () => {
    beforeEach(async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath, useHNSW: false })
    })

    it('should batch insert multiple embeddings', () => {
      const embeddings = [
        { skillId: 'batch-1', embedding: new Float32Array(384).fill(0.1), text: 'Batch 1' },
        { skillId: 'batch-2', embedding: new Float32Array(384).fill(0.2), text: 'Batch 2' },
        { skillId: 'batch-3', embedding: new Float32Array(384).fill(0.3), text: 'Batch 3' },
      ]

      const result = store.batchInsert(embeddings)

      expect(result.inserted).toBe(3)
      expect(result.updated).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      // Verify all were stored
      const all = store.getAllEmbeddings()
      expect(all.size).toBe(3)
    })

    it('should report failed insertions', () => {
      const embeddings = [
        { skillId: 'valid', embedding: new Float32Array(384).fill(0.1), text: 'Valid' },
        { skillId: 'invalid', embedding: new Float32Array(768).fill(0.1), text: 'Invalid dim' },
      ]

      const result = store.batchInsert(embeddings)

      expect(result.inserted).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.errors.length).toBe(1)
      expect(result.errors[0].skillId).toBe('invalid')
    })
  })

  describe('removeEmbedding', () => {
    beforeEach(async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath, useHNSW: false })
    })

    it('should remove existing embedding', () => {
      store.storeEmbedding('to-remove', new Float32Array(384).fill(0.1), 'To remove')
      expect(store.getEmbedding('to-remove')).not.toBeNull()

      const removed = store.removeEmbedding('to-remove')
      expect(removed).toBe(true)
      expect(store.getEmbedding('to-remove')).toBeNull()
    })

    it('should return false for non-existent embedding', () => {
      const removed = store.removeEmbedding('non-existent')
      expect(removed).toBe(false)
    })
  })

  describe('getStats', () => {
    beforeEach(async () => {
      store = await HNSWEmbeddingStore.create({ dbPath: testDbPath, useHNSW: false })
    })

    it('should return correct stats for empty store', () => {
      const stats = store.getStats()
      expect(stats.vectorCount).toBe(0)
      expect(stats.utilizationPercent).toBe(0)
      expect(stats.dimensions).toBe(384)
    })

    it('should return correct stats after insertions', () => {
      store.storeEmbedding('s1', new Float32Array(384).fill(0.1), 'S1')
      store.storeEmbedding('s2', new Float32Array(384).fill(0.2), 'S2')

      const stats = store.getStats()
      expect(stats.vectorCount).toBe(2)
      expect(stats.isHNSWEnabled).toBe(false) // useHNSW: false
    })
  })

  describe('factory functions', () => {
    it('createHNSWStore should create with preset config', async () => {
      store = await createHNSWStore('large', { dbPath: testDbPath })
      const stats = store.getStats()
      expect(stats.m).toBe(HNSW_PRESETS.large.m)
      expect(stats.efConstruction).toBe(HNSW_PRESETS.large.efConstruction)
    })
  })

  describe('isHNSWAvailable', () => {
    it('should return boolean indicating availability', async () => {
      const available = await isHNSWAvailable()
      expect(typeof available).toBe('boolean')
    })
  })

  describe('DEFAULT_HNSW_CONFIG', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_HNSW_CONFIG.m).toBe(16)
      expect(DEFAULT_HNSW_CONFIG.efConstruction).toBe(200)
      expect(DEFAULT_HNSW_CONFIG.efSearch).toBe(100)
      expect(DEFAULT_HNSW_CONFIG.dimensions).toBe(384)
    })
  })

  describe('HNSW_PRESETS', () => {
    it('should have all expected presets', () => {
      expect(HNSW_PRESETS).toHaveProperty('small')
      expect(HNSW_PRESETS).toHaveProperty('medium')
      expect(HNSW_PRESETS).toHaveProperty('large')
      expect(HNSW_PRESETS).toHaveProperty('xlarge')
    })

    it('should have increasing M values across presets', () => {
      expect(HNSW_PRESETS.small.m).toBeLessThan(HNSW_PRESETS.medium.m)
      expect(HNSW_PRESETS.medium.m).toBeLessThan(HNSW_PRESETS.large.m)
      expect(HNSW_PRESETS.large.m).toBeLessThan(HNSW_PRESETS.xlarge.m)
    })
  })
})
