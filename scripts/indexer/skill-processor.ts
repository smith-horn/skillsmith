/**
 * Skill processing, validation, and conversion
 * @module scripts/indexer/skill-processor
 *
 * SMI-4852: Node sibling of `supabase/functions/indexer/skill-processor.ts`.
 * Diffs from the Deno parent: `Deno.env.get` → `process.env`; the lone
 * `fetch()` in `validateSkillMd` routes through `withRateLimitTracking` (Hard
 * Rule 1) — `telemetry` is now an explicit parameter on `validateSkillMd` and
 * `checkSkillMdExists`. Parity drift guarded by parity.test.ts.
 */

import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { MAX_SKILL_CONTENT_SIZE } from './_shared/constants.ts'
import {
  validateGitHubParams,
  isValidBranchName,
  sanitizeForLog,
  ValidationError,
} from './_shared/validation.ts'

import {
  scanSkillContent,
  shouldQuarantine,
  summarizeFindings,
  QUARANTINE_THRESHOLD,
  type EdgeScanResult,
} from './_shared/security-scanner-edge.ts'

import { parseFrontmatter } from './frontmatter-parser.ts'
import type { HighTrustAuthor } from './high-trust-authors.ts'
import type { GitHubRepository } from './topic-search.ts'

// SMI-4846: skip-gate helpers extracted to skill-processor.helpers.ts so this
// file stays ≤ 500 lines (audit:standards gate). Re-exported here for existing
// import sites — call sites in indexer-runners.ts import from .helpers directly.
export * from './skill-processor.helpers.ts'

/**
 * SKILL.md validation result
 */
export interface SkillMdValidation {
  valid: boolean
  errors: string[]
  metadata?: {
    name?: string
    description?: string
    author?: string
    triggers?: string[]
    /** SMI-2397: Skill-level tags from SKILL.md frontmatter (tags/keywords fields) */
    frontmatterTags?: string[]
    /** SMI-2397: Skill-level category from SKILL.md frontmatter */
    frontmatterCategory?: string
  }
  /** SMI-2272: Raw SKILL.md content for security scanning */
  content?: string
  /** SMI-2272: Security scan result */
  securityScan?: EdgeScanResult
}

/** Default minimum content length for SKILL.md */
export const DEFAULT_MIN_CONTENT_LENGTH = 100

/**
 * SMI-4651: Quality-score floor when Branch B promotes a repo to `curated`
 * via GitHub-verified vendor org. Two `curated` paths exist: hand-curated
 * HIGH_TRUST_AUTHORS (~0.90) vs auto-vendor (this floor, 0.80). The 0.10 gap
 * distinguishes them without splitting the tier — see plan §A Risk table.
 */
export const VENDOR_VERIFIED_FLOOR = 0.8

/**
 * SMI-2406: Sanitize skill name from frontmatter for use as identifier.
 * Converts to lowercase, replaces spaces/underscores with hyphens,
 * strips non-alphanumeric characters (except hyphens), and collapses
 * multiple hyphens.
 */
export function sanitizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces/underscores -> hyphens
    .replace(/[^a-z0-9-]/g, '') // strip special chars
    .replace(/-{2,}/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
}

/**
 * SMI-2384: Build a human-readable quarantine reason for authors.
 *
 * When a skill is quarantined, this produces a message summarizing:
 * - Number of findings and risk score
 * - Types of patterns found with line numbers (max 5)
 * - Appeal URL with the skill identifier pre-filled
 */
export function buildQuarantineReason(
  scanResult: EdgeScanResult,
  owner: string,
  name: string
): string {
  if (!shouldQuarantine(scanResult)) {
    return ''
  }

  const findingSummary = summarizeFindings(scanResult.findings)
  const appealUrl = `https://skillsmith.app/contact?topic=quarantine&skill=${encodeURIComponent(`${owner}/${name}`)}`

  return `Security scan detected ${scanResult.findings.length} finding${scanResult.findings.length === 1 ? '' : 's'} (risk score: ${scanResult.riskScore}/100). ${findingSummary}. Appeal at ${appealUrl}`
}

/**
 * SMI-2283: Read response body with byte-counted limit to prevent memory exhaustion.
 * Streams the body and aborts if the accumulated size exceeds the limit.
 * @throws Error if response body exceeds maxBytes
 */
