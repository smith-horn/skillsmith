/**
 * Source Adapter Module
 *
 * Provides a pluggable architecture for skill data sources.
 *
 * @example
 * ```typescript
 * import {
 *   SourceAdapterRegistry,
 *   SourceIndexer,
 *   type ISourceAdapter,
 *   type SourceConfig
 * } from '@skillsmith/core/sources'
 *
 * // Register adapter factories
 * const registry = new SourceAdapterRegistry()
 * registry.registerFactory('github', (config) => new GitHubSourceAdapter(config))
 *
 * // Create and use adapters
 * const adapter = await registry.create({
 *   id: 'github-main',
 *   name: 'GitHub',
 *   type: 'github',
 *   baseUrl: 'https://api.github.com',
 *   enabled: true
 * })
 *
 * // Index skills from the source
 * const indexer = new SourceIndexer(adapter, parser, repository)
 * const result = await indexer.indexAll({ topics: ['claude-skill'] })
 * ```
 *
 * @module sources
 */

// Types
export type {
  SourceType,
  SourceConfig,
  RateLimitConfig,
  SourceAuthConfig,
  SourceLocation,
  SourceRepository,
  SkillContent,
  SourceSearchOptions,
  SourceSearchResult,
  SkillIndexResult,
  BatchIndexResult,
  SourceHealth,
  AdapterError,
} from './types.js'

// Interfaces
export { type ISourceAdapter, isSourceAdapter } from './ISourceAdapter.js'

// Base class
export { BaseSourceAdapter, type ExtendedSourceConfig } from './BaseSourceAdapter.js'

// GitHub Adapter (SMI-590)
export { GitHubSourceAdapter, createGitHubAdapter } from './GitHubSourceAdapter.js'

// Scraper Adapters (SMI-591)
export {
  RawUrlSourceAdapter,
  createRawUrlAdapter,
  type SkillUrlEntry,
  type RawUrlSourceConfig,
} from './RawUrlSourceAdapter.js'

export {
  LocalFilesystemAdapter,
  createLocalFilesystemAdapter,
  type LocalFilesystemConfig,
} from './LocalFilesystemAdapter.js'

// SMI-4287 root-confinement helper — reused outside the adapter by
// `@skillsmith/mcp-server`'s `undo_apply` tool (SMI-5456 Wave 1 Step 3) to
// scope-fence undo restore targets the same way the scan loop does.
export {
  resolveSafeRealpath,
  isRealpathContained,
  type FsResult,
  type ResolveSafeRealpathOptions,
} from './LocalFilesystemAdapter.helpers.js'

export {
  GitLabSourceAdapter,
  createGitLabAdapter,
  type GitLabAdapterConfig,
} from './GitLabSourceAdapter.js'

// Registry
export {
  SourceAdapterRegistry,
  defaultRegistry,
  type SourceAdapterFactory,
  type RegistryStats,
} from './SourceAdapterRegistry.js'

// Indexer
export {
  SourceIndexer,
  type ParsedSkillMetadata,
  type ISkillParser,
  type ISkillRepository,
  type SourceIndexerOptions,
} from './SourceIndexer.js'

// Shared Utilities (SMI-879)
export {
  SKILL_FILE_PATHS,
  decodeBase64Content,
  isRateLimitStatus,
  isServerError,
  isNotFoundStatus,
  handleApiError,
  assertResponseOk,
  parseRateLimitHeaders,
  extractDefaultBranch,
  buildPaginationParams,
  parseJsonResponse,
  type NormalizedRepository,
} from './shared.js'
