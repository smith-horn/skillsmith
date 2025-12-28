/**
 * SMI-628: GitHubIndexer - Fetches skill repositories from GitHub
 *
 * Provides:
 * - Search GitHub for claude code skill repositories
 * - Rate limit handling
 * - Repository metadata extraction
 */

import type { SkillCreateInput } from '../types/skill.js'

/**
 * GitHub repository metadata
 */
export interface GitHubRepository {
  owner: string
  name: string
  fullName: string
  description: string | null
  url: string
  stars: number
  forks: number
  topics: string[]
  updatedAt: string
  defaultBranch: string
}

/**
 * Options for GitHub indexing
 */
export interface GitHubIndexerOptions {
  /** GitHub API token (optional but recommended for higher rate limits) */
  token?: string
  /** Maximum repositories to fetch per request */
  perPage?: number
  /** Delay between API calls in ms (default: 150) */
  requestDelay?: number
  /** Topics to search for */
  topics?: string[]
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  /** Number of repositories found */
  found: number
  /** Number successfully indexed */
  indexed: number
  /** Number of failures */
  failed: number
  /** Error messages for failures */
  errors: string[]
  /** Indexed repositories */
  repositories: GitHubRepository[]
}

/**
 * GitHub API response for repository search
 */
interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: GitHubApiRepository[]
}

/**
 * GitHub API repository object
 */
interface GitHubApiRepository {
  id: number
  full_name: string
  name: string
  owner: {
    login: string
  }
  description: string | null
  html_url: string
  stargazers_count: number
  forks_count: number
  topics: string[]
  updated_at: string
  default_branch: string
}

const DEFAULT_TOPICS = ['claude-code-skill', 'claude-code', 'anthropic-claude', 'claude-skill']

/**
 * Indexes skill repositories from GitHub
 */
export class GitHubIndexer {
  private token?: string
  private perPage: number
  private requestDelay: number
  private topics: string[]

  constructor(options: GitHubIndexerOptions = {}) {
    this.token = options.token
    this.perPage = options.perPage ?? 30
    this.requestDelay = options.requestDelay ?? 150
    this.topics = options.topics ?? DEFAULT_TOPICS
  }

  /**
   * Delay between API calls to avoid rate limiting
   */
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Build GitHub API headers
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'skillsmith-indexer/1.0',
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }
    return headers
  }

  /**
   * Search GitHub for repositories by topic or query
   */
  async searchRepositories(query: string, page: number = 1): Promise<IndexResult> {
    const result: IndexResult = {
      found: 0,
      indexed: 0,
      failed: 0,
      errors: [],
      repositories: [],
    }

    try {
      const searchQuery = encodeURIComponent(query)
      const url = `https://api.github.com/search/repositories?q=${searchQuery}&per_page=${this.perPage}&page=${page}`

      const response = await fetch(url, {
        headers: this.buildHeaders(),
      })

      if (!response.ok) {
        if (response.status === 403) {
          result.errors.push('GitHub API rate limit exceeded')
        } else {
          result.errors.push(`GitHub API error: ${response.status}`)
        }
        result.failed = 1
        return result
      }

      const data = (await response.json()) as GitHubSearchResponse
      result.found = data.total_count

      for (const item of data.items) {
        try {
          const repo: GitHubRepository = {
            owner: item.owner.login,
            name: item.name,
            fullName: item.full_name,
            description: item.description,
            url: item.html_url,
            stars: item.stargazers_count,
            forks: item.forks_count,
            topics: item.topics || [],
            updatedAt: item.updated_at,
            defaultBranch: item.default_branch,
          }
          result.repositories.push(repo)
          result.indexed++
        } catch (error) {
          result.failed++
          result.errors.push(
            `Failed to parse repository ${item.full_name}: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        }
      }

      await this.delay(this.requestDelay)
    } catch (error) {
      result.errors.push(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
      result.failed = 1
    }

    return result
  }

  /**
   * Index all configured topics
   */
  async indexAllTopics(maxPagesPerTopic: number = 3): Promise<IndexResult> {
    const result: IndexResult = {
      found: 0,
      indexed: 0,
      failed: 0,
      errors: [],
      repositories: [],
    }

    const seenUrls = new Set<string>()

    for (const topic of this.topics) {
      for (let page = 1; page <= maxPagesPerTopic; page++) {
        const query = `topic:${topic}`
        const pageResult = await this.searchRepositories(query, page)

        result.found += pageResult.found
        result.errors.push(...pageResult.errors)

        for (const repo of pageResult.repositories) {
          if (!seenUrls.has(repo.url)) {
            seenUrls.add(repo.url)
            result.repositories.push(repo)
            result.indexed++
          }
        }

        result.failed += pageResult.failed

        // Break if we've fetched all results for this topic
        if (pageResult.repositories.length < this.perPage) {
          break
        }
      }
    }

    return result
  }

  /**
   * Index repositories by first letter filter (A-F, G-L, etc.)
   */
  async indexByLetterRange(
    startLetter: string,
    endLetter: string,
    maxPages: number = 3
  ): Promise<IndexResult> {
    const result: IndexResult = {
      found: 0,
      indexed: 0,
      failed: 0,
      errors: [],
      repositories: [],
    }

    const seenUrls = new Set<string>()

    for (const topic of this.topics) {
      for (let page = 1; page <= maxPages; page++) {
        const query = `topic:${topic}`
        const pageResult = await this.searchRepositories(query, page)

        result.found += pageResult.found
        result.errors.push(...pageResult.errors)

        for (const repo of pageResult.repositories) {
          const firstLetter = repo.name.charAt(0).toUpperCase()
          if (firstLetter >= startLetter.toUpperCase() && firstLetter <= endLetter.toUpperCase()) {
            if (!seenUrls.has(repo.url)) {
              seenUrls.add(repo.url)
              result.repositories.push(repo)
              result.indexed++
            }
          }
        }

        result.failed += pageResult.failed

        if (pageResult.repositories.length < this.perPage) {
          break
        }
      }
    }

    return result
  }

  /**
   * Convert GitHub repository to SkillCreateInput
   */
  repositoryToSkill(repo: GitHubRepository): SkillCreateInput {
    // Calculate quality score based on stars and activity
    const starScore = Math.min(repo.stars / 10, 50) // Max 50 from stars
    const forkScore = Math.min(repo.forks / 5, 25) // Max 25 from forks
    const qualityScore = Math.round(starScore + forkScore + 25) // Base 25 points

    // Determine trust tier based on indicators
    let trustTier: 'verified' | 'community' | 'experimental' | 'unknown' = 'unknown'
    if (repo.topics.includes('claude-code-official')) {
      trustTier = 'verified'
    } else if (repo.stars >= 50) {
      trustTier = 'community'
    } else if (repo.stars >= 5) {
      trustTier = 'experimental'
    }

    return {
      name: repo.name,
      description: repo.description,
      author: repo.owner,
      repoUrl: repo.url,
      qualityScore,
      trustTier,
      tags: repo.topics,
    }
  }
}
