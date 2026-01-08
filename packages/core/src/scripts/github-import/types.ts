/**
 * SMI-860: Type definitions for GitHub skill import
 */

// ============================================================================
// Configuration
// ============================================================================

export interface Config {
  /** GitHub personal access token */
  GITHUB_TOKEN: string | undefined
  /** GitHub API base URL */
  GITHUB_API_URL: string
  /** Results per page for GitHub API */
  PER_PAGE: number
  /** Maximum results from GitHub search API per query */
  MAX_RESULTS_PER_QUERY: number
  /** Rate limit delay between API calls (ms) */
  RATE_LIMIT_DELAY: number
  /** Delay between different query types (ms) */
  QUERY_DELAY: number
  /** Retry configuration */
  RETRY: {
    MAX_ATTEMPTS: number
    BASE_DELAY_MS: number
    BACKOFF_MULTIPLIER: number
  }
  /** Output file path */
  OUTPUT_PATH: string
  /** Checkpoint file path */
  CHECKPOINT_PATH: string
}

export const CONFIG: Config = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_API_URL: 'https://api.github.com',
  PER_PAGE: 100,
  MAX_RESULTS_PER_QUERY: 1000,
  RATE_LIMIT_DELAY: 150,
  QUERY_DELAY: 500,
  RETRY: {
    MAX_ATTEMPTS: 5,
    BASE_DELAY_MS: 1000,
    BACKOFF_MULTIPLIER: 2,
  },
  OUTPUT_PATH: process.env.OUTPUT_PATH || './data/imported-skills.json',
  CHECKPOINT_PATH: process.env.CHECKPOINT_PATH || './data/import-checkpoint.json',
}

// ============================================================================
// Type Definitions
// ============================================================================

/** GitHub repository owner structure */
export interface GitHubOwner {
  login: string
  type: string
}

/** GitHub repository from search API */
export interface GitHubRepository {
  id: number
  owner: GitHubOwner
  name: string
  full_name: string
  description: string | null
  html_url: string
  clone_url: string
  stargazers_count: number
  forks_count: number
  topics?: string[]
  language: string | null
  license: {
    key: string
    name: string
    spdx_id: string
  } | null
  created_at: string
  updated_at: string
  pushed_at: string
  default_branch: string
}

/** GitHub search API response */
export interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: GitHubRepository[]
}

/** Imported skill metadata */
export interface ImportedSkill {
  id: string
  name: string
  description: string
  author: string
  repo_url: string
  clone_url: string
  stars: number
  forks: number
  topics: string[]
  language: string | null
  license: string | null
  created_at: string
  updated_at: string
  source: string
  query_type: string
  imported_at: string
}

/** Import statistics */
export interface ImportStats {
  total_found: number
  total_imported: number
  duplicates_removed: number
  queries_completed: string[]
  errors: string[]
  started_at: string
  completed_at?: string
  duration_ms?: number
}

/** Checkpoint state for resume */
export interface Checkpoint {
  last_query: string
  last_page: number
  skills: ImportedSkill[]
  stats: ImportStats
  timestamp: string
}

/** Search query definition */
export interface SearchQuery {
  name: string
  query: string
  description: string
}

// ============================================================================
// Search Queries
// ============================================================================

export const SEARCH_QUERIES: SearchQuery[] = [
  {
    name: 'claude-skill',
    query: 'topic:claude-skill',
    description: 'Repositories tagged with claude-skill topic',
  },
  {
    name: 'mcp-server',
    query: 'topic:mcp-server',
    description: 'MCP server implementations',
  },
  {
    name: 'skill-md',
    query: 'filename:SKILL.md',
    description: 'Repositories containing SKILL.md files',
  },
  {
    name: 'anthropic-skills',
    query: 'topic:anthropic-skills',
    description: 'Repositories tagged with anthropic-skills topic',
  },
]
