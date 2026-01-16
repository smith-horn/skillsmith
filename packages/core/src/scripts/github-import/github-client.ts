/**
 * SMI-860: GitHub API client with retry logic
 * SMI-1445: Added GitHub App authentication support
 */

import { CONFIG, SearchQuery, ImportedSkill } from './types.js'
import { sleep, log, progressBar, isGitHubSearchResponse } from './utils.js'

// ============================================================================
// Rate Limit Monitoring (SMI-XXXX)
// ============================================================================

export interface RateLimitInfo {
  remaining: number
  limit: number
  resetTime: Date
  used: number
}

export interface RateLimitStatus {
  core: RateLimitInfo | null
  search: RateLimitInfo | null
}

// Track rate limit usage across the import session (reserved for future use)
const _rateLimitTracker = {
  startCore: 0,
  startSearch: 0,
  currentCore: 0,
  currentSearch: 0,
}

// Forward declaration for getRateLimitStatus - assigned after getGitHubHeaders is defined
// eslint-disable-next-line prefer-const
let getRateLimitStatus: () => Promise<RateLimitStatus>

/**
 * Display rate limit status from response headers (lightweight, no API call).
 */
export function displayRateLimitFromHeaders(response: Response, label = 'Rate limit'): void {
  const remaining = response.headers.get('X-RateLimit-Remaining')
  const limit = response.headers.get('X-RateLimit-Limit')
  const reset = response.headers.get('X-RateLimit-Reset')

  if (remaining && limit && reset) {
    const resetTime = new Date(parseInt(reset, 10) * 1000)
    const timeUntilReset = Math.max(0, Math.round((resetTime.getTime() - Date.now()) / 1000 / 60))
    log(`  ${label}: ${remaining}/${limit} remaining (resets in ${timeUntilReset}m)`)
  }
}

// Cache for GitHub App installation token
let cachedInstallationToken: { token: string; expiresAt: number } | null = null

// ============================================================================
// GitHub App Authentication (SMI-1445)
// ============================================================================

/**
 * Normalize a PEM key string that may have lost newlines in env var storage.
 * Also handles base64-encoded PEM keys.
 */
function normalizePemKey(key: string): string {
  let normalized = key

  // Check if the key is base64-encoded (doesn't start with -----)
  if (!normalized.startsWith('-----') && normalized.startsWith('LS0tLS')) {
    try {
      normalized = Buffer.from(normalized, 'base64').toString('utf-8')
      log('Decoded base64-encoded PEM key')
    } catch {
      log('Key appears to be base64 but failed to decode', 'warn')
    }
  }

  // Handle escaped newlines (\\n) that might come from JSON encoding
  normalized = normalized.replace(/\\n/g, '\n')

  // If key already has proper newlines, return as-is
  if (normalized.includes('\n') && normalized.split('\n').length > 3) {
    return normalized
  }

  // Extract header, footer, and base64 content
  const headerMatch = normalized.match(/(-----BEGIN [A-Z ]+-----)/)?.[1]
  const footerMatch = normalized.match(/(-----END [A-Z ]+-----)/)?.[1]

  if (headerMatch && footerMatch) {
    const base64 = normalized.replace(headerMatch, '').replace(footerMatch, '').replace(/\s/g, '')
    const lines = base64.match(/.{1,64}/g) || []
    normalized = `${headerMatch}\n${lines.join('\n')}\n${footerMatch}`
  }

  return normalized
}

// Use crypto.webcrypto for Node.js compatibility
import { webcrypto } from 'crypto'
type CryptoKey = webcrypto.CryptoKey

/**
 * Import a PEM private key for use with Web Crypto.
 * Handles both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY) formats.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = normalizePemKey(pem)
  const isPkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----')

  // Extract base64 content
  const base64 = normalized
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s/g, '')

  const binaryDer = Buffer.from(base64, 'base64')

  if (isPkcs1) {
    // PKCS#1 to PKCS#8 conversion
    const pkcs8Header = Buffer.from([
      0x30,
      0x82,
      0x00,
      0x00, // SEQUENCE (length TBD)
      0x02,
      0x01,
      0x00, // INTEGER 0 (version)
      0x30,
      0x0d, // SEQUENCE (AlgorithmIdentifier)
      0x06,
      0x09,
      0x2a,
      0x86,
      0x48,
      0x86,
      0xf7,
      0x0d,
      0x01,
      0x01,
      0x01, // OID rsaEncryption
      0x05,
      0x00, // NULL (parameters)
      0x04,
      0x82,
      0x00,
      0x00, // OCTET STRING (length TBD)
    ])

    const totalLen = pkcs8Header.length - 4 + binaryDer.length
    const pkcs8 = Buffer.alloc(4 + totalLen)
    pkcs8Header.copy(pkcs8)
    binaryDer.copy(pkcs8, pkcs8Header.length)

    // Set outer SEQUENCE length
    pkcs8[2] = (totalLen >> 8) & 0xff
    pkcs8[3] = totalLen & 0xff

    // Set OCTET STRING length
    pkcs8[pkcs8Header.length - 2] = (binaryDer.length >> 8) & 0xff
    pkcs8[pkcs8Header.length - 1] = binaryDer.length & 0xff

    return await webcrypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )
  } else {
    return await webcrypto.subtle.importKey(
      'pkcs8',
      binaryDer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )
  }
}

/**
 * Base64URL encode for JWT
 */
