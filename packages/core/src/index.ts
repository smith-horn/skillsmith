/**
 * @skillsmith/core - Core functionality for skill discovery
 */

// Version
export const VERSION = '0.1.0';

// Database (SMI-577)
export {
  SCHEMA_VERSION,
  createDatabase,
  closeDatabase,
  initializeSchema,
  getSchemaVersion,
  runMigrations,
} from './db/schema.js';

// Repositories (SMI-578)
export { SkillRepository } from './repositories/SkillRepository.js';
export { CacheRepository } from './repositories/CacheRepository.js';

// Services (SMI-579)
export { SearchService } from './services/SearchService.js';

// Types (SMI-577)
export type {
  Skill,
  SkillCreateInput,
  SkillUpdateInput,
  PaginatedResults,
  SearchOptions,
  SearchResult,
  TrustTier,
  CacheEntry,
} from './types/skill.js';

// Search
export { HybridSearch } from './search/index.js';
export type { HybridSearchOptions, SearchQuery, SearchResponse } from './search/index.js';

// Embeddings
export { EmbeddingService } from './embeddings/index.js';
export type { EmbeddingResult, SimilarityResult } from './embeddings/index.js';

// Cache
export { L1Cache, L2Cache, TieredCache } from './cache/index.js';
export type { SearchCacheEntry, SearchResult as CachedSearchResult, CacheStats, TieredCacheOptions } from './cache/index.js';

// Security
export { SecurityScanner } from './security/index.js';
export type { SecurityFinding, ScanReport, ScannerOptions } from './security/index.js';

// Error handling (SMI-583)
export {
  ErrorCodes,
  ErrorSuggestions,
  SkillsmithError,
  createErrorResponse,
  withErrorBoundary,
  type ErrorCategory,
  type ErrorCode,
  type ErrorResponse,
} from './errors.js';

// MCP types (SMI-581, SMI-582)
export {
  TrustTierDescriptions,
  type TrustTier as MCPTrustTier,
  type SkillCategory,
  type ScoreBreakdown,
  type Skill as MCPSkill,
  type SkillSearchResult,
  type SearchFilters,
  type SearchResponse as MCPSearchResponse,
  type GetSkillResponse,
} from './types.js';
