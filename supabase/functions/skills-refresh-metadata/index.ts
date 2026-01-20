/**
 * POST /v1/skills-refresh-metadata - Refresh metadata for existing skills
 * @module skills-refresh-metadata
 *
 * SMI-1618: Skill Metadata Refresh Job
 *
 * Refreshes metadata (stars, forks, quality_score) for skills already in the database.
 * This complements the indexer which only processes new skills via topic search.
 *
 * Request Body (optional):
 * - batchSize: Number of skills to refresh per run (default: 100)
 * - staleDays: Only refresh if indexed_at > N days old (default: 1)
 * - dryRun: If true, don't write to database (default: false)
 *
 * Algorithm:
 * 1. Query skills ordered by indexed_at ASC (oldest first)
 * 2. For each skill, parse repo_url to extract owner/repo
 * 3. Fetch GitHub API: GET /repos/{owner}/{repo}
 * 4. Extract: stargazers_count, forks_count, description, topics
 * 5. Recalculate quality_score using logarithmic formula
 * 6. Preserve trust_tier (never downgrade 'verified')
 * 7. Update indexed_at timestamp
 * 8. Upsert to database
 * 9. Log to audit_logs
 *
 * Authentication:
 * - Uses shared GitHub auth (App or PAT)
 * - Requires SUPABASE_SERVICE_ROLE_KEY for database writes
 */

import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

import { createSupabaseAdminClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

import { buildGitHubHeaders } from '../_shared/github-auth.ts'

/**
 * Request body schema
 */
interface RefreshRequest {
  batchSize?: number // Skills per run (default: 100)
  staleDays?: number // Only refresh if indexed_at > N days (default: 1)
  dryRun?: boolean // Preview mode (default: false)
}

/**
 * GitHub repository API response
 */
interface GitHubRepoResponse {
  stargazers_count: number
  forks_count: number
  description: string | null
  topics: string[]
  archived: boolean
  disabled: boolean
}

/**
 * Skill record from database
 */
interface SkillRecord {
  id: string
  name: string
  repo_url: string | null
  trust_tier: 'verified' | 'community' | 'experimental' | 'unknown'
  indexed_at: string
  quality_score: number | null
}

/**
 * Refresh result
 */
interface RefreshResult {
  processed: number
  updated: number
  failed: number
  skipped: number // Deleted/archived repos
  errors: string[]
}

const GITHUB_API_DELAY = 150 // ms between requests

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse owner/repo from GitHub URL
 * Handles various URL formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch/path
 */
function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  try {
    const urlObj = new URL(url)
    if (urlObj.hostname !== 'github.com') {
      return null
    }

    // Path format: /owner/repo[/tree/...]
    const pathParts = urlObj.pathname.split('/').filter(Boolean)
    if (pathParts.length < 2) {
      return null
    }

    return {
      owner: pathParts[0],
      repo: pathParts[1],
    }
  } catch {
    return null
  }
}

/**
 * Calculate quality score using logarithmic formula
 * Matches the indexer's quality score calculation
 */
function calculateQualityScore(stars: number, forks: number): number {
  // Use logarithmic scale for better distribution
  const starScore = Math.min(Math.log10(stars + 1) * 15, 50)
  const forkScore = Math.min(Math.log10(forks + 1) * 10, 25)
  return (starScore + forkScore + 25) / 100 // Normalize to 0-1
}

/**
 * Determine trust tier based on metrics
 * Never downgrades 'verified' tier
 */
function determineTrustTier(
  stars: number,
  topics: string[],
  currentTier: SkillRecord['trust_tier']
): SkillRecord['trust_tier'] {
  // Never downgrade verified tier
  if (currentTier === 'verified') {
    return 'verified'
  }

  if (topics.includes('claude-code-official')) {
    return 'verified'
  }

  if (stars >= 50) {
    return 'community'
  }

  if (stars >= 5) {
    return 'experimental'
  }

  return 'unknown'
}

/**
 * Fetch repository metadata from GitHub API
 */
