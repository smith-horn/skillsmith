/**
 * SMI-860: GitHub API client with retry logic
 */

import { CONFIG, SearchQuery, ImportedSkill } from './types.js'
import { sleep, log, progressBar, isGitHubSearchResponse } from './utils.js'

/**
 * Fetches a URL with exponential backoff retry logic.
 * Handles rate limiting (429) and server errors (5xx).
 *
 * @param url - The URL to fetch
 * @param options - Fetch options including headers
 * @returns The fetch Response
 * @throws Error after max retries exceeded
 */
export async function fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
  const { MAX_ATTEMPTS, BASE_DELAY_MS, BACKOFF_MULTIPLIER } = CONFIG.RETRY
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, options)

      // Check for rate limit headers
      const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining')
      const rateLimitReset = response.headers.get('X-RateLimit-Reset')

      if (rateLimitRemaining === '0' && rateLimitReset) {
        const resetTime = parseInt(rateLimitReset, 10) * 1000
        const waitTime = Math.max(0, resetTime - Date.now()) + 1000
        log(`Rate limit exhausted. Waiting ${Math.round(waitTime / 1000)}s until reset...`, 'warn')
        await sleep(waitTime)
        continue
      }

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response
      }

      // Retry on 429 (rate limit) or 5xx server errors
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          const retryAfter = response.headers.get('Retry-After')
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1)
          log(`Retry ${attempt}/${MAX_ATTEMPTS} after ${delay}ms (HTTP ${response.status})`, 'warn')
          await sleep(delay)
          continue
        }
      }

      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1)
        log(`Retry ${attempt}/${MAX_ATTEMPTS} after ${delay}ms (${lastError.message})`, 'warn')
        await sleep(delay)
      }
    }
  }

  throw lastError || new Error('Max retries exceeded')
}

/** Get GitHub API headers */
export function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Skillsmith-Import/1.0',
  }
  if (CONFIG.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${CONFIG.GITHUB_TOKEN}`
  }
  return headers
}

/** Check and display GitHub rate limit status */
export async function checkRateLimit(): Promise<void> {
  try {
    const response = await fetch(`${CONFIG.GITHUB_API_URL}/rate_limit`, {
      headers: getGitHubHeaders(),
    })

    if (!response.ok) {
      log(`Could not check rate limit: ${response.status}`, 'warn')
      return
    }

    const data = (await response.json()) as {
      resources?: { search?: { remaining: number; limit: number; reset: number } }
      rate?: { remaining: number; limit: number; reset: number }
    }
    const search = data.resources?.search
    const core = data.rate

    log(`GitHub Rate Limits:`)
    log(
      `  Core API: ${core?.remaining}/${core?.limit} (resets: ${new Date((core?.reset ?? 0) * 1000).toISOString()})`
    )
    log(
      `  Search API: ${search?.remaining}/${search?.limit} (resets: ${new Date((search?.reset ?? 0) * 1000).toISOString()})`
    )
  } catch (error) {
    log(`Error checking rate limit: ${error}`, 'warn')
  }
}

/**
 * Fetches repositories from GitHub search API for a given query.
 * Handles pagination automatically up to GitHub's 1000 result limit.
 *
 * @param searchQuery - The search query configuration
 * @param startPage - Starting page for resume support
 * @param onProgress - Progress callback
 * @returns Array of imported skill metadata
 */
export async function fetchGitHubSearch(
  searchQuery: SearchQuery,
  startPage = 1,
  onProgress?: (current: number, total: number) => void
): Promise<ImportedSkill[]> {
  const skills: ImportedSkill[] = []
  let page = startPage
  let totalCount = 0
  const importedAt = new Date().toISOString()

  log(`Searching: ${searchQuery.description}`)
  log(`Query: ${searchQuery.query}`)

  while (true) {
    const url =
      `${CONFIG.GITHUB_API_URL}/search/repositories` +
      `?q=${encodeURIComponent(searchQuery.query)}` +
      `&per_page=${CONFIG.PER_PAGE}` +
      `&page=${page}` +
      `&sort=updated` +
      `&order=desc`

    try {
      const response = await fetchWithRetry(url, { headers: getGitHubHeaders() })

      if (response.status === 403) {
        const resetHeader = response.headers.get('X-RateLimit-Reset')
        const resetTime = resetHeader ? new Date(parseInt(resetHeader) * 1000) : 'unknown'
        log(`Rate limited. Reset at: ${resetTime}`, 'error')
        break
      }

      if (response.status === 422) {
        // Validation failed - often means query is too broad
        log(`Query validation failed (HTTP 422) - query may be too broad`, 'warn')
        break
      }

      if (!response.ok) {
        log(`Error: ${response.status} ${response.statusText}`, 'error')
        break
      }

      const rawData: unknown = await response.json()

      if (!isGitHubSearchResponse(rawData)) {
        log(`Invalid response format on page ${page}`, 'error')
        break
      }

      const data = rawData

      if (page === 1) {
        totalCount = Math.min(data.total_count, CONFIG.MAX_RESULTS_PER_QUERY)
        log(`Found ${data.total_count} repositories (fetching up to ${totalCount})`)
      }

      if (data.items.length === 0) {
        break
      }

      for (const repo of data.items) {
        skills.push({
          id: `github/${repo.owner.login}/${repo.name}`,
          name: repo.name,
          description: repo.description || '',
          author: repo.owner.login,
          repo_url: repo.html_url,
          clone_url: repo.clone_url,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          topics: repo.topics || [],
          language: repo.language,
          license: repo.license?.spdx_id || null,
          created_at: repo.created_at,
          updated_at: repo.updated_at,
          source: 'github',
          query_type: searchQuery.name,
          imported_at: importedAt,
        })
      }

      const progress = progressBar(Math.min(page * CONFIG.PER_PAGE, totalCount), totalCount)
      log(`Page ${page}: ${data.items.length} repos ${progress}`)

      onProgress?.(skills.length, totalCount)

      // Check if we've reached the limit or end of results
      if (
        page * CONFIG.PER_PAGE >= CONFIG.MAX_RESULTS_PER_QUERY ||
        data.items.length < CONFIG.PER_PAGE
      ) {
        break
      }

      page++
      await sleep(CONFIG.RATE_LIMIT_DELAY)
    } catch (error) {
      log(`Fetch error on page ${page}: ${error}`, 'error')
      break
    }
  }

  log(`Completed: ${skills.length} repositories from ${searchQuery.name}`)
  return skills
}