async function readResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is not readable')
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        reader.cancel()
        throw new Error(`Response body exceeds maximum size of ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const decoder = new TextDecoder()
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}

/**
 * Validate SKILL.md content and extract metadata.
 * SMI-4852: `telemetry` is required so Hard Rule 1 (every GitHub fetch wrapped
 * by `withRateLimitTracking`) is mechanically verifiable via grep. Fetch uses
 * `_throwOnRateLimit:false` — 403/429 surface as `{valid:false}`, not throw.
 */
export async function validateSkillMd(
  owner: string,
  repo: string,
  branch: string,
  telemetry: RateLimitTelemetry,
  skillPath?: string,
  options: { strictValidation?: boolean; minContentLength?: number } = {}
): Promise<SkillMdValidation> {
  const strictValidation = options.strictValidation ?? true
  const minContentLength = options.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH

  const errors: string[] = []
  let metadata: SkillMdValidation['metadata'] = undefined

  try {
    // SMI-2271: Validate parameters before URL construction
    validateGitHubParams(owner, repo, skillPath)

    // SMI-2280: Validate branch name before URL interpolation
    if (!isValidBranchName(branch)) {
      return {
        valid: false,
        errors: [`Invalid branch name: ${sanitizeForLog(branch)}`],
      }
    }

    // Build the URL - skillPath is relative to branch
    const path = skillPath ? `${branch}/${skillPath}/SKILL.md` : `${branch}/SKILL.md`
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${path}`

    const response = await withRateLimitTracking(telemetry, url, {
      headers: await buildGitHubHeaders(),
      _throwOnRateLimit: false,
    })

    if (!response.ok) {
      return {
        valid: false,
        errors: [`SKILL.md not found (HTTP ${response.status})`],
      }
    }

    // SMI-2273: Pre-check Content-Length header to reject oversized files early
    const contentLength = response.headers.get('content-length')
    const parsedContentLength = contentLength ? parseInt(contentLength, 10) : NaN
    if (!isNaN(parsedContentLength) && parsedContentLength > MAX_SKILL_CONTENT_SIZE) {
      return {
        valid: false,
        errors: [
          `SKILL.md too large (${parsedContentLength} bytes, max ${MAX_SKILL_CONTENT_SIZE})`,
        ],
      }
    }

    // SMI-2283: Stream body with byte-counted limit instead of buffering entirely via response.text()
    const content = await readResponseWithLimit(response, MAX_SKILL_CONTENT_SIZE)

    // Quality gate 1: Content exists (not empty)
    if (!content || content.trim().length === 0) {
      errors.push('SKILL.md is empty')
      return { valid: false, errors }
    }

    // Quality gate 2: Minimum length
    if (content.length < minContentLength) {
      errors.push(`SKILL.md too short (${content.length} chars, minimum ${minContentLength})`)
    }

    // Quality gate 3: Has markdown heading
    const hasHeading = /^#\s+.+/m.test(content)
    if (!hasHeading) {
      errors.push('SKILL.md must contain a markdown heading (# Title)')
    }

    // Quality gate 4: Frontmatter validation (if present or strict mode)
    const frontmatter = parseFrontmatter(content)

    if (frontmatter) {
      metadata = {}

      // Extract and validate name
      if (typeof frontmatter.name === 'string' && frontmatter.name.trim()) {
        metadata.name = frontmatter.name.trim()
      } else if (strictValidation) {
        errors.push('Frontmatter missing required "name" field')
      }

      // Extract and validate description
      if (typeof frontmatter.description === 'string') {
        const desc = frontmatter.description.trim()
        if (desc.length >= 20) {
          metadata.description = desc
        } else if (strictValidation) {
          errors.push(`Frontmatter "description" too short (${desc.length} chars, minimum 20)`)
        }
      } else if (strictValidation) {
        errors.push('Frontmatter missing required "description" field')
      }

      // Extract optional author
      if (typeof frontmatter.author === 'string' && frontmatter.author.trim()) {
        metadata.author = frontmatter.author.trim()
      }

      // Extract triggers (may be under 'triggers' or 'trigger_phrases')
      const triggersField = frontmatter.triggers || frontmatter.trigger_phrases
      if (Array.isArray(triggersField)) {
        metadata.triggers = triggersField.filter((t): t is string => typeof t === 'string')
      }

      // SMI-2397: Extract skill-level tags/keywords/category from frontmatter
      const fmTags = frontmatter.tags || frontmatter.keywords
      if (Array.isArray(fmTags)) {
        const skillTags = fmTags.filter((t): t is string => typeof t === 'string')
        metadata.frontmatterTags = skillTags
      }
      if (typeof frontmatter.category === 'string' && frontmatter.category.trim()) {
        metadata.frontmatterCategory = frontmatter.category.trim().toLowerCase()
      }
    } else if (strictValidation) {
      errors.push('SKILL.md missing YAML frontmatter')
    }

    // SMI-2272: Run security scan on SKILL.md content
    const securityScan = await scanSkillContent(content)
    if (!securityScan.passed) {
      console.log(
        `[SecurityScan] ${owner}/${repo}: riskScore=${securityScan.riskScore}, findings=${securityScan.findings.length}`
      )
    }

    return {
      valid: errors.length === 0,
      errors,
      metadata,
      content, // Store content for hash tracking
      securityScan, // Include security scan results
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        valid: false,
        errors: [`Validation failed: ${error.message}`],
      }
    }
    return {
      valid: false,
      errors: [`Failed to fetch SKILL.md: ${error instanceof Error ? error.message : 'Unknown'}`],
    }
  }
}

