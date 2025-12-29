/**
 * Source Indexer
 * Connects source adapters to the skill parsing and persistence pipeline
 */

import type { ISourceAdapter } from './ISourceAdapter.js'
import type {
  SourceSearchOptions,
  SourceRepository,
  BatchIndexResult,
  SkillIndexResult,
} from './types.js'

/**
 * Parsed skill metadata (matches existing SkillParser output)
 */
export interface ParsedSkillMetadata {
  name: string
  description: string | null
  author: string | null
  version: string | null
  tags: string[]
  dependencies: string[]
  category: string | null
  license: string | null
  rawContent: string
  repoUrl: string
  filePath: string
  sha: string
  owner: string
  repo: string
}

/**
 * Skill parser interface (matches existing SkillParser)
 */
export interface ISkillParser {
  parse(content: string): ParsedSkillMetadata | null
}

/**
 * Repository interface for persisting skills
 */
export interface ISkillRepository {
  upsertFromMetadata(metadata: ParsedSkillMetadata): Promise<{
    id: string
    action: 'created' | 'updated' | 'unchanged'
  }>
  getSkillBySha(sha: string): Promise<{ id: string } | null>
}

/**
 * Indexer options
 */
export interface SourceIndexerOptions {
  /** Maximum concurrent fetch operations */
  concurrency?: number
  /** Whether to skip unchanged skills (SHA match) */
  skipUnchanged?: boolean
  /** Progress callback */
  onProgress?: (current: number, total: number, repo: string) => void
  /** Error callback */
  onError?: (error: Error, repo: SourceRepository) => void
}

const DEFAULT_OPTIONS: Required<Omit<SourceIndexerOptions, 'onProgress' | 'onError'>> = {
  concurrency: 5,
  skipUnchanged: true,
}

/**
 * Source Indexer
 *
 * Orchestrates the indexing pipeline:
 * 1. Search source for repositories
 * 2. Fetch skill content from each repository
 * 3. Parse skill metadata
 * 4. Persist to database
 *
 * @example
 * ```typescript
 * const indexer = new SourceIndexer(
 *   githubAdapter,
 *   skillParser,
 *   skillRepository
 * )
 *
 * const result = await indexer.indexAll({
 *   topics: ['claude-skill'],
 *   limit: 100
 * })
 *
 * console.log(`Indexed ${result.indexed} skills`)
 * ```
 */
export class SourceIndexer {
  constructor(
    private readonly adapter: ISourceAdapter,
    private readonly parser: ISkillParser,
    private readonly repository: ISkillRepository,
    private readonly options: SourceIndexerOptions = {}
  ) {}

  /**
   * Index all skills from the source matching search options
   *
   * @param searchOptions - Options for searching the source
   * @returns Batch index result
   */
  async indexAll(searchOptions: SourceSearchOptions = {}): Promise<BatchIndexResult> {
    const startTime = Date.now()
    const opts = { ...DEFAULT_OPTIONS, ...this.options }

    // Search for repositories
    const searchResult = await this.adapter.search(searchOptions)
    const repositories = searchResult.repositories

    const results: SkillIndexResult[] = []
    let created = 0
    let updated = 0
    let unchanged = 0
    let failed = 0
    const errors: string[] = []

    // Process repositories with concurrency limit
    const chunks = this.chunkArray(repositories, opts.concurrency)

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex]
      const chunkPromises = chunk.map(async (repo, indexInChunk) => {
        const overallIndex = chunkIndex * opts.concurrency + indexInChunk
        this.options.onProgress?.(overallIndex + 1, repositories.length, repo.name)

        const result = await this.indexRepository(repo, opts.skipUnchanged)
        results.push(result)

        switch (result.action) {
          case 'created':
            created++
            break
          case 'updated':
            updated++
            break
          case 'unchanged':
            unchanged++
            break
          case 'failed':
            failed++
            if (result.error) {
              errors.push(`${repo.url}: ${result.error}`)
            }
            break
        }

        return result
      })

