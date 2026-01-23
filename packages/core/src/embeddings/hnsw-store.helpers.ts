/**
 * HNSW Embedding Store Helper Functions
 * @module @skillsmith/core/embeddings/hnsw-store.helpers
 */

import type { HierarchicalNSWConstructor, HNSWEmbeddingStoreOptions } from './hnsw-store.types.js'
import { HNSW_PRESETS } from './hnsw-store.types.js'
import { HNSWEmbeddingStore } from './hnsw-store.js'

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
 * Useful for conditional logic or graceful degradation.
 *
 * @returns true if hnswlib-node can be loaded
 */
export async function isHNSWAvailable(): Promise<boolean> {
  try {
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
    const mod = await (Function('return import("hnswlib-node")')() as Promise<{
      HierarchicalNSW: HierarchicalNSWConstructor
    }>)
    return mod
  } catch {
    return null
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute cosine similarity between two embeddings.
 * Standalone version for use outside of HNSWEmbeddingStore.
 *
 * @param a - First embedding
 * @param b - Second embedding
 * @returns Similarity score between -1 and 1
 */
export function computeCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`)
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
 * Convert HNSW distance to similarity score.
 * HNSW returns distances, we need similarities (higher = more similar).
 *
 * @param distance - Distance value from HNSW
 * @param metric - Distance metric used
 * @returns Similarity score
 */
export function distanceToSimilarity(
  distance: number,
  metric: 'cosine' | 'l2' | 'ip' = 'cosine'
): number {
  if (metric === 'cosine') {
    // For cosine space, HNSW returns 1 - cosine_similarity
    return 1 - distance
  }
  // For L2/IP, need different conversion
  return 1 / (1 + distance)
}

/**
 * Estimate memory usage for an HNSW index.
 *
 * @param vectorCount - Number of vectors
 * @param dimensions - Vector dimensionality
 * @param m - HNSW M parameter
 * @returns Estimated memory usage in bytes
 */
export function estimateMemoryUsage(vectorCount: number, dimensions: number, m: number): number {
  // HNSW uses ~(4 * dimensions + M * 4 * 2) bytes per vector
  const bytesPerVector = 4 * dimensions + m * 8
  return vectorCount * bytesPerVector
}

/**
 * Validate embedding dimensions.
 *
 * @param embedding - Embedding to validate
 * @param expectedDimensions - Expected dimension count
 * @param context - Context for error message (default: 'Query')
 * @throws Error if dimensions don't match
 */
export function validateDimensions(
  embedding: Float32Array,
  expectedDimensions: number,
  context: string = 'Query'
): void {
  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `${context} dimension mismatch: got ${embedding.length}, expected ${expectedDimensions}`
    )
  }
}

/**
 * Determine whether to use HNSW based on explicit option or environment.
 *
 * @param explicit - Explicit useHNSW option (if provided)
 * @returns Whether to enable HNSW
 */
export function shouldUseHNSW(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit
  }

  const envValue = process.env.SKILLSMITH_USE_HNSW
  if (envValue !== undefined) {
    return envValue === 'true' || envValue === '1'
  }

  // Default to false for backward compatibility
  return false
}
