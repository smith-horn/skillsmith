/**
 * Source Adapter Interface
 * Defines the contract for all skill source adapters
 */

import type {
  SourceConfig,
  SourceLocation,
  SourceRepository,
  SourceSearchOptions,
  SourceSearchResult,
  SkillContent,
  SourceHealth,
} from './types.js'

/**
 * Interface for skill source adapters
 *
 * Implementations provide access to different skill sources:
 * - GitHub repositories
 * - GitLab repositories
 * - Local filesystem
 * - Custom registries
 *
 * @example
 * ```typescript
 * const adapter = new GitHubSourceAdapter({
 *   id: 'github-main',
 *   name: 'GitHub',
 *   type: 'github',
 *   baseUrl: 'https://api.github.com',
 *   enabled: true
 * })
 *
 * const results = await adapter.search({ topics: ['claude-skill'] })
 * for (const repo of results.repositories) {
 *   const content = await adapter.fetchSkillContent({ owner: repo.owner, repo: repo.name })
 *   // Process content...
 * }
 * ```
 */
export interface ISourceAdapter {
  /**
   * Source configuration
   */
  readonly config: SourceConfig

  /**
   * Unique identifier for this adapter instance
   */
  readonly id: string

  /**
   * Human-readable name
   */
  readonly name: string

  /**
   * Source type identifier
   */
  readonly type: string

  /**
   * Initialize the adapter
   * Called once before first use
   *
   * @returns Promise that resolves when initialization is complete
   * @throws Error if initialization fails
   */
  initialize(): Promise<void>

  /**
   * Check if the source is healthy and reachable
   *
   * @returns Health status of the source
   */
  checkHealth(): Promise<SourceHealth>

  /**
   * Search for repositories containing skills
   *
   * @param options - Search options (query, filters, pagination)
   * @returns Search results with repositories
   */
  search(options: SourceSearchOptions): Promise<SourceSearchResult>

  /**
   * Get repository information
   *
   * @param location - Repository location (owner, repo)
   * @returns Repository metadata
   * @throws Error if repository not found
   */
  getRepository(location: SourceLocation): Promise<SourceRepository>

  /**
   * Fetch raw skill content from a repository
   *
   * @param location - Skill location (owner, repo, path)
   * @returns Skill content with metadata
   * @throws Error if skill file not found
   */
  fetchSkillContent(location: SourceLocation): Promise<SkillContent>

  /**
   * Check if a skill exists at the given location
   *
   * @param location - Skill location to check
   * @returns True if skill exists
   */
  skillExists(location: SourceLocation): Promise<boolean>

  /**
   * Get the SHA/hash of a skill file for change detection
   *
   * @param location - Skill location
   * @returns SHA hash of the file, or null if not found
   */
  getSkillSha(location: SourceLocation): Promise<string | null>

  /**
   * Dispose of any resources held by the adapter
   * Called when the adapter is no longer needed
   */
  dispose(): Promise<void>
}

/**
 * Type guard to check if an object implements ISourceAdapter
 */
export function isSourceAdapter(obj: unknown): obj is ISourceAdapter {
  if (typeof obj !== 'object' || obj === null) return false

  const adapter = obj as Partial<ISourceAdapter>
  return (
    typeof adapter.id === 'string' &&
    typeof adapter.name === 'string' &&
    typeof adapter.type === 'string' &&
    typeof adapter.initialize === 'function' &&
    typeof adapter.search === 'function' &&
    typeof adapter.fetchSkillContent === 'function'
  )
}
