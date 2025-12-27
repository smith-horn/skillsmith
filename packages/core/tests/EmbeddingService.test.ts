/**
 * SMI-627: EmbeddingService Tests
 *
 * Tests for the vector similarity search embedding service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EmbeddingService } from '../src/embeddings/index.js'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'

// Mock the transformers library for faster tests
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.1), // Mock 384-dim embedding
    })
  ),
}))

describe('EmbeddingService', () => {
  let service: EmbeddingService
  let testDbPath: string

  beforeEach(() => {
    // Create temporary database for tests
    testDbPath = path.join(process.cwd(), `.test-embeddings-${Date.now()}.db`)
    service = new EmbeddingService(testDbPath)
  })

  afterEach(() => {
    service.close()
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath)
    }
  })

  describe('constructor', () => {
    it('should create service without database path', () => {
      const memoryService = new EmbeddingService()
      expect(memoryService).toBeDefined()
    })

    it('should create service with database path', () => {
      expect(service).toBeDefined()
    })

    it('should initialize embedding table when database provided', () => {
      const db = new Database(testDbPath)
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_embeddings'")
        .all()
      db.close()

      expect(tables.length).toBe(1)
    })
  })

  describe('loadModel', () => {
    it('should load the embedding model', async () => {
      const model = await service.loadModel()
      expect(model).toBeDefined()
    })

    it('should cache the model on subsequent calls', async () => {
      const model1 = await service.loadModel()
      const model2 = await service.loadModel()
      expect(model1).toBe(model2)
    })
  })

  describe('embed', () => {
    it('should generate embedding for text', async () => {
      const embedding = await service.embed('test text')

      expect(embedding).toBeInstanceOf(Float32Array)
      expect(embedding.length).toBe(384) // all-MiniLM-L6-v2 dimension
    })

    it('should handle empty text', async () => {
      const embedding = await service.embed('')

      expect(embedding).toBeInstanceOf(Float32Array)
      expect(embedding.length).toBe(384)
    })

    it('should truncate long text', async () => {
      const longText = 'a'.repeat(2000)
      const embedding = await service.embed(longText)

      expect(embedding).toBeInstanceOf(Float32Array)
      expect(embedding.length).toBe(384)
    })
  })

  describe('embedBatch', () => {
    it('should generate embeddings for multiple texts', async () => {
      const texts = [
        { id: '1', text: 'first text' },
        { id: '2', text: 'second text' },
        { id: '3', text: 'third text' },
      ]

      const results = await service.embedBatch(texts)

      expect(results.length).toBe(3)
      results.forEach((result, index) => {
        expect(result.skillId).toBe(texts[index].id)
        expect(result.embedding).toBeInstanceOf(Float32Array)
        expect(result.embedding.length).toBe(384)
        expect(result.text).toBe(texts[index].text)
      })
    })

    it('should handle empty batch', async () => {
      const results = await service.embedBatch([])
      expect(results.length).toBe(0)
    })
  })

  describe('storeEmbedding and getEmbedding', () => {
    it('should store and retrieve embedding', () => {
      const skillId = 'test-skill-1'
      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4])
      const text = 'test skill description'

      service.storeEmbedding(skillId, embedding, text)
      const retrieved = service.getEmbedding(skillId)

      expect(retrieved).not.toBeNull()
      expect(retrieved?.length).toBe(4)
      expect(Array.from(retrieved!)).toEqual(Array.from(embedding))
    })

    it('should return null for non-existent embedding', () => {
      const retrieved = service.getEmbedding('non-existent')
      expect(retrieved).toBeNull()
    })

    it('should overwrite existing embedding', () => {
      const skillId = 'test-skill-1'
      const embedding1 = new Float32Array([0.1, 0.2, 0.3, 0.4])
      const embedding2 = new Float32Array([0.5, 0.6, 0.7, 0.8])

      service.storeEmbedding(skillId, embedding1, 'text 1')
      service.storeEmbedding(skillId, embedding2, 'text 2')

      const retrieved = service.getEmbedding(skillId)
      expect(Array.from(retrieved!)).toEqual(Array.from(embedding2))
    })
  })

  describe('getAllEmbeddings', () => {
    it('should retrieve all stored embeddings', () => {
      service.storeEmbedding('skill-1', new Float32Array([0.1, 0.2]), 'text 1')
      service.storeEmbedding('skill-2', new Float32Array([0.3, 0.4]), 'text 2')
      service.storeEmbedding('skill-3', new Float32Array([0.5, 0.6]), 'text 3')

      const all = service.getAllEmbeddings()

      expect(all.size).toBe(3)
      expect(all.has('skill-1')).toBe(true)
      expect(all.has('skill-2')).toBe(true)
      expect(all.has('skill-3')).toBe(true)
    })

    it('should return empty map when no embeddings', () => {
      const all = service.getAllEmbeddings()
      expect(all.size).toBe(0)
    })
  })

  describe('cosineSimilarity', () => {
    it('should compute similarity between identical vectors', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([1, 0, 0])

      const similarity = service.cosineSimilarity(a, b)
      expect(similarity).toBeCloseTo(1.0, 5)
    })

    it('should compute similarity between orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([0, 1, 0])

      const similarity = service.cosineSimilarity(a, b)
      expect(similarity).toBeCloseTo(0.0, 5)
    })

    it('should compute similarity between opposite vectors', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([-1, 0, 0])

      const similarity = service.cosineSimilarity(a, b)
      expect(similarity).toBeCloseTo(-1.0, 5)
    })

    it('should compute similarity for normalized vectors', () => {
      // Normalized vectors at 45 degrees
      const a = new Float32Array([1, 0])
      const b = new Float32Array([Math.SQRT1_2, Math.SQRT1_2])

      const similarity = service.cosineSimilarity(a, b)
      expect(similarity).toBeCloseTo(Math.SQRT1_2, 5)
    })

    it('should throw for vectors of different dimensions', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([1, 0])

      expect(() => service.cosineSimilarity(a, b)).toThrow('Embeddings must have same dimension')
    })

    it('should handle zero vectors', () => {
      const a = new Float32Array([0, 0, 0])
      const b = new Float32Array([1, 0, 0])

      const similarity = service.cosineSimilarity(a, b)
      expect(similarity).toBe(0)
    })
  })

  describe('findSimilar', () => {
    beforeEach(() => {
      // Store test embeddings
      service.storeEmbedding('skill-1', new Float32Array([1, 0, 0, 0]), 'skill 1')
      service.storeEmbedding('skill-2', new Float32Array([0.9, 0.1, 0, 0]), 'skill 2')
      service.storeEmbedding('skill-3', new Float32Array([0, 1, 0, 0]), 'skill 3')
      service.storeEmbedding('skill-4', new Float32Array([0, 0, 1, 0]), 'skill 4')
    })

    it('should find most similar skills', () => {
      const query = new Float32Array([1, 0, 0, 0])
      const results = service.findSimilar(query, 2)

      expect(results.length).toBe(2)
      expect(results[0].skillId).toBe('skill-1')
      expect(results[0].score).toBeCloseTo(1.0, 5)
      expect(results[1].skillId).toBe('skill-2')
    })

    it('should respect limit parameter', () => {
      const query = new Float32Array([1, 0, 0, 0])
      const results = service.findSimilar(query, 1)

      expect(results.length).toBe(1)
    })

    it('should sort by similarity score descending', () => {
      const query = new Float32Array([0.5, 0.5, 0, 0])
      const results = service.findSimilar(query, 4)

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('should return empty array when no embeddings stored', () => {
      const emptyService = new EmbeddingService()
      const query = new Float32Array([1, 0, 0, 0])
      const results = emptyService.findSimilar(query, 10)

      expect(results.length).toBe(0)
    })
  })

  describe('precomputeEmbeddings', () => {
    it('should precompute embeddings for skills', async () => {
      const skills = [
        { id: 'skill-1', name: 'TypeScript', description: 'Type-safe JavaScript' },
        { id: 'skill-2', name: 'Python', description: 'Dynamic programming language' },
      ]

      const count = await service.precomputeEmbeddings(skills)

      expect(count).toBe(2)
      expect(service.getEmbedding('skill-1')).not.toBeNull()
      expect(service.getEmbedding('skill-2')).not.toBeNull()
    })

    it('should skip already cached embeddings', async () => {
      // Pre-store one embedding
      service.storeEmbedding('skill-1', new Float32Array(384).fill(0.5), 'cached')

      const skills = [
        { id: 'skill-1', name: 'TypeScript', description: 'Type-safe JavaScript' },
        { id: 'skill-2', name: 'Python', description: 'Dynamic programming language' },
      ]

      const count = await service.precomputeEmbeddings(skills)

      expect(count).toBe(1) // Only skill-2 should be computed
    })

    it('should handle empty skills array', async () => {
      const count = await service.precomputeEmbeddings([])
      expect(count).toBe(0)
    })
  })

  describe('close', () => {
    it('should close database connection', () => {
      service.close()
      // After close, storeEmbedding silently returns (db is null check)
      // The embedding should not be stored
      service.storeEmbedding('test', new Float32Array([1]), 'text')
      const retrieved = service.getEmbedding('test')
      expect(retrieved).toBeNull()
    })
  })
})

describe('EmbeddingService Integration', () => {
  let service: EmbeddingService
  let testDbPath: string

  beforeEach(() => {
    testDbPath = path.join(process.cwd(), `.test-integration-${Date.now()}.db`)
    service = new EmbeddingService(testDbPath)
  })

  afterEach(() => {
    service.close()
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath)
    }
  })

  it('should perform end-to-end similarity search workflow', async () => {
    // 1. Precompute embeddings for skills
    const skills = [
      { id: 'ts-skill', name: 'TypeScript Helper', description: 'Helps with TypeScript code' },
      { id: 'js-skill', name: 'JavaScript Linter', description: 'Lints JavaScript files' },
      { id: 'py-skill', name: 'Python Analyzer', description: 'Analyzes Python code' },
      { id: 'rust-skill', name: 'Rust Builder', description: 'Builds Rust projects' },
    ]

    await service.precomputeEmbeddings(skills)

    // 2. Generate query embedding
    const queryEmbedding = await service.embed('typescript programming')

    // 3. Find similar skills
    const similar = service.findSimilar(queryEmbedding, 2)

    expect(similar.length).toBe(2)
    // With mock embeddings, all will have same score, but structure should be correct
    expect(similar[0]).toHaveProperty('skillId')
    expect(similar[0]).toHaveProperty('score')
  })
})
