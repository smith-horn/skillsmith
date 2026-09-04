/**
 * @fileoverview Install Tool Helper Functions
 * @module @skillsmith/mcp-server/tools/install.helpers
 */

import type { ToolContext } from '../context.js'
// SMI-2171: Import parseRepoUrl from @skillsmith/core for shared use
import {
  parseRepoUrl,
  QuarantineRepository,
  SkillsmithError,
  ErrorCodes,
  type ParsedRepoUrl,
} from '@skillsmith/core'
import { CANONICAL_CLIENT, CLIENT_DISPLAY_LABELS, type ClientId } from '@skillsmith/core/install'
import { validateTrustTier, type ParsedSkillId, type RegistrySkillInfo } from './install.types.js'

// Re-export for backward compatibility
export { parseRepoUrl, type ParsedRepoUrl }

// ============================================================================
// Manifest Locking + Operations (SMI-6274 Wave 4 round 2, 500-line file cap)
// Split to install.helpers.manifest.ts per governance code review
// ============================================================================

// Re-export manifest helpers from dedicated module
export {
  acquireManifestLock,
  releaseManifestLock,
  loadManifest,
  saveManifest,
  updateManifestSafely,
} from './install.helpers.manifest.js'

// ============================================================================
// Parsing Functions
// ============================================================================

// parseRepoUrl is now imported from @skillsmith/core (SMI-2171)
// and re-exported above for backward compatibility

/**
 * Parse skill ID or URL to get components
 * SMI-1491: Added isRegistryId flag to detect registry skill IDs vs direct GitHub URLs
 */
export function parseSkillId(input: string): ParsedSkillId {
  // Handle full GitHub URLs - not registry IDs
  if (input.startsWith('https://github.com/')) {
    const url = new URL(input)
    const parts = url.pathname.split('/').filter(Boolean)
    return {
      owner: parts[0],
      repo: parts[1],
      path: parts.slice(2).join('/') || '',
      isRegistryId: false,
    }
  }

  // Handle slash-separated IDs
  if (input.includes('/')) {
    const parts = input.split('/')

    // 2-part format: Could be registry ID (author/skill-name) - needs lookup
    if (parts.length === 2) {
      return {
        owner: parts[0],
        repo: parts[1],
        path: '',
        isRegistryId: true, // Mark as potential registry ID for lookup
      }
    }

    // 3+ parts: owner/repo/path format (direct GitHub reference)
    return {
      owner: parts[0],
      repo: parts[1],
      path: parts.slice(2).join('/'),
      isRegistryId: false,
    }
  }

  // Handle UUID skill IDs — returned by the search tool, route through registry lookup
  // UUID format: 8-4-4-4-12 hex characters (e.g. "a129e127-a82c-47e5-8bc5-09d7ba2e8734")
  // SMI-2722: UUIDs must route through isRegistryId: true so lookupSkillFromRegistry is called
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (UUID_REGEX.test(input)) {
    return {
      owner: '',
      repo: '',
      path: '',
      isRegistryId: true,
    }
  }

  // Handle skill ID from registry
  throw new Error('Invalid skill ID format: ' + input + '. Use owner/repo or GitHub URL.')
}

// ============================================================================
// Registry Lookup
// ============================================================================

/**
 * Look up skill in registry to get repo_url
 * SMI-1491: Enables install to work with registry IDs like "author/skill-name"
 *
 * Follows API-first pattern: tries live API, falls back to local DB
 *
 * SMI-5896: deliberately NOT folded into core's shared `resolveSkillApiFirst`
 * (used by `get_skill`/`skill_compare`) — three contract differences make that
 * a behavior change, not a refactor: (1) returns `null` rather than throwing
 * SKILL_NOT_FOUND; (2) `null` also covers "registry has it but no repo_url"
 * (discovery-only, SMI-2723) and that case must NOT fall through to a stale
 * local `repoUrl`; (3) it derives the security-relevant `quarantined` flag per
 * branch, which the shared resolver has no concept of — any future
 * consolidation must preserve that gate on both branches (cf. SMI-5447).
 */