/**
 * Check if repository has a valid SKILL.md file
 * Uses the new validation system and caches results
 * SMI-2404: Accepts request-scoped cache to avoid shared state across concurrent requests
 * SMI-4852: `telemetry` threads through to `validateSkillMd` (Hard Rule 1).
 */
export async function checkSkillMdExists(
  owner: string,
  repo: string,
  branch: string,
  cache: Map<string, SkillMdValidation>,
  telemetry: RateLimitTelemetry,
  skillPath?: string,
  options: { strictValidation?: boolean; minContentLength?: number } = {}
): Promise<boolean> {
  // Build cache key
  const cacheKey = `${owner}/${repo}/${branch}${skillPath ? `/${skillPath}` : ''}`

  // Check cache first
  const cached = cache.get(cacheKey)
  if (cached !== undefined) {
    return cached.valid
  }

  // SMI-2388: Removed branch-splitting heuristic that corrupted branch names
  const validation = await validateSkillMd(owner, repo, branch, telemetry, skillPath, options)

  // Cache the result
  cache.set(cacheKey, validation)

  // Log validation errors for debugging
  if (!validation.valid && validation.errors.length > 0) {
    console.log(`SKILL.md validation failed for ${cacheKey}: ${validation.errors.join(', ')}`)
  }

  return validation.valid
}

/**
 * Get cached validation result for a skill
 * SMI-2404: Accepts request-scoped cache to avoid shared state across concurrent requests
 */
export function getCachedValidation(
  owner: string,
  repo: string,
  branch: string,
  cache: Map<string, SkillMdValidation>,
  skillPath?: string
): SkillMdValidation | undefined {
  const cacheKey = `${owner}/${repo}/${branch}${skillPath ? `/${skillPath}` : ''}`
  return cache.get(cacheKey)
}

/**
 * Convert repository to skill data
 * Uses cached SKILL.md validation metadata if available
 * SMI-2272: Now includes security scan results
 * SMI-2384: Now includes quarantine_reason for author visibility
 */
