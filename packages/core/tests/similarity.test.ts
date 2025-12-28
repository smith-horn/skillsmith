/**
 * SMI-659: Similarity Utilities Tests
 * TDD London School - Test shared similarity functions
 */

import { describe, it, expect } from 'vitest'
import {
  cosineSimilarity,
  euclideanDistance,
  dotProduct,
  vectorNorm,
  normalize,
} from '../src/embeddings/similarity.js'

describe('Similarity Utilities', () => {
  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const v = new Float32Array([1, 2, 3, 4])
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10)
    })

    it('should return -1 for opposite vectors', () => {
      const v1 = new Float32Array([1, 2, 3, 4])
      const v2 = new Float32Array([-1, -2, -3, -4])
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(-1.0, 10)
    })

    it('should return 0 for orthogonal vectors', () => {
      const v1 = new Float32Array([1, 0, 0])
      const v2 = new Float32Array([0, 1, 0])
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(0, 10)
    })

    it('should return 0 for zero vectors', () => {
      const zero = new Float32Array([0, 0, 0])
      const v = new Float32Array([1, 2, 3])
      expect(cosineSimilarity(zero, v)).toBe(0)
      expect(cosineSimilarity(v, zero)).toBe(0)
    })

    it('should throw for different dimensions', () => {
      const v1 = new Float32Array([1, 2, 3])
      const v2 = new Float32Array([1, 2])
      expect(() => cosineSimilarity(v1, v2)).toThrow(/dimension/i)
    })

    it('should be symmetric', () => {
      const v1 = new Float32Array([1, 2, 3, 4])
      const v2 = new Float32Array([5, 6, 7, 8])
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(cosineSimilarity(v2, v1), 10)
    })
  })

  describe('euclideanDistance', () => {
    it('should return 0 for identical vectors', () => {
      const v = new Float32Array([1, 2, 3])
      expect(euclideanDistance(v, v)).toBe(0)
    })

    it('should compute correct distance', () => {
      const v1 = new Float32Array([0, 0])
      const v2 = new Float32Array([3, 4])
      expect(euclideanDistance(v1, v2)).toBeCloseTo(5, 10) // 3-4-5 triangle
    })

    it('should throw for different dimensions', () => {
      const v1 = new Float32Array([1, 2, 3])
      const v2 = new Float32Array([1, 2])
      expect(() => euclideanDistance(v1, v2)).toThrow(/dimension/i)
    })

    it('should be symmetric', () => {
      const v1 = new Float32Array([1, 2, 3])
      const v2 = new Float32Array([4, 5, 6])
      expect(euclideanDistance(v1, v2)).toBeCloseTo(euclideanDistance(v2, v1), 10)
    })
  })

  describe('dotProduct', () => {
    it('should compute correct dot product', () => {
      const v1 = new Float32Array([1, 2, 3])
      const v2 = new Float32Array([4, 5, 6])
      expect(dotProduct(v1, v2)).toBe(1 * 4 + 2 * 5 + 3 * 6) // 32
    })

    it('should return 0 for orthogonal vectors', () => {
      const v1 = new Float32Array([1, 0, 0])
      const v2 = new Float32Array([0, 1, 0])
      expect(dotProduct(v1, v2)).toBe(0)
    })

    it('should throw for different dimensions', () => {
      const v1 = new Float32Array([1, 2, 3])
      const v2 = new Float32Array([1, 2])
      expect(() => dotProduct(v1, v2)).toThrow(/dimension/i)
    })
  })

  describe('vectorNorm', () => {
    it('should compute correct L2 norm', () => {
      const v = new Float32Array([3, 4])
      expect(vectorNorm(v)).toBeCloseTo(5, 10) // 3-4-5 triangle
    })

    it('should return 0 for zero vector', () => {
      const v = new Float32Array([0, 0, 0])
      expect(vectorNorm(v)).toBe(0)
    })

    it('should return 1 for unit vectors', () => {
      const v = new Float32Array([1, 0, 0])
      expect(vectorNorm(v)).toBeCloseTo(1, 10)
    })
  })

  describe('normalize', () => {
    it('should produce unit vector', () => {
      const v = new Float32Array([3, 4])
      const n = normalize(v)
      // Float32 has limited precision, use 5 decimal places
      expect(vectorNorm(n)).toBeCloseTo(1, 5)
    })

    it('should preserve direction', () => {
      const v = new Float32Array([3, 4])
      const n = normalize(v)
      // Float32 has limited precision, use 5 decimal places
      expect(n[0] / n[1]).toBeCloseTo(v[0] / v[1], 5)
    })

    it('should return zero vector for zero input', () => {
      const v = new Float32Array([0, 0, 0])
      const n = normalize(v)
      expect(n[0]).toBe(0)
      expect(n[1]).toBe(0)
      expect(n[2]).toBe(0)
    })

    it('should not modify original vector', () => {
      const v = new Float32Array([3, 4])
      const original0 = v[0]
      const original1 = v[1]
      normalize(v)
      expect(v[0]).toBe(original0)
      expect(v[1]).toBe(original1)
    })
  })
})
