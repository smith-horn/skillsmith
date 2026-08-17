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

import { generateContentHash, type EdgeScanResult } from './_shared/security-scanner-edge.ts'

import { parseFrontmatter } from './frontmatter-parser.ts'

// SMI-4846 + SMI-4858: helpers in skill-processor.helpers.ts (keeps this file ≤500 lines).
import { type SkillMdValidationOptions } from './skill-processor.helpers.ts'
export * from './skill-processor.helpers.ts'

// SMI-5436 Wave 0+2: security helpers extracted to keep this file ≤500 lines.
// SMI-5879 PR-2192a: enumerate/fetch/merge helpers extracted further into
// scanSkillBundle (skill-processor.security.ts) — see the call site below.
import {
  readResponseWithLimit,
  scanSkillBundle,
  type MergedEdgeScanResult,
} from './skill-processor.security.ts'
export { buildQuarantineReason, buildMergedQuarantineReason } from './skill-processor.security.ts'

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
  // SMI-5849: SHA-256 of the fetched SKILL.md content, computed independent of
  // whether a security scan ran.
  contentHash?: string
  /** SMI-2272: Security scan result */
  securityScan?: EdgeScanResult
  /** SMI-5436 Wave 2: merged scan (SKILL.md + sibling files); present when siblings were fetched */
  mergedSecurityScan?: MergedEdgeScanResult
  /**
   * SMI-6033 Wave 2 (Gap 8): whether `scanSkillBundle`'s file selection fully
   * covered every candidate file. `incomplete: true` when the extended
   * sibling-file selection hit its count cap, a candidate exceeded the size
   * cap, a transient sibling fetch failure occurred, the Trees API fetch
   * itself failed, GitHub reported the tree response `truncated: true`, or
   * this run's Trees-fetch budget was exhausted before this repo's tree
   * could be fetched. A clean 404 (file confirmed absent) does NOT count.
   * `note` is a '; '-joined machine-readable cause token, or `null` when complete.
   */
  scanCoverage?: { incomplete: boolean; note: string | null }
}

/** Default minimum content length for SKILL.md */
export const DEFAULT_MIN_CONTENT_LENGTH = 100

/**
 * SMI-4651: Quality-score floor that once distinguished the two `curated`
 * paths (hand-curated HIGH_TRUST_AUTHORS vs auto-vendor).
 *
 * SMI-2402: **Vestigial** — the banded model floors every `curated` skill at
 * the `curated` band floor (0.70) and spreads within the band by intrinsic
 * quality. `repositoryToSkill` no longer applies this floor. The constant is
 * retained (it documents historical intent and is referenced by the
 * `repositoryToSkill` matrix test); removal is a separate cleanup.
 */
export const VENDOR_VERIFIED_FLOOR = 0.8

/**
 * Validate SKILL.md content and extract metadata.
 * SMI-4852: `telemetry` is required so Hard Rule 1 (every GitHub fetch wrapped
 * by `withRateLimitTracking`) is mechanically verifiable via grep. Fetch uses
 * `_throwOnRateLimit:false` — 403/429 surface as `{valid:false}`, not throw.
 * SMI-6033 Wave 1 (Gap 7): `options.typosquatReferenceNames` is optional and
 * additive — build it ONCE per indexer batch run (`typosquat-reference.ts`)
 * and pass it down; omitted, this function's behavior is unchanged. It rides
 * on `options` (not a positional param) so every discovery call site forwards
 * it automatically — see `SkillMdValidationOptions`.
 */
export async function validateSkillMd(
  owner: string,
  repo: string,
  branch: string,
  telemetry: RateLimitTelemetry,
  skillPath?: string,
  options: SkillMdValidationOptions = {}
): Promise<SkillMdValidation> {
  const strictValidation = options.strictValidation ?? true
  const minContentLength = options.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH
  const typosquatReferenceNames = options.typosquatReferenceNames

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

    // SMI-5849: hash the content as soon as it's confirmed non-empty, independent
    // of whether the security scan below succeeds — content_hash must never be
    // NULL just because a downstream gate failed.
    const contentHash = await generateContentHash(content)

    // Quality gate 2: Minimum length
    if (content.length < minContentLength) {
      errors.push(`SKILL.md too short (${content.length} chars, minimum ${minContentLength})`)
    }

    // Quality gate 4 parse hoisted above gate 3: the frontmatter `name` is the
    // authoritative skill title, so gate 3 must consult it before rejecting.
    const frontmatter = parseFrontmatter(content)

    // SMI-4529: Quality gate 3 — accept a heading at ANY level (`#`..`######`)
    // OR a non-empty frontmatter `name`. The prior `/^#\s+.+/m` regex demanded
    // a level-1 `# H1` and ignored frontmatter, dropping valid `##`-only and
    // frontmatter-`name`-only SKILL.md files across every author.
    const hasHeading = /^#{1,6}\s+.+/m.test(content)
    const hasFrontmatterName =
      typeof frontmatter?.name === 'string' && frontmatter.name.trim().length > 0
    if (!hasHeading && !hasFrontmatterName) {
      errors.push('SKILL.md must contain a heading or a frontmatter "name" field')
    }

    // Quality gate 4: Frontmatter validation (if present or strict mode)

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

    // SMI-5879 PR-2192a: primary scan + sibling enumerate -> fetch -> scan ->
    // merge moved into scanSkillBundle (skill-processor.security.ts) so the
    // pre-merge simulator (Wave 3) can call the SAME function production uses.
    // SMI-6033 Wave 1 (Gap 7): candidate name for the typosquat check prefers
    // the frontmatter-declared name (what actually ships as skills.name),
    // falling back to the GitHub repo name when frontmatter has none.
    const typosquatCandidateName = metadata?.name?.trim() || repo
    const { securityScan, mergedSecurityScan, scanCoverage } = await scanSkillBundle(
      owner,
      repo,
      branch,
      skillPath,
      content,
      telemetry,
      undefined,
      typosquatReferenceNames
        ? { candidateName: typosquatCandidateName, referenceNames: typosquatReferenceNames }
        : undefined
    )

    return {
      valid: errors.length === 0,
      errors,
      metadata,
      content, // Store content for hash tracking
      contentHash, // SMI-5849: independent of securityScan
      securityScan, // Include security scan results
      mergedSecurityScan,
      scanCoverage, // SMI-6033 Wave 2 (Gap 8): partial-scan observability
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
 * SMI-6033 Wave 1 (Gap 7): `options.typosquatReferenceNames` threads through
 * to `validateSkillMd` — optional and additive, see that function's header.
 */
export async function checkSkillMdExists(
  owner: string,
  repo: string,
  branch: string,
  cache: Map<string, SkillMdValidation>,
  telemetry: RateLimitTelemetry,
  skillPath?: string,
  options: SkillMdValidationOptions = {}
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

// SMI-6033 Wave 2 (Gap 8) adversarial-review fix: repositoryToSkill (+ its
// sanitizeSkillName helper) extracted to skill-processor.repository-mapping.ts
// to keep this file under the 500-line gate. Public API unchanged.
export { sanitizeSkillName, repositoryToSkill } from './skill-processor.repository-mapping.ts'
