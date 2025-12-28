/**
 * SMI-656: VectorStore Security Tests
 * TDD London School - Test SQL Injection Prevention
 *
 * These tests verify that VectorStore properly validates table names
 * to prevent SQL injection attacks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { VectorStore } from '../src/embeddings/VectorStore.js'

describe('VectorStore Security', () => {
  let store: VectorStore | null = null

  afterEach(() => {
    if (store) {
      store.close()
      store = null
    }
  })

  describe('SQL Injection Prevention (SMI-656)', () => {
    it('should reject table names with SQL injection patterns', () => {
      const maliciousNames = [
        'embeddings; DROP TABLE users; --',
        "embeddings'; DELETE FROM skills; --",
        'embeddings`; DROP DATABASE;`',
        '../../../etc/passwd',
        'embeddings\x00malicious',
        'table--comment',
        'table/*comment*/',
        'table;',
        "table'",
        'table"',
        'table`',
      ]

      for (const name of maliciousNames) {
        expect(
          () => new VectorStore({ tableName: name }),
          `Should reject malicious table name: "${name}"`
        ).toThrow(/invalid table name/i)
      }
    })

    it('should accept valid table names', () => {
      const validNames = [
        'embeddings',
        'skill_vectors',
        'vector_store_2024',
        '_private_table',
        'VectorCache',
        'my_embeddings_v2',
      ]

      for (const name of validNames) {
        const testStore = new VectorStore({ tableName: name })
        expect(testStore).toBeDefined()
        testStore.close()
      }
    })

    it('should reject empty or whitespace table names', () => {
      expect(() => new VectorStore({ tableName: '' })).toThrow(/cannot be empty/i)
      expect(() => new VectorStore({ tableName: '   ' })).toThrow(/cannot be empty/i)
      expect(() => new VectorStore({ tableName: '\t\n' })).toThrow(/cannot be empty/i)
    })

    it('should reject table names that do not start with letter or underscore', () => {
      const invalidStarts = ['123table', '-table', '.table', '0_vectors']

      for (const name of invalidStarts) {
        expect(
          () => new VectorStore({ tableName: name }),
          `Should reject table name starting with invalid char: "${name}"`
        ).toThrow(/invalid table name/i)
      }
    })

    it('should reject excessively long table names', () => {
      const longName = 'a'.repeat(100)
      expect(() => new VectorStore({ tableName: longName })).toThrow(/too long/i)
    })

    it('should reject table names with special characters', () => {
      const specialCharNames = [
        'table-name',
        'table.name',
        'table@name',
        'table#name',
        'table$name',
        'table%name',
        'table^name',
        'table&name',
        'table*name',
        'table(name',
        'table)name',
        'table+name',
        'table=name',
        'table[name',
        'table]name',
        'table{name',
        'table}name',
        'table|name',
        'table\\name',
        'table/name',
        'table?name',
        'table<name',
        'table>name',
        'table,name',
        'table:name',
        'table name',
      ]

      for (const name of specialCharNames) {
        expect(
          () => new VectorStore({ tableName: name }),
          `Should reject table name with special char: "${name}"`
        ).toThrow(/invalid table name/i)
      }
    })

    it('should use default table name when none provided', () => {
      store = new VectorStore()
      const stats = store.getStats()
      expect(stats.tableName).toBe('vectors')
    })
  })

  describe('Parameterized Query Safety', () => {
    beforeEach(() => {
      store = new VectorStore({ tableName: 'test_vectors' })
    })

    it('should safely handle special characters in vector IDs', () => {
      const maliciousIds = [
        "id'; DROP TABLE test_vectors; --",
        'id" OR 1=1',
        'id`; DELETE FROM test_vectors;`',
        '<script>alert("xss")</script>',
      ]

      const embedding = new Float32Array(384).fill(0.1)

      for (const id of maliciousIds) {
        // Should not throw - IDs are parameterized
        expect(() => store!.store(id, embedding)).not.toThrow()

        // Should be retrievable with the exact ID
        const retrieved = store!.get(id)
        expect(retrieved).not.toBeNull()
        expect(retrieved!.id).toBe(id)
      }
    })

    it('should safely handle special characters in metadata', () => {
      const embedding = new Float32Array(384).fill(0.1)
      const maliciousMetadata = {
        name: "'; DROP TABLE test_vectors; --",
        description: '" OR 1=1',
        script: '<script>alert("xss")</script>',
      }

      store!.store('safe-id', embedding, maliciousMetadata)

      const retrieved = store!.get('safe-id')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.metadata).toEqual(maliciousMetadata)
    })
  })

  describe('Input Validation', () => {
    beforeEach(() => {
      store = new VectorStore({ tableName: 'validation_test' })
    })

    it('should validate embedding dimension', () => {
      const wrongDimensionEmbedding = new Float32Array(100).fill(0.1)

      expect(() => store!.store('test-id', wrongDimensionEmbedding)).toThrow(/dimension mismatch/i)
    })

    it('should validate query embedding dimension in findSimilar', () => {
      const wrongDimensionQuery = new Float32Array(100).fill(0.1)

      expect(() => store!.findSimilar(wrongDimensionQuery)).toThrow(/dimension mismatch/i)
    })

    it('should handle empty candidate list in findSimilarInSet', () => {
      const queryEmbedding = new Float32Array(384).fill(0.1)
      const results = store!.findSimilarInSet(queryEmbedding, [], 10)

      expect(results).toEqual([])
    })

    it('should handle negative topK gracefully', () => {
      const embedding = new Float32Array(384).fill(0.1)
      store!.store('test-id', embedding)

      const results = store!.findSimilar(embedding, -1)
      expect(results).toEqual([])
    })

    it('should handle zero topK gracefully', () => {
      const embedding = new Float32Array(384).fill(0.1)
      store!.store('test-id', embedding)

      const results = store!.findSimilar(embedding, 0)
      expect(results).toEqual([])
    })
  })

  describe('Error Handling (SMI-657)', () => {
    beforeEach(() => {
      store = new VectorStore({ tableName: 'error_test' })
    })

    it('should return batch result with failed entries instead of swallowing errors', () => {
      const validEmbedding = new Float32Array(384).fill(0.1)
      const invalidEmbedding = new Float32Array(100).fill(0.1) // Wrong dimension

      const entries = [
        { id: 'valid-1', embedding: validEmbedding },
        { id: 'invalid-1', embedding: invalidEmbedding },
        { id: 'valid-2', embedding: validEmbedding },
        { id: 'invalid-2', embedding: invalidEmbedding },
      ]

      const result = store!.storeBatchWithResult(entries)

      expect(result.successCount).toBe(2)
      expect(result.failedEntries).toHaveLength(2)
      expect(result.failedEntries[0].id).toBe('invalid-1')
      expect(result.failedEntries[0].reason).toMatch(/dimension mismatch/i)
      expect(result.failedEntries[1].id).toBe('invalid-2')
    })

    it('should throw in strict mode when batch has failures', () => {
      const validEmbedding = new Float32Array(384).fill(0.1)
      const invalidEmbedding = new Float32Array(100).fill(0.1)

      const entries = [
        { id: 'valid-1', embedding: validEmbedding },
        { id: 'invalid-1', embedding: invalidEmbedding },
      ]

      expect(() => store!.storeBatchStrict(entries)).toThrow(/batch store failed/i)
    })

    it('should preserve original storeBatch for backwards compatibility', () => {
      const validEmbedding = new Float32Array(384).fill(0.1)
      const invalidEmbedding = new Float32Array(100).fill(0.1)

      const entries = [
        { id: 'valid-1', embedding: validEmbedding },
        { id: 'invalid-1', embedding: invalidEmbedding },
        { id: 'valid-2', embedding: validEmbedding },
      ]

      // Original storeBatch still returns just the count for backwards compatibility
      const count = store!.storeBatch(entries)
      expect(count).toBe(2)
    })
  })

  describe('Hybrid Search Edge Cases (SMI-658)', () => {
    beforeEach(() => {
      store = new VectorStore({ tableName: 'search_test' })
    })

    it('should return empty results when store is empty', () => {
      const query = new Float32Array(384).fill(0.1)
      const results = store!.findSimilar(query)

      expect(results).toEqual([])
    })

    it('should handle minScore filtering correctly', () => {
      // Create vectors with known similarity scores
      const baseVector = new Float32Array(384).fill(0.5)
      const similarVector = new Float32Array(384).fill(0.5) // identical = score 1.0

      // Create an orthogonal-ish vector (alternate positive/negative)
      const differentVector = new Float32Array(384)
      for (let i = 0; i < 384; i++) {
        differentVector[i] = i % 2 === 0 ? 0.5 : -0.5
      }

      store!.store('similar', similarVector)
      store!.store('different', differentVector)

      // With high minScore, should filter out low-scoring results
      const highScoreResults = store!.findSimilar(baseVector, 10, 0.9)
      expect(highScoreResults.length).toBe(1)
      expect(highScoreResults[0].id).toBe('similar')
      expect(highScoreResults[0].score).toBeCloseTo(1.0, 5)
    })

    it('should handle minScore = 1.0 requiring exact matches', () => {
      const vector1 = new Float32Array(384).fill(0.5)

      // Create a different direction vector
      const vector2 = new Float32Array(384)
      for (let i = 0; i < 384; i++) {
        vector2[i] = i % 2 === 0 ? 0.7 : 0.3
      }

      store!.store('exact', vector1)
      store!.store('close', vector2)

      // Only exact match should pass minScore = 1.0
      const results = store!.findSimilar(vector1, 10, 1.0)
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('exact')
    })

    it('should correctly handle zero vectors', () => {
      const zeroVector = new Float32Array(384).fill(0)
      const nonZeroVector = new Float32Array(384).fill(0.5)

      store!.store('zero', zeroVector)
      store!.store('nonzero', nonZeroVector)

      // Cosine similarity with zero vector should be 0
      const results = store!.findSimilar(zeroVector)
      expect(results.every((r) => r.score === 0)).toBe(true)
    })

    it('should handle topK larger than available vectors', () => {
      const vector = new Float32Array(384).fill(0.5)
      store!.store('only-one', vector)

      const results = store!.findSimilar(vector, 100)
      expect(results.length).toBe(1)
    })

    it('should sort results by score descending', () => {
      const query = new Float32Array(384)
      query.fill(1.0)

      // Create vectors with progressively different scores
      for (let i = 0; i < 5; i++) {
        const v = new Float32Array(384)
        v.fill(1.0 - i * 0.1)
        store!.store(`vec-${i}`, v)
      }

      const results = store!.findSimilar(query, 5)
      expect(results.length).toBe(5)

      // Verify descending order
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score)
      }
    })

    it('should handle findSimilarInSet with non-existent IDs', () => {
      const vector = new Float32Array(384).fill(0.5)
      store!.store('exists', vector)

      const results = store!.findSimilarInSet(vector, ['not-exists-1', 'not-exists-2'])
      expect(results).toEqual([])
    })

    it('should handle findSimilarInSet with mixed existing and non-existing IDs', () => {
      const vector = new Float32Array(384).fill(0.5)
      store!.store('exists', vector)

      const results = store!.findSimilarInSet(vector, ['exists', 'not-exists'])
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('exists')
    })

    it('should include metadata in findSimilar results', () => {
      const vector = new Float32Array(384).fill(0.5)
      store!.store('with-meta', vector, { name: 'test', count: 42 })

      const results = store!.findSimilar(vector, 10)
      expect(results.length).toBe(1)
      expect(results[0].metadata).toEqual({ name: 'test', count: 42 })
    })

    it('should handle negative minScore gracefully', () => {
      const vector = new Float32Array(384).fill(0.5)
      store!.store('test', vector)

      // Negative minScore should still work (include all results with score >= -0.5)
      const results = store!.findSimilar(vector, 10, -0.5)
      expect(results.length).toBeGreaterThanOrEqual(1)
    })
  })
})