export function repositoryToSkill(
  repo: GitHubRepository,
  highTrustAuthor?: HighTrustAuthor,
  validation?: SkillMdValidation,
  // SMI-4651: tri-state. `true` → owner is a GitHub-verified vendor org and
  // Branch B should promote to `curated` with `quality_score >= VENDOR_VERIFIED_FLOOR`.
  // `false`/`undefined` → preserve existing behavior (stars heuristic).
  // Last-positional so existing call sites compile without change.
  orgIsVerified?: boolean
): Record<string, unknown> {
  const validationMetadata = validation?.metadata
  let qualityScore: number
  let trustTier: 'verified' | 'curated' | 'community' | 'experimental' | 'unknown'

  if (highTrustAuthor) {
    qualityScore = highTrustAuthor.baseQualityScore
    trustTier = highTrustAuthor.trustTier || 'verified'
    if (process.env.SKILLSMITH_LOG_QUALITY_SCORE === 'true') {
      console.log(
        `[QualityScore] HIGH-TRUST: ${repo.fullName} author=${highTrustAuthor.owner} -> score=${qualityScore}`
      )
    }
  } else {
    const flagRaw = process.env.SKILLSMITH_LOG_QUALITY_SCORE
    const useLogScale = flagRaw?.trim().toLowerCase() === 'true'
    if (useLogScale) {
      console.log(`[QualityScore] Flag raw="${flagRaw}" parsed=${useLogScale}`)
    }

    let starScore: number
    let forkScore: number

    if (useLogScale) {
      starScore = Math.min(Math.log10(repo.stars + 1) * 15, 50)
      forkScore = Math.min(Math.log10(repo.forks + 1) * 10, 25)
    } else {
      starScore = Math.min(repo.stars / 10, 50)
      forkScore = Math.min(repo.forks / 5, 25)
    }
    qualityScore = (starScore + forkScore + 25) / 100
    if (useLogScale) {
      console.log(
        `[QualityScore] COMMUNITY: ${repo.fullName} stars=${repo.stars} forks=${repo.forks} -> score=${qualityScore.toFixed(4)}`
      )
    }

    trustTier = 'unknown'
    if (repo.topics.includes('claude-code-official')) {
      trustTier = 'verified'
    } else if (orgIsVerified === true) {
      // SMI-4651: GitHub-verified vendor org (Stripe/Notion/Atlassian/Figma/
      // Canva/Zapier/Cloudflare/etc.) without an explicit HIGH_TRUST_AUTHORS
      // entry. Promote to `curated` and floor the auto-derived qualityScore
      // at VENDOR_VERIFIED_FLOOR so a low-stars vendor repo doesn't outrank
      // editorially curated peers. See VENDOR_VERIFIED_FLOOR doc for the
      // dual-path (0.90 hand-curated vs 0.80 auto-vendor) rationale.
      trustTier = 'curated'
      qualityScore = Math.max(qualityScore, VENDOR_VERIFIED_FLOOR)
    } else if (repo.stars >= 50) {
      trustTier = 'community'
    } else if (repo.stars >= 5) {
      trustTier = 'experimental'
    }
  }

  const rawName = validationMetadata?.name || repo.name
  const name = sanitizeSkillName(rawName)
  const description =
    validationMetadata?.description || repo.description || `${name} — a Claude Code skill`

  let tags = [...repo.topics]
  if (validationMetadata?.triggers && validationMetadata.triggers.length > 0) {
    const triggerTags = validationMetadata.triggers.map((t) => t.toLowerCase().replace(/\s+/g, '-'))
    tags = [...new Set([...tags, ...triggerTags])]
  }
  if (validationMetadata?.frontmatterTags && validationMetadata.frontmatterTags.length > 0) {
    const fmTags = validationMetadata.frontmatterTags.map((t) =>
      t.toLowerCase().replace(/\s+/g, '-')
    )
    tags = [...new Set([...tags, ...fmTags])]
  }
  if (validationMetadata?.frontmatterCategory) {
    tags = [...new Set([...tags, validationMetadata.frontmatterCategory])]
  }

  const securityScan = validation?.securityScan
  const quarantined = securityScan ? shouldQuarantine(securityScan) : false

  const quarantineReason = securityScan
    ? buildQuarantineReason(securityScan, repo.owner, name)
    : null

  if (quarantined) {
    console.log(
      `[SecurityScan] QUARANTINE: ${repo.fullName} riskScore=${securityScan?.riskScore} threshold=${QUARANTINE_THRESHOLD}`
    )
  }

  // SMI-2723: Only set repo_url when the skill is installable (SKILL.md confirmed present).
  // Skills that passed discovery but failed SKILL.md validation (installable: false) must
  // have repo_url = null so they appear as discovery-only entries rather than broken installs.
  const repoUrl = repo.installable ? repo.url : null
  if (!repo.installable) {
    console.log(
      `[IndexerHardening] SMI-2723: ${repo.fullName} has no valid SKILL.md — setting repo_url=null (discovery-only)`
    )
  }

  return {
    name,
    description,
    author: validationMetadata?.author || repo.owner,
    publisher: repo.owner,
    repo_url: repoUrl,
    quality_score: qualityScore,
    trust_tier: trustTier,
    tags,
    stars: repo.stars,
    installable: repo.installable,
    indexed_at: new Date().toISOString(),
    content_hash: securityScan?.contentHash ?? null,
    last_scanned_at: securityScan?.scannedAt ?? null,
    security_score: securityScan?.riskScore ?? null,
    security_findings: securityScan?.findings ?? [],
    quarantined,
    quarantine_reason: quarantineReason || null,
    last_seen_at: new Date().toISOString(),
    // SMI-4846: Skip-gate column populated on every full-fetch upsert. Future
    // runs with matching repo.updatedAt bypass validateSkillMd entirely.
    repo_updated_at: repo.updatedAt ?? null,
    // SMI-2663: Cross-ecosystem discovery columns (migration 055)
    source_format: 'skill-md', // Phase 1: always skill-md; Phase 2 will detect format
    license: repo.license ?? null,
    // SMI-4387: Default to '' (empty string, explicit root marker) instead of null.
    // Migration 055's CHECK constraint allows empty string; new rows never land as NULL.
    // Legacy NULLs remain as-is (cohort marker for SMI-4385 before/after yield measurement).
    skill_path: repo.skillPath ?? '',
  }
}
