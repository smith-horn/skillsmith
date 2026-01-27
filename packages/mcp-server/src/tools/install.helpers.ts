/**
 * @fileoverview Install Tool Helper Functions
 * @module @skillsmith/mcp-server/tools/install.helpers
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { ToolContext } from '../context.js'
import {
  MANIFEST_PATH,
  validateTrustTier,
  type SkillManifest,
  type ParsedSkillId,
  type ParsedRepoUrl,
  type RegistrySkillInfo,
} from './install.types.js'

// ============================================================================
// Manifest Locking
// ============================================================================

/**
 * SMI-1533: Lock file path for manifest operations
 */
const MANIFEST_LOCK_PATH = MANIFEST_PATH + '.lock'
const LOCK_TIMEOUT_MS = 30000 // 30 seconds max wait for lock
const LOCK_RETRY_INTERVAL_MS = 100

/**
 * Acquire a file lock for manifest operations
 * SMI-1533: Prevents race conditions during concurrent installs
 */
export async function acquireManifestLock(): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // Try to create lock file exclusively
      await fs.writeFile(MANIFEST_LOCK_PATH, String(process.pid), { flag: 'wx' })
      return // Lock acquired
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock exists, check if it's stale (older than timeout)
        try {
          const stats = await fs.stat(MANIFEST_LOCK_PATH)
          const lockAge = Date.now() - stats.mtimeMs
          if (lockAge > LOCK_TIMEOUT_MS) {
            // Stale lock, remove it and retry
            await fs.unlink(MANIFEST_LOCK_PATH).catch(() => {})
            continue
          }
        } catch {
          // Lock file disappeared, retry
          continue
        }
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
      } else {
        throw error
      }
    }
  }

  throw new Error('Failed to acquire manifest lock after ' + LOCK_TIMEOUT_MS + 'ms')
}

/**
 * Release the manifest lock
 */
export async function releaseManifestLock(): Promise<void> {
  try {
    await fs.unlink(MANIFEST_LOCK_PATH)
  } catch {
    // Ignore errors - lock may already be released
  }
}

// ============================================================================
// Manifest Operations
// ============================================================================

/**
 * Load or create manifest
 */
export async function loadManifest(): Promise<SkillManifest> {
  try {
    const content = await fs.readFile(MANIFEST_PATH, 'utf-8')
    return JSON.parse(content)
  } catch {
    return {
      version: '1.0.0',
      installedSkills: {},
    }
  }
}

/**
 * Save manifest
 * SMI-1533: Uses atomic write pattern with lock
 */
export async function saveManifest(manifest: SkillManifest): Promise<void> {
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true })
  // Write to temp file first, then rename for atomic operation
  const tempPath = MANIFEST_PATH + '.tmp.' + process.pid
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2))
  await fs.rename(tempPath, MANIFEST_PATH)
}

/**
 * SMI-1533: Safely update manifest with locking
 * Prevents race conditions during concurrent install operations
 */
export async function updateManifestSafely(
  updateFn: (manifest: SkillManifest) => SkillManifest
): Promise<void> {
  await acquireManifestLock()
  try {
    const manifest = await loadManifest()
    const updatedManifest = updateFn(manifest)
    await saveManifest(updatedManifest)
  } finally {
    await releaseManifestLock()
  }
}

// ============================================================================
// Parsing Functions
// ============================================================================

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

  // Handle skill ID from registry
  throw new Error('Invalid skill ID format: ' + input + '. Use owner/repo or GitHub URL.')
}

/**
 * Allowed hostnames for skill installation
 * SMI-1533: Restrict to trusted code hosting platforms
 */
const ALLOWED_HOSTS = ['github.com', 'www.github.com']

/**
 * Parse repo_url from registry to extract GitHub components
 * SMI-1491: Handles various GitHub URL formats stored in registry
 */
export function parseRepoUrl(repoUrl: string): ParsedRepoUrl {
  const url = new URL(repoUrl)

  // SMI-1533: Validate hostname to prevent fetching from malicious sources
  if (!ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) {
    throw new Error(
      `Invalid repository host: ${url.hostname}. ` +
        `Only GitHub repositories are supported (${ALLOWED_HOSTS.join(', ')})`
    )
  }

  const parts = url.pathname.split('/').filter(Boolean)

  const owner = parts[0]
  const repo = parts[1]

  // /owner/repo (skill at repo root)
  if (parts.length === 2) {
    return { owner, repo, path: '', branch: 'main' }
  }

  // /owner/repo/tree/branch/path... or /owner/repo/blob/branch/path...
  if (parts[2] === 'tree' || parts[2] === 'blob') {
    return {
      owner,
      repo,
      branch: parts[3],
      path: parts.slice(4).join('/'),
    }
  }

  // Unknown format - assume path starts at index 2, default to main branch
  return { owner, repo, path: parts.slice(2).join('/'), branch: 'main' }
}

// ============================================================================
// Registry Lookup
// ============================================================================

/**
 * Look up skill in registry to get repo_url
 * SMI-1491: Enables install to work with registry IDs like "author/skill-name"
 *
 * Follows API-first pattern: tries live API, falls back to local DB
 */
export async function lookupSkillFromRegistry(
  skillId: string,
  context: ToolContext
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
        }
      }
      // API found skill but no repo_url - it's seed data
      return null
    } catch {
      // API failed, fall through to local DB
    }
  }

  // Fallback: Local database
  const dbSkill = context.skillRepository.findById(skillId)
  if (dbSkill?.repoUrl) {
    return {
      repoUrl: dbSkill.repoUrl,
      name: dbSkill.name,
      // SMI-1533: Validate trust tier for security scan configuration
      trustTier: validateTrustTier(dbSkill.trustTier),
    }
  }

  return null
}

// ============================================================================
// GitHub Fetching
// ============================================================================

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
  const response = await fetch(url)

  if (!response.ok) {
    // If specified branch fails and it was 'main', try 'master' as fallback
    if (branch === 'main') {
      const masterUrl =
        'https://raw.githubusercontent.com/' + owner + '/' + repo + '/master/' + filePath
      const masterResponse = await fetch(masterUrl)

      if (!masterResponse.ok) {
        throw new Error('Failed to fetch ' + filePath + ': ' + response.status)
      }

      return masterResponse.text()
    }

    throw new Error('Failed to fetch ' + filePath + ': ' + response.status)
  }

  return response.text()
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
 */
export function generateTips(skillName: string): string[] {
  return [
    'Skill "' + skillName + '" installed successfully!',
    'To use this skill, mention it in Claude Code: "Use the ' + skillName + ' skill to..."',
    'View installed skills: ls ~/.claude/skills/',
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
 */
export function generateOptimizedTips(
  skillName: string,
  optimizationInfo: OptimizationInfoForTips,
  claudeMdSnippet?: string
): string[] {
  const tips = [
    'Skill "' + skillName + '" installed successfully!',
    'To use this skill, mention it in Claude Code: "Use the ' + skillName + ' skill to..."',
    'View installed skills: ls ~/.claude/skills/',
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
} from './install.conflict-helpers.js'
