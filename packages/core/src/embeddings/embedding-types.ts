/**
 * Type definitions for EmbeddingService
 * @module @skillsmith/core/embeddings/embedding-types
 */

/**
 * Result of embedding a skill
 */
export interface EmbeddingResult {
  skillId: string
  embedding: Float32Array
  text: string
}

/**
 * Similarity search result
 */
export interface SimilarityResult {
  skillId: string
  score: number
}

/**
 * Options for EmbeddingService initialization
 */
export interface EmbeddingServiceOptions {
  /** Path to SQLite database for caching embeddings */
  dbPath?: string
  /**
   * Force fallback mode (deterministic mock embeddings).
   * If not specified, checks SKILLSMITH_USE_MOCK_EMBEDDINGS env var,
   * then falls back to real embeddings.
   */
  useFallback?: boolean
}

/**
 * Type for feature extraction pipeline output - defined without importing
 */
export type FeatureExtractionPipeline = {
  (
    text: string,
    options?: { pooling?: string; normalize?: boolean }
  ): Promise<{ data: Float32Array }>
}
