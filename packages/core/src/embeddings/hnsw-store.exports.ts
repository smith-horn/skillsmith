/**
 * SMI-1519: `HNSWEmbeddingStore` re-exports.
 * SMI-5897: split out of `embeddings/index.ts` (a pure re-export forward,
 * unrelated to the `EmbeddingService` class it otherwise defines) to keep
 * that file under the CLAUDE.md 500-line-per-file cap. No behavior change —
 * `index.ts` re-exports everything from here via `export *`, so existing
 * `@skillsmith/core/embeddings` consumers are unaffected.
 */

export {
  HNSWEmbeddingStore,
  createHNSWStore,
  isHNSWAvailable,
  loadHNSWLib,
  DEFAULT_HNSW_CONFIG,
  HNSW_PRESETS,
} from './hnsw-store.js'

export type {
  IEmbeddingStore,
  HNSWConfig,
  HNSWEmbeddingStoreOptions,
  HNSWIndexStats,
  BatchInsertResult,
  HierarchicalNSW,
  HierarchicalNSWConstructor,
  HNSWSearchResult,
} from './hnsw-store.js'