export async function lookupSkillFromRegistry(
  skillId: string,
  context: ToolContext,
  options?: {
    /**
     * SMI-6343: invoked when the live call failed specifically because the
     * caller's monthly API quota is exhausted (`ErrorCodes.NETWORK_QUOTA_
     * EXCEEDED`, thrown by `SkillsmithApiClient`'s retry loop on a
     * `monthly_quota_exceeded` 429 body) — lets a batch caller (e.g.
     * `skill_outdated`'s live registry arm) stop issuing further live calls
     * for the rest of its run instead of burning one failed call per
     * remaining skill. The `error` argument is the caught `SkillsmithError`
     * itself — its `.message` already carries the used/limit/tier and the
     * formatted reset-time text (`client.ts`'s quota-error construction),
     * so a caller building a user-facing diagnosis should read `.message`
     * rather than re-deriving reset time from `.details.resetsAt`. Purely
     * additive: this function's existing
     * swallow-every-other-error-and-fall-back-to-local-DB behavior is
     * unchanged, and every existing caller that doesn't pass `options` sees
     * zero behavior change.
     */
    onQuotaExceeded?: (error: unknown) => void
    /**
     * SMI-6343 (pr-reviewer-gate fix): invoked for EVERY caught error
     * (network error, DNS, timeout, quota exceeded — this fires in addition
     * to, not instead of, `onQuotaExceeded` for the quota case), before
     * falling through to the local-DB fallback. This function never
     * rethrows — it always resolves, either to `null` or to a value from
     * the local-DB fallback (which itself never carries a `contentHash`) —
     * so a caller that needs to know "the live attempt failed" cannot infer
     * that from a thrown exception; it never occurs. Without this signal,
     * a caller like `skill_outdated`'s live registry arm has no way to
     * distinguish "the registry genuinely has nothing new" from "the live
     * call broke and we silently got local-DB data (or nothing) instead" —
     * confirmed by a pr-reviewer-gate finding that the prior fix's `try/catch`
     * around this function's call site was dead code for this exact reason.
     */
    onLiveLookupFailed?: (error: unknown) => void
  }
): Promise<RegistrySkillInfo | null> {
  // Try API first (primary data source)
  if (!context.apiClient.isOffline()) {
    try {
      const response = await context.apiClient.getSkill(skillId)
      if (response.data.repo_url) {
        return {
          repoUrl: response.data.repo_url,
          name: response.data.name,
          // SMI-1533: Validate trust tier for security scan configuration
          trustTier: validateTrustTier(response.data.trust_tier),
          // SMI-2383: Pass through quarantine status
          quarantined: response.data.quarantined === true,
          // SMI-3510: Content hash for tamper detection
          contentHash: response.data.content_hash ?? undefined,
        }
      }
      // API found skill but no repo_url - it's seed data
      return null
    } catch (error) {
      if (error instanceof SkillsmithError && error.code === ErrorCodes.NETWORK_QUOTA_EXCEEDED) {
        options?.onQuotaExceeded?.(error)
      }
      options?.onLiveLookupFailed?.(error)
      // API failed, fall through to local DB
    }
  }

  // Fallback: Local database
  const dbSkill = context.skillRepository.findById(skillId)
  if (dbSkill?.repoUrl) {
    // SMI-2437: Check local quarantine table for offline quarantine enforcement
    const quarantineRepo = new QuarantineRepository(context.db)
    const isQuarantined = quarantineRepo.isQuarantined(dbSkill.id || skillId)

    return {
      repoUrl: dbSkill.repoUrl,
      name: dbSkill.name,
      // SMI-1533: Validate trust tier for security scan configuration
      trustTier: validateTrustTier(dbSkill.trustTier),
      // SMI-2437: Pass through quarantine status from local DB
      quarantined: isQuarantined,
    }
  }

  return null
}

// ============================================================================
// GitHub Fetching
// ============================================================================

/**
 * SMI-3221: Detect git-crypt encrypted content fetched from GitHub.
 * raw.githubusercontent.com serves encrypted bytes for repos using git-crypt.
 * The magic header is \x00GITCRYPT (hex 00474954435259505400).
 */
export function assertNotEncrypted(content: string, filePath: string): void {
  if (content.startsWith('\x00GITCRYPT')) {
    throw new Error(
      'File "' +
        filePath +
        '" is git-crypt encrypted. ' +
        'The repository uses git-crypt and this file cannot be fetched from GitHub. ' +
        'Workaround: clone the repo locally, unlock with git-crypt, then install with:\n' +
        '  cp -r /path/to/repo/.claude/skills/<skill-name> ~/.claude/skills/<skill-name>'
    )
  }
}

/**
 * SMI-5582: per-request timeout, kept in lock-step with the canonical core
 * copy at `@skillsmith/core` `skill-installation.io.ts`. This mcp-server copy
 * currently has no importers (the install critical path runs through the core
 * service), but it is an exported public helper, so it carries the same 10s
 * bound to prevent a future consumer from re-introducing an unbounded fetch.
 */
const GITHUB_FETCH_TIMEOUT_MS = 10_000

/**
 * Fetch file from GitHub
 * SMI-1491: Added optional branch parameter to use branch from repo_url
 */
export async function fetchFromGitHub(
  owner: string,
  repo: string,
  filePath: string,
  branch: string = 'main'
): Promise<string> {
  const url =
    'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath
  const response = await fetch(url, { signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) })

  if (!response.ok) {
    // If specified branch fails and it was 'main', try 'master' as fallback
    if (branch === 'main') {
      const masterUrl =
        'https://raw.githubusercontent.com/' + owner + '/' + repo + '/master/' + filePath
      const masterResponse = await fetch(masterUrl, {
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      })

      if (!masterResponse.ok) {
        throw new Error('Failed to fetch ' + filePath + ': ' + response.status)
      }

      const masterText = await masterResponse.text()
      assertNotEncrypted(masterText, filePath)
      return masterText
    }

    throw new Error('Failed to fetch ' + filePath + ': ' + response.status)
  }

  const text = await response.text()
  assertNotEncrypted(text, filePath)
  return text
}

