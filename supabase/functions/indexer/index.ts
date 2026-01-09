/**
 * POST /v1/indexer - GitHub skill indexer
 * @module indexer
 *
 * SMI-1247: GitHub indexer Edge Function
 *
 * Indexes skill repositories from GitHub and updates the database.
 * Designed to run on a schedule via pg_cron or GitHub Actions.
 *
 * Request Body (optional):
 * - topics: Array of GitHub topics to search (default: claude-code related)
 * - maxPages: Max pages per topic (default: 3)
 * - dryRun: If true, don't write to database (default: false)
 *
 * Returns:
 * - Summary of indexed repositories
 */

import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

import { createSupabaseAdminClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

/**
 * GitHub repository metadata
 */
interface GitHubRepository {
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
 * GitHub API response
 */
interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: Array<{
    id: number
    full_name: string
    name: string
    owner: { login: string }
    description: string | null
    html_url: string
    stargazers_count: number
    forks_count: number
    topics: string[]
    updated_at: string
    default_branch: string
  }>
}

/**
 * Indexer request body
 */
interface IndexerRequest {
  topics?: string[]
  maxPages?: number
  dryRun?: boolean
}

/**
 * Indexer result
 */
interface IndexerResult {
  found: number
  indexed: number
  updated: number
  failed: number
  errors: string[]
  dryRun: boolean
}

const DEFAULT_TOPICS = ['claude-code-skill', 'claude-code', 'anthropic-claude', 'claude-skill']

const GITHUB_API_DELAY = 150 // ms between requests

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build GitHub API headers
 */
function buildGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'skillsmith-indexer/1.0',
  }

  const token = Deno.env.get('GITHUB_TOKEN')
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  return headers
}

/**
 * Search GitHub repositories by topic
 */
async function searchRepositories(
  topic: string,
  page: number,
  perPage = 30
): Promise<{ repos: GitHubRepository[]; total: number; error?: string }> {
  try {
    const query = encodeURIComponent(`topic:${topic}`)
    const url = `https://api.github.com/search/repositories?q=${query}&per_page=${perPage}&page=${page}&sort=stars&order=desc`

    const response = await fetch(url, {
      headers: buildGitHubHeaders(),
    })

    if (!response.ok) {
      if (response.status === 403) {
        const remaining = response.headers.get('X-RateLimit-Remaining')
        const reset = response.headers.get('X-RateLimit-Reset')
        return {
          repos: [],
          total: 0,
          error: `GitHub rate limit exceeded. Remaining: ${remaining}, Reset: ${reset}`,
        }
      }
      return {
        repos: [],
        total: 0,
        error: `GitHub API error: ${response.status}`,
      }
    }

    const data = (await response.json()) as GitHubSearchResponse

    const repos: GitHubRepository[] = data.items.map((item) => ({
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
    }))

    return { repos, total: data.total_count }
  } catch (error) {
    return {
      repos: [],
      total: 0,
      error: `Network error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * Convert repository to skill data
 */
function repositoryToSkill(repo: GitHubRepository): Record<string, unknown> {
  // Calculate quality score based on stars and activity
  const starScore = Math.min(repo.stars / 10, 50)
  const forkScore = Math.min(repo.forks / 5, 25)
  const qualityScore = (starScore + forkScore + 25) / 100 // Normalize to 0-1

  // Determine trust tier
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
    repo_url: repo.url,
    quality_score: qualityScore,
    trust_tier: trustTier,
    tags: repo.topics,
    stars: repo.stars,
    indexed_at: new Date().toISOString(),
  }
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest()
  }

  // Only allow POST requests (or GET for manual trigger)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return errorResponse('Method not allowed', 405)
  }

  const requestId = getRequestId(req.headers)
  const origin = req.headers.get('origin')
  logInvocation('indexer', requestId)

  try {
    // Parse request body (optional)
    let body: IndexerRequest = {}
    if (req.method === 'POST') {
      try {
        body = await req.json()
      } catch {
        // Empty body is OK
      }
    }

    const topics = body.topics || DEFAULT_TOPICS
    const maxPages = Math.min(body.maxPages || 3, 10) // Max 10 pages
    const dryRun = body.dryRun ?? false

    const result: IndexerResult = {
      found: 0,
      indexed: 0,
      updated: 0,
      failed: 0,
      errors: [],
      dryRun,
    }

    const seenUrls = new Set<string>()
    const repositories: GitHubRepository[] = []

    // Fetch repositories from all topics
    for (const topic of topics) {
      for (let page = 1; page <= maxPages; page++) {
        const { repos, total, error } = await searchRepositories(topic, page)

        if (error) {
          result.errors.push(`[${topic}] ${error}`)
          result.failed++
          break // Stop this topic on error
        }

        result.found = Math.max(result.found, total)

        for (const repo of repos) {
          if (!seenUrls.has(repo.url)) {
            seenUrls.add(repo.url)
            repositories.push(repo)
          }
        }

        // Break if we've fetched all results
        if (repos.length < 30) {
          break
        }

        await delay(GITHUB_API_DELAY)
      }
    }

    // Write to database if not dry run
    if (!dryRun && repositories.length > 0) {
      const supabase = createSupabaseAdminClient()

      for (const repo of repositories) {
        try {
          const skillData = repositoryToSkill(repo)

          // Upsert skill by repo_url
          const { error } = await supabase.from('skills').upsert(skillData, {
            onConflict: 'repo_url',
            ignoreDuplicates: false,
          })

          if (error) {
            result.errors.push(`Failed to upsert ${repo.fullName}: ${error.message}`)
            result.failed++
          } else {
            result.indexed++
          }
        } catch (error) {
          result.errors.push(
            `Error processing ${repo.fullName}: ${error instanceof Error ? error.message : 'Unknown'}`
          )
          result.failed++
        }
      }

      // Log to audit_logs
      await supabase.from('audit_logs').insert({
        event_type: 'indexer:run',
        actor: 'system',
        action: 'index',
        result: result.failed === 0 ? 'success' : 'partial',
        metadata: {
          request_id: requestId,
          topics,
          found: result.found,
          indexed: result.indexed,
          failed: result.failed,
          dry_run: dryRun,
        },
      })
    } else if (dryRun) {
      result.indexed = repositories.length
    }

    const response = jsonResponse({
      data: {
        ...result,
        repositories_found: repositories.length,
      },
      meta: {
        topics,
        max_pages: maxPages,
        request_id: requestId,
        timestamp: new Date().toISOString(),
      },
    })

    // Add CORS headers
    const headers = new Headers(response.headers)
    Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    headers.set('X-Request-ID', requestId)

    return new Response(response.body, {
      status: response.status,
      headers,
    })
  } catch (error) {
    console.error('Indexer error:', error)
    return errorResponse('Internal server error', 500, {
      request_id: requestId,
    })
  }
})
