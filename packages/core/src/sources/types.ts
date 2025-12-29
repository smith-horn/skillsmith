/**
 * Source Adapter Types
 * Core type definitions for the skill source adapter architecture
 */

/**
 * Supported source types
 */
export type SourceType = 'github' | 'gitlab' | 'local' | 'raw-url' | 'registry' | 'custom'

/**
 * Source adapter configuration
 */
export interface SourceConfig {
  /** Unique identifier for this source instance */
  id: string
  /** Human-readable name */
  name: string
  /** Source type */
  type: SourceType
  /** Base URL for API requests */
  baseUrl: string
  /** Whether this source is enabled */
  enabled: boolean
  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig
  /** Authentication configuration */
  auth?: SourceAuthConfig
  /** Additional source-specific options */
  options?: Record<string, unknown>
}

/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number
  /** Window duration in milliseconds */
  windowMs: number
  /** Minimum delay between requests in milliseconds */
  minDelayMs: number
}

/**
 * Authentication configuration
 */
export interface SourceAuthConfig {
  /** Auth type */
  type: 'token' | 'basic' | 'oauth' | 'none'
  /** Token or credentials (should be loaded from env) */
  credentials?: string
}

/**
 * Location of a skill within a source
 */
export interface SourceLocation {
  /** Repository owner/namespace */
  owner?: string
  /** Repository name (optional for local/raw-url sources) */
  repo?: string
  /** Branch or ref (default: main/master) */
  branch?: string
  /** Path to skill file (default: SKILL.md) */
  path?: string
}

/**
 * Repository information from a source
 */
export interface SourceRepository {
  /** Unique identifier within the source */
  id: string
  /** Repository name */
  name: string
  /** Full URL to the repository */
  url: string
  /** Repository description */
  description: string | null
  /** Owner/namespace */
  owner: string
  /** Default branch */
  defaultBranch: string
  /** Star/like count */
  stars: number
  /** Fork count */
  forks: number
  /** Topics/tags */
  topics: string[]
  /** Last update timestamp */
  updatedAt: string
  /** Creation timestamp */
  createdAt: string
  /** License identifier */
  license: string | null
  /** Additional metadata */
  metadata: Record<string, unknown>
}

/**
 * Raw skill content fetched from source
 */
export interface SkillContent {
  /** Raw content of the skill file */
  rawContent: string
  /** Content hash for change detection */
  sha: string
  /** Location where content was found */
  location: SourceLocation
  /** File path within repository */
  filePath: string
  /** Content encoding */
  encoding: 'utf-8' | 'base64'
  /** Last modification timestamp (for local sources) */
  lastModified?: string
}

/**
 * Search options for querying sources
 */
export interface SourceSearchOptions {
  /** Search query string */
  query?: string
  /** Topic/tag filters */
  topics?: string[]
  /** Minimum star count */
  minStars?: number
  /** Language filter */
  language?: string
  /** Maximum results to return */
  limit?: number
  /** Offset for pagination */
  offset?: number
  /** Sort field */
  sortBy?: 'updated' | 'stars' | 'name' | 'created'
  /** Sort direction */
  sortOrder?: 'asc' | 'desc'
  /** Additional filters */
  filters?: Record<string, unknown>
}

/**
 * Result of a search operation
 */
export interface SourceSearchResult {
  /** Found repositories */
  repositories: SourceRepository[]
  /** Total count (may be estimated) */
  totalCount: number
  /** Whether more results are available */
  hasMore: boolean
  /** Cursor for next page (if applicable) */
  nextCursor?: string
}

/**
 * Result of indexing a single skill
 */
export interface SkillIndexResult {
  /** Whether indexing succeeded */
  success: boolean
  /** Repository URL */
  repoUrl: string
  /** Skill ID if created/updated */
  skillId?: string
  /** Action taken */
  action: 'created' | 'updated' | 'unchanged' | 'failed'
  /** Error message if failed */
  error?: string
}

/**
 * Result of a batch indexing operation
 */
export interface BatchIndexResult {
  /** Source identifier */
  sourceId: string
  /** Total repositories processed */
  total: number
  /** Successfully indexed */
  indexed: number
  /** Created new skills */
  created: number
  /** Updated existing skills */
  updated: number
  /** Unchanged (SHA match) */
  unchanged: number
  /** Failed to index */
  failed: number
  /** Individual results */
  results: SkillIndexResult[]
  /** Errors encountered */
  errors: string[]
  /** Duration in milliseconds */
  durationMs: number
}

/**
 * Source health status
 */
export interface SourceHealth {
  /** Whether the source is reachable */
  healthy: boolean
  /** Last successful check timestamp */
  lastCheck: string
  /** Response time in milliseconds */
  responseTimeMs: number
  /** Rate limit remaining (if applicable) */
  rateLimitRemaining?: number
  /** Rate limit reset time */
  rateLimitReset?: string
  /** Error message if unhealthy */
  error?: string
}
