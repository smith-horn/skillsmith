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
 * - maxPages: Max pages per topic (default: 5, max: 10, 7+ may timeout)
 * - dryRun: If true, don't write to database (default: false)
 *
 * Authentication:
 * - Supports GITHUB_TOKEN (PAT) or GitHub App authentication
 * - GitHub App requires: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
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

import {
  HIGH_TRUST_AUTHORS,
  shouldExcludeSkill,
  type HighTrustAuthor,
} from './high-trust-authors.ts'

// Cache for GitHub App installation token
let cachedInstallationToken: { token: string; expiresAt: number } | null = null

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
  installable: boolean
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
 * Check if repository has a SKILL.md file at root
 */
async function checkSkillMdExists(owner: string, repo: string, branch: string): Promise<boolean> {
  try {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/SKILL.md`
    const response = await fetch(url, {
      method: 'HEAD',
      headers: await buildGitHubHeaders(),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Normalize a PEM key string that may have lost newlines in env var storage
 * Also handles base64-encoded PEM keys
 * Reconstructs proper PEM format with 64-character lines
 */
function normalizePemKey(key: string): string {
  let normalized = key

  // Check if the key is base64-encoded (doesn't start with -----)
  // Base64 of "-----BEGIN" starts with "LS0tLS1CRUdJTg"
  if (!normalized.startsWith('-----') && normalized.startsWith('LS0tLS')) {
    try {
      // Decode from base64
      normalized = atob(normalized)
      console.log('Decoded base64-encoded PEM key')
    } catch {
      console.log('Key appears to be base64 but failed to decode')
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

    // Split base64 into 64-character lines
    const lines = base64.match(/.{1,64}/g) || []
    normalized = `${headerMatch}\n${lines.join('\n')}\n${footerMatch}`
  }

  return normalized
}

/**
 * Import a PEM private key for use with Web Crypto
 * Handles both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY) formats
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = normalizePemKey(pem)
  const isPkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----')

  // Extract base64 content
  const base64 = normalized
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s/g, '')

  const binaryDer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

  if (isPkcs1) {
    // PKCS#1 to PKCS#8 conversion
    // PKCS#8 wrapper: SEQUENCE { version, algorithmIdentifier, privateKey }
    const pkcs8Header = new Uint8Array([
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

    // Calculate total length
    const totalLen = pkcs8Header.length - 4 + binaryDer.length

    // Create PKCS#8 structure
    const pkcs8 = new Uint8Array(4 + totalLen)
    pkcs8.set(pkcs8Header)
    pkcs8.set(binaryDer, pkcs8Header.length)

    // Set outer SEQUENCE length (total - 4 bytes for header)
    pkcs8[2] = (totalLen >> 8) & 0xff
    pkcs8[3] = totalLen & 0xff

    // Set OCTET STRING length
    pkcs8[pkcs8Header.length - 2] = (binaryDer.length >> 8) & 0xff
    pkcs8[pkcs8Header.length - 1] = binaryDer.length & 0xff

    return await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )
  } else {
    // PKCS#8 format - import directly
    return await crypto.subtle.importKey(
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
function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Create a JWT for GitHub App authentication
 */
async function createAppJwt(appId: string, privateKey: string): Promise<string> {
  console.log('Creating JWT for GitHub App:', appId)
  console.log('Key length:', privateKey.length, 'chars')

  try {
    const cryptoKey = await importPrivateKey(privateKey)
    console.log('Private key imported successfully')

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

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(unsignedToken)
    )

    const jwt = `${unsignedToken}.${base64UrlEncode(signature)}`
    console.log('JWT created successfully')
    return jwt
  } catch (error) {
    console.error('Failed to create JWT:', error)
    throw error
  }
}

/**
 * Get GitHub App installation access token
 */
async function getInstallationToken(): Promise<string | null> {
  const appId = Deno.env.get('GITHUB_APP_ID')
  const installationId = Deno.env.get('GITHUB_APP_INSTALLATION_ID')
  const privateKey = Deno.env.get('GITHUB_APP_PRIVATE_KEY')

  if (!appId || !installationId || !privateKey) {
    return null
  }

  // Check cache
  if (cachedInstallationToken && cachedInstallationToken.expiresAt > Date.now()) {
    return cachedInstallationToken.token
  }

  try {
    const jwt = await createAppJwt(appId, privateKey)

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'skillsmith-indexer/1.0',
        },
      }
    )

    if (!response.ok) {
      console.error('Failed to get installation token:', response.status, await response.text())
      return null
    }

    const data = (await response.json()) as { token: string; expires_at: string }

    // Cache the token (expire 5 minutes early for safety)
    cachedInstallationToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime() - 5 * 60 * 1000,
    }

    return data.token
  } catch (error) {
    console.error('Error getting installation token:', error)
    return null
  }
}

/**
 * Build GitHub API headers
 * Tries GitHub App auth first, then falls back to GITHUB_TOKEN (PAT)
 */
async function buildGitHubHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'skillsmith-indexer/1.0',
  }

  // Try GitHub App authentication first
  const installationToken = await getInstallationToken()
  if (installationToken) {
    headers['Authorization'] = `Bearer ${installationToken}`
    return headers
  }

  // Fall back to PAT
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
      headers: await buildGitHubHeaders(),
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
      installable: false, // Will be checked separately
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
function repositoryToSkill(
  repo: GitHubRepository,
  highTrustAuthor?: HighTrustAuthor
): Record<string, unknown> {
  let qualityScore: number
  let trustTier: 'verified' | 'community' | 'experimental' | 'unknown'

  if (highTrustAuthor) {
    // High-trust authors get verified tier and configured quality score
    qualityScore = highTrustAuthor.baseQualityScore
    trustTier = 'verified'
  } else {
    // Calculate quality score based on stars and activity
    const starScore = Math.min(repo.stars / 10, 50)
    const forkScore = Math.min(repo.forks / 5, 25)
    qualityScore = (starScore + forkScore + 25) / 100 // Normalize to 0-1

    // Determine trust tier
    trustTier = 'unknown'
    if (repo.topics.includes('claude-code-official')) {
      trustTier = 'verified'
    } else if (repo.stars >= 50) {
      trustTier = 'community'
    } else if (repo.stars >= 5) {
      trustTier = 'experimental'
    }
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
    installable: repo.installable,
    indexed_at: new Date().toISOString(),
  }
}

/**
 * Fetch skills from a high-trust author's repository
 * Scans subdirectories for SKILL.md files
 */
async function indexHighTrustRepository(
  author: HighTrustAuthor
): Promise<{ skills: GitHubRepository[]; errors: string[] }> {
  const skills: GitHubRepository[] = []
  const errors: string[] = []

  try {
    // Get repository info
    const repoUrl = `https://api.github.com/repos/${author.owner}/${author.repo}`
    const repoResponse = await fetch(repoUrl, {
      headers: await buildGitHubHeaders(),
    })

    if (!repoResponse.ok) {
      errors.push(`Failed to fetch ${author.owner}/${author.repo}: ${repoResponse.status}`)
      return { skills, errors }
    }

    const repoData = (await repoResponse.json()) as {
      default_branch: string
      stargazers_count: number
      forks_count: number
      description: string | null
      topics: string[]
    }

    // Get repository contents - check both root and skills/ subdirectory
    // Most high-trust repos have skills in a 'skills/' subdirectory
    const pathsToCheck = ['', 'skills']

    for (const basePath of pathsToCheck) {
      const contentsUrl = basePath
        ? `https://api.github.com/repos/${author.owner}/${author.repo}/contents/${basePath}`
        : `https://api.github.com/repos/${author.owner}/${author.repo}/contents`

      const contentsResponse = await fetch(contentsUrl, {
        headers: await buildGitHubHeaders(),
      })

      if (!contentsResponse.ok) {
        // skills/ subdirectory might not exist, that's OK
        if (basePath && contentsResponse.status === 404) {
          continue
        }
        errors.push(
          `Failed to fetch contents for ${author.owner}/${author.repo}/${basePath}: ${contentsResponse.status}`
        )
        continue
      }

      const contents = (await contentsResponse.json()) as Array<{
        name: string
        type: string
        path: string
      }>

      // Check each directory for SKILL.md
      for (const item of contents) {
        if (item.type !== 'dir') continue

        // Skip common non-skill directories
        if (
          [
            '.github',
            '.claude-plugin',
            'scripts',
            'assets',
            'agents',
            'apps',
            'packages',
            'spec',
            'template',
          ].includes(item.name)
        ) {
          continue
        }

        // Check if this skill should be excluded
        if (shouldExcludeSkill(author, item.name)) {
          console.log(`Skipping excluded skill: ${author.owner}/${author.repo}/${item.name}`)
          continue
        }

        // Build the path to check for SKILL.md
        const skillPath = basePath ? `${basePath}/${item.name}` : item.name

        // Check if SKILL.md exists in this directory
        const hasSkill = await checkSkillMdExists(
          author.owner,
          author.repo,
          `${repoData.default_branch}/${skillPath}`
        )

        if (hasSkill) {
          skills.push({
            owner: author.owner,
            name: item.name,
            fullName: `${author.owner}/${item.name}`,
            description: `${item.name} skill from ${author.owner}`,
            url: `https://github.com/${author.owner}/${author.repo}/tree/${repoData.default_branch}/${skillPath}`,
            stars: repoData.stargazers_count,
            forks: repoData.forks_count,
            topics: repoData.topics || [],
            updatedAt: new Date().toISOString(),
            defaultBranch: repoData.default_branch,
            installable: true,
          })
        }

        await delay(50) // Rate limiting
      }
    }

    // Also check for root-level SKILL.md (single-skill repos)
    const hasRootSkill = await checkSkillMdExists(
      author.owner,
      author.repo,
      repoData.default_branch
    )

    if (hasRootSkill && !shouldExcludeSkill(author, author.repo)) {
      skills.push({
        owner: author.owner,
        name: author.repo,
        fullName: `${author.owner}/${author.repo}`,
        description: repoData.description || `${author.repo} skill`,
        url: `https://github.com/${author.owner}/${author.repo}`,
        stars: repoData.stargazers_count,
        forks: repoData.forks_count,
        topics: repoData.topics || [],
        updatedAt: new Date().toISOString(),
        defaultBranch: repoData.default_branch,
        installable: true,
      })
    }
  } catch (error) {
    errors.push(
      `Error indexing ${author.owner}/${author.repo}: ${error instanceof Error ? error.message : 'Unknown'}`
    )
  }

  return { skills, errors }
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
    // Default to 5 pages - optimal for Edge Function timeout (150s)
    // 7+ pages causes timeout, see SMI-1413 for test results
    const maxPages = Math.min(body.maxPages || 5, 10)
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
    const highTrustSkillMap = new Map<string, HighTrustAuthor>() // Track which skills came from high-trust authors

    // Phase 1: Index high-trust authors first (verified tier)
    console.log(`Indexing ${HIGH_TRUST_AUTHORS.length} high-trust authors...`)
    for (const author of HIGH_TRUST_AUTHORS) {
      const { skills, errors: authorErrors } = await indexHighTrustRepository(author)

      for (const skill of skills) {
        if (!seenUrls.has(skill.url)) {
          seenUrls.add(skill.url)
          repositories.push(skill)
          highTrustSkillMap.set(skill.url, author)
        }
      }

      result.errors.push(...authorErrors)
      await delay(GITHUB_API_DELAY)
    }

    console.log(`Found ${highTrustSkillMap.size} skills from high-trust authors`)

    // Phase 2: Fetch repositories from GitHub topic search
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
            // Check if SKILL.md exists (determines installability)
            repo.installable = await checkSkillMdExists(repo.owner, repo.name, repo.defaultBranch)
            repositories.push(repo)
            await delay(50) // Small delay between SKILL.md checks
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
          // Check if this skill came from a high-trust author
          const highTrustAuthor = highTrustSkillMap.get(repo.url)
          const skillData = repositoryToSkill(repo, highTrustAuthor)

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
