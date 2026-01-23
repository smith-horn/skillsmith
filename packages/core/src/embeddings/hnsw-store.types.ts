/**
 * HNSW Embedding Store Type Definitions
 * @module @skillsmith/core/embeddings/hnsw-store.types
 */

// ============================================================================
// hnswlib-node Type Declarations
// ============================================================================

/**
 * Type definitions for hnswlib-node (not published on DefinitelyTyped)
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

/** Result from HNSW k-nearest neighbor search */
export interface HNSWSearchResult {
  neighbors: number[]
  distances: number[]
}

/** Constructor type for HierarchicalNSW */
export interface HierarchicalNSWConstructor {
  new (space: 'cosine' | 'l2' | 'ip', dim: number): HierarchicalNSW
}

// ============================================================================
// HNSW Configuration Types
// ============================================================================

/**
 * HNSW algorithm parameters for tuning search quality vs speed.
 * @see https://github.com/nmslib/hnswlib/blob/master/ALGO_PARAMS.md
 */
export interface HNSWConfig {
  /**
   * Number of bidirectional links per node (M parameter).
   * - 8-16: Fast, lower memory, suitable for <100k vectors
   * - 16-32: Balanced, good for 100k-1M vectors
   * - 32-64: High recall, suitable for >1M vectors
   * @default 16
   */
  m: number

  /**
   * Size of dynamic candidate list during index construction.
   * - 100-200: Fast builds, acceptable quality
   * - 200-400: Balanced
   * - 400-500: High quality, slower builds
   * @default 200
   */
  efConstruction: number

  /**
   * Size of dynamic candidate list during search.
   * - 10-50: Fast search, may miss some neighbors
   * - 50-100: Balanced
   * - 100-200: High recall, slower search
   * @default 100
   */
  efSearch: number

  /**
   * Vector dimensionality. Must match embedding model output.
   * @default 384 (all-MiniLM-L6-v2)
   */
  dimensions: number
}

/** Options for HNSWEmbeddingStore initialization */
export interface HNSWEmbeddingStoreOptions {
  /** Path to SQLite database for metadata storage */
  dbPath?: string
  /** Path to HNSW index file for persistence */
  indexPath?: string
  /** HNSW algorithm configuration */
  hnswConfig?: Partial<HNSWConfig>
  /** Maximum number of elements (default: 100000) */
  maxElements?: number
  /** Distance metric (default: 'cosine') */
  distanceMetric?: 'cosine' | 'l2' | 'ip'
  /** Force HNSW mode (undefined = auto-detect from SKILLSMITH_USE_HNSW env) */
  useHNSW?: boolean
  /** Auto-save index after each insert (default: false) */
  autoSave?: boolean
}

/** Statistics about the HNSW index */
export interface HNSWIndexStats {
  vectorCount: number
  maxCapacity: number
  utilizationPercent: number
  m: number
  efConstruction: number
  efSearch: number
  dimensions: number
  memoryUsageBytes: number
  isHNSWEnabled: boolean
  indexPath?: string
}

/** Result of a batch insert operation */
export interface BatchInsertResult {
  inserted: number
  updated: number
  failed: number
  errors: Array<{ skillId: string; error: string }>
  durationMs: number
}

// ============================================================================
// Interface Definition
// ============================================================================

import type { SimilarityResult } from './index.js'

/**
 * Interface for embedding storage with similarity search.
 * Implemented by both HNSWEmbeddingStore and EmbeddingService.
 */
export interface IEmbeddingStore {
  storeEmbedding(skillId: string, embedding: Float32Array, text: string): void
  getEmbedding(skillId: string): Float32Array | null
  getAllEmbeddings(): Map<string, Float32Array>
  findSimilar(queryEmbedding: Float32Array, topK?: number): SimilarityResult[]
  cosineSimilarity(a: Float32Array, b: Float32Array): number
  isUsingFallback(): boolean
  close(): void
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Default HNSW configuration optimized for skill embeddings (~10k-100k skills) */
export const DEFAULT_HNSW_CONFIG: HNSWConfig = {
  m: 16,
  efConstruction: 200,
  efSearch: 100,
  dimensions: 384,
}

/** HNSW configuration presets for different use cases */
export const HNSW_PRESETS = {
  /** Fast search, lower memory, suitable for <10k vectors */
  small: { m: 8, efConstruction: 100, efSearch: 50, dimensions: 384 } satisfies HNSWConfig,
  /** Balanced performance, suitable for 10k-100k vectors */
  medium: { m: 16, efConstruction: 200, efSearch: 100, dimensions: 384 } satisfies HNSWConfig,
  /** High recall, suitable for 100k-1M vectors */
  large: { m: 32, efConstruction: 400, efSearch: 150, dimensions: 384 } satisfies HNSWConfig,
  /** Maximum recall, suitable for >1M vectors */
  xlarge: { m: 48, efConstruction: 500, efSearch: 200, dimensions: 384 } satisfies HNSWConfig,
} as const
