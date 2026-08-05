/**
 * SMI-754: EmbeddingService Tests
 * Tests for fallback mode and deterministic mock embeddings
 *
 * @see ADR-009: Embedding Service Fallback Strategy
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  EmbeddingService,
  testUtils,
  type EmbeddingServiceOptions,
} from '../src/embeddings/index.js'

// SMI-5897 (C-18/C-19): force loadModel()'s catch-block path (real
// transformers-module load failure) without depending on whether
// @huggingface/transformers is actually installed/reachable in CI.
vi.mock('../src/embeddings/embedding-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings/embedding-utils.js')>()
  return {
    ...actual,
    loadTransformersModule: vi.fn().mockResolvedValue(null),
  }
})

describe('EmbeddingService', () => {
  describe('constructor', () => {
    it('should throw when dbPath is passed as string (use EmbeddingService.create instead)', () => {
      expect(() => new EmbeddingService(':memory:')).toThrow(
        '[EmbeddingService] Cannot open a database file in the sync constructor'
      )
    })

    it('should throw when dbPath is passed in options (use EmbeddingService.create instead)', () => {
      const options: EmbeddingServiceOptions = {
        dbPath: ':memory:',
        useFallback: true,
      }
      expect(() => new EmbeddingService(options)).toThrow(
        '[EmbeddingService] Cannot open a database file in the sync constructor'
      )
    })

    it('should work without any arguments', () => {
      const service = new EmbeddingService()
      expect(service).toBeInstanceOf(EmbeddingService)
    })

    it('async factory should create instance with DB (EmbeddingService.create)', async () => {
      const service = await EmbeddingService.create({ dbPath: ':memory:', useFallback: true })
      expect(service).toBeInstanceOf(EmbeddingService)
      service.close()
    })
  })

  describe('fallback mode', () => {
    let service: EmbeddingService

    beforeEach(() => {
      service = new EmbeddingService({ useFallback: true })
    })

    afterEach(() => {
      service.close()
    })

    it('should report using fallback mode', () => {
      expect(service.isUsingFallback()).toBe(true)
    })

    it('should generate embeddings without loading model', async () => {
      const embedding = await service.embed('test text')
      expect(embedding).toBeInstanceOf(Float32Array)
      expect(embedding.length).toBe(384) // Default dimension
    })

    it('should generate deterministic embeddings', async () => {
      const text = 'hello world'
      const embedding1 = await service.embed(text)
      const embedding2 = await service.embed(text)

      // Same text should produce identical embeddings
      expect(embedding1).toEqual(embedding2)
    })

    it('should generate different embeddings for different text', async () => {
      const embedding1 = await service.embed('hello world')
      const embedding2 = await service.embed('goodbye world')

      // Different text should produce different embeddings
      expect(embedding1).not.toEqual(embedding2)
    })

    it('should generate normalized embeddings', async () => {
      const embedding = await service.embed('test normalization')

      // Calculate norm
      let norm = 0
      for (let i = 0; i < embedding.length; i++) {
        norm += embedding[i] * embedding[i]
      }
      norm = Math.sqrt(norm)

      // Should be approximately 1 (normalized)
      expect(norm).toBeCloseTo(1, 5)
    })

    it('should handle batch embedding efficiently', async () => {
      const texts = [
        { id: '1', text: 'first skill' },
        { id: '2', text: 'second skill' },
        { id: '3', text: 'third skill' },
      ]

      const results = await service.embedBatch(texts)

      expect(results).toHaveLength(3)
      expect(results[0].skillId).toBe('1')
      expect(results[1].skillId).toBe('2')
      expect(results[2].skillId).toBe('3')

      // Each should have proper embedding
      for (const result of results) {
        expect(result.embedding).toBeInstanceOf(Float32Array)
        expect(result.embedding.length).toBe(384)
      }
    })

    it('should truncate long text', async () => {
      const longText = 'a'.repeat(2000)
      const embedding = await service.embed(longText)

      // Should not throw and should produce valid embedding
      expect(embedding).toBeInstanceOf(Float32Array)
      expect(embedding.length).toBe(384)
    })
  })

  describe('environment variable control', () => {
    const originalEnv = process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS
      } else {
        process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = originalEnv
      }
    })

    it('should use fallback when env var is "true"', () => {
      process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'true'
      const service = new EmbeddingService()
      expect(service.isUsingFallback()).toBe(true)
    })

    it('should use fallback when env var is "1"', () => {
      process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = '1'
      const service = new EmbeddingService()
      expect(service.isUsingFallback()).toBe(true)
    })

    it('should not use fallback when env var is "false"', () => {
      process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'false'
      const service = new EmbeddingService()
      expect(service.isUsingFallback()).toBe(false)
    })

    it('should prefer explicit option over env var', () => {
      process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'true'
      const service = new EmbeddingService({ useFallback: false })
      expect(service.isUsingFallback()).toBe(false)
    })
  })

  describe('cosine similarity', () => {
    let service: EmbeddingService

    beforeEach(() => {
      service = new EmbeddingService({ useFallback: true })
    })

    afterEach(() => {
      service.close()
    })

    it('should compute similarity between identical embeddings', async () => {
      const embedding = await service.embed('test')
      const similarity = service.cosineSimilarity(embedding, embedding)
      expect(similarity).toBeCloseTo(1, 5)
    })

    it('should compute lower similarity for different embeddings', async () => {
      const embedding1 = await service.embed('cats are great pets')
      const embedding2 = await service.embed('quantum physics equations')
      const similarity = service.cosineSimilarity(embedding1, embedding2)

      // Should be less than 1 but still positive (vectors have similar structure)
      expect(similarity).toBeLessThan(1)
      expect(similarity).toBeGreaterThan(-1)
    })

    it('should throw for mismatched dimensions', async () => {
      const a = new Float32Array([1, 2, 3])
      const b = new Float32Array([1, 2])

      expect(() => service.cosineSimilarity(a, b)).toThrow('Embeddings must have same dimension')
    })

    it('should return 0 for zero vectors', () => {
      const zero = new Float32Array(384)
      const nonZero = new Float32Array(384).fill(1)

      expect(service.cosineSimilarity(zero, nonZero)).toBe(0)
      expect(service.cosineSimilarity(nonZero, zero)).toBe(0)
    })
  })

  describe('database caching', () => {
    let service: EmbeddingService

    beforeEach(async () => {
      service = await EmbeddingService.create({ dbPath: ':memory:', useFallback: true })
    })

    afterEach(() => {
      service.close()
    })

    it('should store and retrieve embeddings', async () => {
      const embedding = await service.embed('test skill')
      service.storeEmbedding('skill-1', embedding, 'test skill')

      const retrieved = service.getEmbedding('skill-1')
      expect(retrieved).not.toBeNull()
      expect(retrieved).toEqual(embedding)
    })

    it('should return null for non-existent embeddings', () => {
      const retrieved = service.getEmbedding('non-existent')
      expect(retrieved).toBeNull()
    })

    it('should get all embeddings', async () => {
      const embedding1 = await service.embed('skill one')
      const embedding2 = await service.embed('skill two')

      service.storeEmbedding('skill-1', embedding1, 'skill one')
      service.storeEmbedding('skill-2', embedding2, 'skill two')

      const all = service.getAllEmbeddings()
      expect(all.size).toBe(2)
      expect(all.has('skill-1')).toBe(true)
      expect(all.has('skill-2')).toBe(true)
    })

    it('should find similar skills', async () => {
      // Store some skills
      const skills = [
        { id: 'git-1', text: 'git workflow automation' },
        { id: 'git-2', text: 'git commit helper' },
        { id: 'docker-1', text: 'docker container management' },
      ]

      for (const skill of skills) {
        const embedding = await service.embed(skill.text)
        service.storeEmbedding(skill.id, embedding, skill.text)
      }

      // Query for git-related
      const queryEmbedding = await service.embed('git version control')
      const similar = await service.findSimilar(queryEmbedding, 2)

      expect(similar.length).toBe(2)
      // Git-related skills should have higher scores
      expect(similar.every((s) => s.score > 0)).toBe(true)
    })

    it('should precompute embeddings for skills', async () => {
      const skills = [
        { id: '1', name: 'Skill One', description: 'First skill' },
        { id: '2', name: 'Skill Two', description: 'Second skill' },
      ]

      const count = await service.precomputeEmbeddings(skills)
      expect(count).toBe(2)

      // Should be cached now
      const embedding1 = service.getEmbedding('1')
      const embedding2 = service.getEmbedding('2')
      expect(embedding1).not.toBeNull()
      expect(embedding2).not.toBeNull()

      // Running again should skip existing
      const count2 = await service.precomputeEmbeddings(skills)
      expect(count2).toBe(0)
    })
  })

  describe('testUtils exports', () => {
    it('should export generateMockEmbedding', () => {
      expect(testUtils.generateMockEmbedding).toBeDefined()
      const embedding = testUtils.generateMockEmbedding('test', 384)
      expect(embedding).toBeInstanceOf(Float32Array)
      expect(embedding.length).toBe(384)
    })

    it('should export hashText', () => {
      expect(testUtils.hashText).toBeDefined()
      const hash1 = testUtils.hashText('hello')
      const hash2 = testUtils.hashText('hello')
      expect(hash1).toBe(hash2)
    })

    it('should generate deterministic mock embeddings', () => {
      const embedding1 = testUtils.generateMockEmbedding('test', 384)
      const embedding2 = testUtils.generateMockEmbedding('test', 384)
      expect(embedding1).toEqual(embedding2)
    })
  })

  describe('loadModel in fallback mode', () => {
    it('should return null when in fallback mode', async () => {
      const service = new EmbeddingService({ useFallback: true })
      const model = await service.loadModel()
      expect(model).toBeNull()
    })
  })

  describe('loadModel failure warning (SMI-5897 C-18/C-19)', () => {
    // SMI-5897: loadModel()'s catch block was a second, unguarded console.warn
    // path — it printed unconditionally even when probeEmbeddingCapability()'s
    // own SKILLSMITH_QUIET guard would have suppressed the equivalent boot-time
    // warning. loadTransformersModule() is mocked (module-level, top of file)
    // to resolve null so the catch path fires deterministically without
    // depending on whether @huggingface/transformers is actually reachable.
    //
    // SMI-5897 (Wave 4 fix): each `it()` below previously called
    // `warnSpy.mockRestore()` as its last statement — if an `expect()`
    // earlier in the same test threw, that restore never ran, leaking the
    // `console.warn` spy into later tests in this file (which already has a
    // module-level `vi.mock` — see top of file). `vi.restoreAllMocks()` in
    // this shared `afterEach` only restores spies created via `vi.spyOn`
    // (per Vitest's own contract); it does not touch the module-level
    // `loadTransformersModule` mock above, which is a plain `vi.fn()`, not a
    // spy on an existing object.
    afterEach(() => {
      delete process.env['SKILLSMITH_QUIET']
      vi.restoreAllMocks()
    })

    it('warns via console.warn when the model fails to load and SKILLSMITH_QUIET is unset', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const service = new EmbeddingService({ useFallback: false })

      const model = await service.loadModel()

      expect(model).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toContain('Failed to load model')
    })

    it('suppresses the console.warn when SKILLSMITH_QUIET=true', async () => {
      process.env['SKILLSMITH_QUIET'] = 'true'
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const service = new EmbeddingService({ useFallback: false })

      const model = await service.loadModel()

      expect(model).toBeNull()
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('still marks modelLoadFailed (fallback engages) even when the warning is suppressed', async () => {
      process.env['SKILLSMITH_QUIET'] = 'true'
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const service = new EmbeddingService({ useFallback: false })

      await service.loadModel()
      // isUsingFallback() is true once modelLoadFailed is set, regardless of
      // whether the warning was printed — suppression must be display-only.
      expect(service.isUsingFallback()).toBe(true)
    })
  })
})