// ============================================================================
// Validation
// ============================================================================

/** Validation result for SKILL.md */
export interface SkillMdValidation {
  valid: boolean
  errors: string[]
}

/**
 * Validate SKILL.md content
 */
export function validateSkillMd(content: string): SkillMdValidation {
  const errors: string[] = []

  // Check for required sections
  if (!content.includes('# ')) {
    errors.push('Missing title (# heading)')
  }

  // Check minimum length
  if (content.length < 100) {
    errors.push('SKILL.md is too short (minimum 100 characters)')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Generate post-install tips
 *
 * SMI-5894 (Wave 1 Step 5): `client`/`skillsDir` default to the canonical
 * (Claude Code) client so any caller that doesn't pass them keeps seeing
 * exactly the previous "Claude Code" / `~/.claude/skills/` wording. Note:
 * as of this fix this function has no remaining callers in this package —
 * the actual MCP install flow's tips come from the shared
 * `@skillsmith/core` `generateTips()` (via `SkillInstallationService`),
 * which received the equivalent fix. This one is fixed too so it can't
 * reintroduce the same hardcoded-client bug if it's ever wired back up.
 */
export function generateTips(
  skillName: string,
  client: ClientId = CANONICAL_CLIENT,
  skillsDir?: string
): string[] {
  const clientLabel = CLIENT_DISPLAY_LABELS[client]
  const dir = skillsDir ?? '~/.claude/skills'
  return [
    'Skill "' + skillName + '" installed successfully!',
    'To use this skill, mention it in ' + clientLabel + ': "Use the ' + skillName + ' skill to..."',
    'View installed skills: ls ' + dir + '/',
    'To uninstall: use the uninstall_skill tool',
  ]
}

/**
 * SMI-1788: Optimization info type for tips generation
 * SMI-1803: Exported for external use
 */
export interface OptimizationInfoForTips {
  optimized: boolean
  subSkills?: string[]
  subagentGenerated?: boolean
  subagentPath?: string
  tokenReductionPercent?: number
  originalLines?: number
  optimizedLines?: number
}

/**
 * SMI-1788: Generate post-install tips with optimization info
 *
 * SMI-5894 (Wave 1 Step 5): `client`/`skillsDir` (both optional, added after
 * `claudeMdSnippet` to preserve the existing positional signature) default
 * to the canonical client, same rationale as `generateTips` above — this
 * function currently has no live caller either; see that function's
 * docstring for the full explanation.
 */
export function generateOptimizedTips(
  skillName: string,
  optimizationInfo: OptimizationInfoForTips,
  claudeMdSnippet?: string,
  client: ClientId = CANONICAL_CLIENT,
  skillsDir?: string
): string[] {
  const clientLabel = CLIENT_DISPLAY_LABELS[client]
  const dir = skillsDir ?? '~/.claude/skills'
  const tips = [
    'Skill "' + skillName + '" installed successfully!',
    'To use this skill, mention it in ' + clientLabel + ': "Use the ' + skillName + ' skill to..."',
    'View installed skills: ls ' + dir + '/',
  ]

  if (optimizationInfo.optimized) {
    tips.push('')
    tips.push('[Optimization] Skillsmith Optimization Applied:')

    if (optimizationInfo.tokenReductionPercent && optimizationInfo.tokenReductionPercent > 0) {
      tips.push(`  • Estimated ${optimizationInfo.tokenReductionPercent}% token reduction`)
    }

    if (optimizationInfo.originalLines && optimizationInfo.optimizedLines) {
      tips.push(
        `  • Optimized from ${optimizationInfo.originalLines} to ${optimizationInfo.optimizedLines} lines`
      )
    }

    if (optimizationInfo.subSkills && optimizationInfo.subSkills.length > 0) {
      tips.push(`  • ${optimizationInfo.subSkills.length} sub-skills created for on-demand loading`)
    }

    if (optimizationInfo.subagentGenerated && optimizationInfo.subagentPath) {
      tips.push(`  • Companion subagent generated: ${optimizationInfo.subagentPath}`)
      tips.push('')
      tips.push(
        '[Tip] For parallel execution, delegate to the subagent instead of running directly.'
      )

      if (claudeMdSnippet) {
        tips.push('')
        tips.push('Add this to your CLAUDE.md for automatic delegation:')
        tips.push('')
        // Include a shortened version of the snippet
        const shortSnippet = claudeMdSnippet
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .slice(0, 5)
          .join('\n')
        tips.push(shortSnippet + '\n...')
      }
    }
  }

  tips.push('')
  tips.push('To uninstall: use the uninstall_skill tool')

  return tips
}

// ============================================================================
// Conflict Resolution Helpers (SMI-1865)
// Split to install.conflict-helpers.ts per governance code review
// ============================================================================

// Re-export conflict resolution helpers from dedicated module
export {
  hashContent,
  type ModificationResult,
  detectModifications,
  createSkillBackup,
  storeOriginal,
  loadOriginal,
  cleanupOldBackups,
  getBackupsDir,
} from './install.conflict-helpers.js'