function base64UrlEncode(data: Buffer | string): string {
  const buffer = typeof data === 'string' ? Buffer.from(data) : data
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Create a JWT for GitHub App authentication
 */
async function createAppJwt(appId: string, privateKey: string): Promise<string> {
  log('Creating JWT for GitHub App authentication...')

  try {
    const cryptoKey = await importPrivateKey(privateKey)

    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT' }
    const payload = {
      iat: now - 60, // Issued 60 seconds ago (clock skew)
      exp: now + 600, // Expires in 10 minutes
      iss: appId,
    }

    const headerB64 = base64UrlEncode(JSON.stringify(header))
    const payloadB64 = base64UrlEncode(JSON.stringify(payload))
    const unsignedToken = `${headerB64}.${payloadB64}`

    const signature = await webcrypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      Buffer.from(unsignedToken)
    )

    const jwt = `${unsignedToken}.${base64UrlEncode(Buffer.from(signature))}`
    log('JWT created successfully')
    return jwt
  } catch (error) {
    log(`Failed to create JWT: ${error}`, 'error')
    throw error
  }
}

/**
 * Get GitHub App installation access token.
 * Returns cached token if valid, otherwise requests new one.
 */
async function getInstallationToken(): Promise<string | null> {
  const { GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY } = CONFIG

  if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID || !GITHUB_APP_PRIVATE_KEY) {
    return null
  }

  // Check cache
  if (cachedInstallationToken && cachedInstallationToken.expiresAt > Date.now()) {
    log('Using cached GitHub App installation token')
    return cachedInstallationToken.token
  }

  try {
    const jwt = await createAppJwt(GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY)

    const response = await fetch(
      `https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'Skillsmith-Import/1.0',
        },
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      log(`Failed to get installation token: ${response.status} - ${errorText}`, 'error')
      return null
    }

    const data = (await response.json()) as { token: string; expires_at: string }

    // Cache the token (expire 5 minutes early for safety)
    cachedInstallationToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime() - 5 * 60 * 1000,
    }

    log('GitHub App installation token obtained successfully')
    return data.token
  } catch (error) {
    log(`Error getting installation token: ${error}`, 'error')
    return null
  }
}

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

/**
 * Get GitHub API headers.
 * Tries GitHub App authentication first (5K req/hr), then falls back to PAT.
 */
export async function getGitHubHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Skillsmith-Import/1.0',
  }

  // Try GitHub App authentication first
  const installationToken = await getInstallationToken()
  if (installationToken) {
    headers['Authorization'] = `Bearer ${installationToken}`
    return headers
  }

  // Fall back to PAT
  if (CONFIG.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${CONFIG.GITHUB_TOKEN}`
  }

  return headers
}

// ============================================================================
// Rate Limit Status Functions
// ============================================================================

/**
 * Get current rate limit status from GitHub API.
 * Returns structured data for monitoring.
 */
// eslint-disable-next-line prefer-const
getRateLimitStatus = async function (): Promise<RateLimitStatus> {
  try {
    const response = await fetch(`${CONFIG.GITHUB_API_URL}/rate_limit`, {
      headers: await getGitHubHeaders(),
    })

    if (!response.ok) {
      return { core: null, search: null }
    }

    const data = (await response.json()) as {
      resources?: { search?: { remaining: number; limit: number; reset: number; used: number } }
      rate?: { remaining: number; limit: number; reset: number; used: number }
    }

    const search = data.resources?.search
    const core = data.rate

    return {
      core: core
        ? {
            remaining: core.remaining,
            limit: core.limit,
            resetTime: new Date(core.reset * 1000),
            used: core.used,
          }
        : null,
      search: search
        ? {
            remaining: search.remaining,
            limit: search.limit,
            resetTime: new Date(search.reset * 1000),
            used: search.used,
          }
        : null,
    }
  } catch {
    return { core: null, search: null }
  }
}

// Export the function
export { getRateLimitStatus }

/**
 * Initialize rate limit tracking at the start of an import.
 */
export async function initRateLimitTracking(): Promise<void> {
  const status = await getRateLimitStatus()
  _rateLimitTracker.startCore = status.core?.remaining ?? 0
  _rateLimitTracker.startSearch = status.search?.remaining ?? 0
  _rateLimitTracker.currentCore = _rateLimitTracker.startCore
  _rateLimitTracker.currentSearch = _rateLimitTracker.startSearch
  log('Rate limit tracking initialized')
}

/**
 * Display a summary of rate limit usage during the import session.
 */
export async function displayRateLimitSummary(): Promise<void> {
  const status = await getRateLimitStatus()

  log('')
  log('=== Rate Limit Usage Summary ===')

  if (status.search) {
    const searchUsed = _rateLimitTracker.startSearch - status.search.remaining
    log(`Search API:`)
    log(`  Requests used this session: ${searchUsed}`)
    log(`  Remaining: ${status.search.remaining}/${status.search.limit}`)
    log(`  Resets at: ${status.search.resetTime.toISOString()}`)
  }

  if (status.core) {
    const coreUsed = _rateLimitTracker.startCore - status.core.remaining
    log(`Core API:`)
    log(`  Requests used this session: ${coreUsed}`)
    log(`  Remaining: ${status.core.remaining}/${status.core.limit}`)
    log(`  Resets at: ${status.core.resetTime.toISOString()}`)
  }

  log('================================')
}

/** Check and display GitHub rate limit status */
export async function checkRateLimit(): Promise<void> {
  try {
    const response = await fetch(`${CONFIG.GITHUB_API_URL}/rate_limit`, {
      headers: await getGitHubHeaders(),
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
      const response = await fetchWithRetry(url, { headers: await getGitHubHeaders() })

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

      // Display rate limit status from response headers (lightweight)
      displayRateLimitFromHeaders(response, 'Search API')

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