async function fetchRepoMetadata(
  owner: string,
  repo: string
): Promise<{ data: GitHubRepoResponse | null; error: string | null; notFound: boolean }> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}`
    const response = await fetch(url, {
      headers: await buildGitHubHeaders('skillsmith-refresh/1.0'),
    })

    if (response.status === 404) {
      return { data: null, error: null, notFound: true }
    }

    if (response.status === 403) {
      const remaining = response.headers.get('X-RateLimit-Remaining')
      const reset = response.headers.get('X-RateLimit-Reset')
      return {
        data: null,
        error: `Rate limit exceeded. Remaining: ${remaining}, Reset: ${reset}`,
        notFound: false,
      }
    }

    if (!response.ok) {
      return {
        data: null,
        error: `GitHub API error: ${response.status}`,
        notFound: false,
      }
    }

    const data = (await response.json()) as GitHubRepoResponse
    return { data, error: null, notFound: false }
  } catch (error) {
    return {
      data: null,
      error: `Network error: ${error instanceof Error ? error.message : 'Unknown'}`,
      notFound: false,
    }
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
  logInvocation('skills-refresh-metadata', requestId)

  try {
    // Parse request body (optional)
    let body: RefreshRequest = {}
    if (req.method === 'POST') {
      try {
        body = await req.json()
      } catch {
        // Empty body is OK
      }
    }

    const batchSize = Math.min(Math.max(body.batchSize || 100, 1), 500) // Clamp 1-500
    const staleDays = Math.max(body.staleDays ?? 1, 0)
    const dryRun = body.dryRun ?? false

    const result: RefreshResult = {
      processed: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    }

    const supabase = createSupabaseAdminClient()

    // Calculate staleness threshold
    const staleThreshold = new Date()
    staleThreshold.setDate(staleThreshold.getDate() - staleDays)

    // Query skills that need refreshing, ordered by oldest first
    const { data: skills, error: queryError } = await supabase
      .from('skills')
      .select('id, name, repo_url, trust_tier, indexed_at, quality_score')
      .not('repo_url', 'is', null)
      .lt('indexed_at', staleThreshold.toISOString())
      .order('indexed_at', { ascending: true })
      .limit(batchSize)

    if (queryError) {
      console.error('Failed to query skills:', queryError)
      return errorResponse('Failed to query skills', 500, { request_id: requestId })
    }

    if (!skills || skills.length === 0) {
      const response = jsonResponse({
        data: {
          ...result,
          message: 'No skills need refreshing',
        },
        meta: {
          batch_size: batchSize,
          stale_days: staleDays,
          dry_run: dryRun,
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
    }

    console.log(`Processing ${skills.length} skills for metadata refresh`)

    // Process each skill
    for (const skill of skills as SkillRecord[]) {
      result.processed++

      if (!skill.repo_url) {
        result.skipped++
        continue
      }

      // Parse owner/repo from URL
      const parsed = parseRepoUrl(skill.repo_url)
      if (!parsed) {
        result.errors.push(`Invalid repo URL for ${skill.name}: ${skill.repo_url}`)
        result.failed++
        continue
      }

      // Fetch fresh metadata from GitHub
      const {
        data: repoData,
        error: repoError,
        notFound,
      } = await fetchRepoMetadata(parsed.owner, parsed.repo)

      if (notFound) {
        console.log(`Repository not found (deleted?): ${skill.repo_url}`)
        result.skipped++
        // Don't delete from DB - just skip
        continue
      }

      if (repoError || !repoData) {
        result.errors.push(`Failed to fetch ${skill.name}: ${repoError}`)
        result.failed++
        continue
      }

      // Skip archived/disabled repos
      if (repoData.archived || repoData.disabled) {
        console.log(`Repository archived/disabled: ${skill.repo_url}`)
        result.skipped++
        continue
      }

      // Calculate new quality score
      const newQualityScore = calculateQualityScore(repoData.stargazers_count, repoData.forks_count)

      // Determine trust tier (preserve verified)
      const newTrustTier = determineTrustTier(
        repoData.stargazers_count,
        repoData.topics,
        skill.trust_tier
      )

      // Prepare update data
      const updateData = {
        stars: repoData.stargazers_count,
        quality_score: newQualityScore,
        trust_tier: newTrustTier,
        tags: repoData.topics,
        indexed_at: new Date().toISOString(),
      }

      // Log change for visibility
      const oldScore = skill.quality_score ?? 0
      if (Math.abs(newQualityScore - oldScore) > 0.01) {
        console.log(
          `[Refresh] ${skill.name}: score ${oldScore.toFixed(3)} → ${newQualityScore.toFixed(3)}, ` +
            `stars ${repoData.stargazers_count}, tier ${skill.trust_tier} → ${newTrustTier}`
        )
      }

      // Update database
      if (!dryRun) {
        const { error: updateError } = await supabase
          .from('skills')
          .update(updateData)
          .eq('id', skill.id)

        if (updateError) {
          result.errors.push(`Failed to update ${skill.name}: ${updateError.message}`)
          result.failed++
        } else {
          result.updated++
        }
      } else {
        result.updated++
      }

      // Rate limiting
      await delay(GITHUB_API_DELAY)
    }

    // Log to audit_logs
    if (!dryRun) {
      await supabase.from('audit_logs').insert({
        event_type: 'refresh:run',
        actor: 'system',
        action: 'refresh_metadata',
        result: result.failed === 0 ? 'success' : 'partial',
        metadata: {
          request_id: requestId,
          batch_size: batchSize,
          stale_days: staleDays,
          processed: result.processed,
          updated: result.updated,
          failed: result.failed,
          skipped: result.skipped,
          dry_run: dryRun,
        },
      })
    }

    const response = jsonResponse({
      data: result,
      meta: {
        batch_size: batchSize,
        stale_days: staleDays,
        dry_run: dryRun,
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
    console.error('Refresh error:', error)
    return errorResponse('Internal server error', 500, {
      request_id: requestId,
    })
  }
})