      await Promise.all(chunkPromises)
    }

    return {
      sourceId: this.adapter.id,
      total: repositories.length,
      indexed: created + updated,
      created,
      updated,
      unchanged,
      failed,
      results,
      errors,
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * Index a single repository
   *
   * @param repo - Repository to index
   * @param skipUnchanged - Whether to skip if SHA unchanged
   * @returns Index result
   */
  async indexRepository(repo: SourceRepository, skipUnchanged = true): Promise<SkillIndexResult> {
    try {
      // Check if skill exists and SHA matches
      if (skipUnchanged) {
        const sha = await this.adapter.getSkillSha({
          owner: repo.owner,
          repo: repo.name,
        })

        if (sha) {
          const existing = await this.repository.getSkillBySha(sha)
          if (existing) {
            return {
              success: true,
              repoUrl: repo.url,
              skillId: existing.id,
              action: 'unchanged',
            }
          }
        }
      }

      // Fetch skill content
      const content = await this.adapter.fetchSkillContent({
        owner: repo.owner,
        repo: repo.name,
      })

      // Parse skill metadata
      const parsed = this.parser.parse(content.rawContent)
      if (!parsed) {
        return {
          success: false,
          repoUrl: repo.url,
          action: 'failed',
          error: 'Failed to parse skill content',
        }
      }

      // Enrich with source metadata
      const metadata: ParsedSkillMetadata = {
        ...parsed,
        repoUrl: repo.url,
        filePath: content.filePath,
        sha: content.sha,
        owner: repo.owner,
        repo: repo.name,
        license: repo.license ?? parsed.license,
      }

      // Persist to database
      const result = await this.repository.upsertFromMetadata(metadata)

      return {
        success: true,
        repoUrl: repo.url,
        skillId: result.id,
        action: result.action,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.options.onError?.(error instanceof Error ? error : new Error(message), repo)

      return {
        success: false,
        repoUrl: repo.url,
        action: 'failed',
        error: message,
      }
    }
  }

  /**
   * Index specific repositories by URL
   *
   * @param urls - Repository URLs to index
   * @returns Batch index result
   */
  async indexUrls(urls: string[]): Promise<BatchIndexResult> {
    const startTime = Date.now()
    const results: SkillIndexResult[] = []
    let created = 0
    let updated = 0
    let unchanged = 0
    let failed = 0
    const errors: string[] = []

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      this.options.onProgress?.(i + 1, urls.length, url)

      try {
        // Parse URL to get owner/repo
        const location = this.parseRepoUrl(url)
        if (!location) {
          results.push({
            success: false,
            repoUrl: url,
            action: 'failed',
            error: 'Invalid repository URL',
          })
          failed++
          errors.push(`${url}: Invalid repository URL`)
          continue
        }

        // Get repository info
        const repo = await this.adapter.getRepository(location)
        const result = await this.indexRepository(repo, this.options.skipUnchanged ?? true)
        results.push(result)

        switch (result.action) {
          case 'created':
            created++
            break
          case 'updated':
            updated++
            break
          case 'unchanged':
            unchanged++
            break
          case 'failed':
            failed++
            if (result.error) errors.push(`${url}: ${result.error}`)
            break
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        results.push({
          success: false,
          repoUrl: url,
          action: 'failed',
          error: message,
        })
        failed++
        errors.push(`${url}: ${message}`)
      }
    }

    return {
      sourceId: this.adapter.id,
      total: urls.length,
      indexed: created + updated,
      created,
      updated,
      unchanged,
      failed,
      results,
      errors,
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * Parse a repository URL into owner/repo components
   */
  private parseRepoUrl(url: string): { owner: string; repo: string } | null {
    try {
      const parsed = new URL(url)
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts.length >= 2) {
        return {
          owner: parts[0],
          repo: parts[1].replace(/\.git$/, ''),
        }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }
}
