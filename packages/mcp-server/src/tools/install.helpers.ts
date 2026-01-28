/**
 * @fileoverview Install Tool Helper Functions
 * @module @skillsmith/mcp-server/tools/install.helpers
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
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
// ============================================================================

/**
 * SMI-1865: Compute SHA-256 hash of content for modification detection
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * SMI-1865: Result of modification detection
 */
export interface ModificationResult {
  /** Whether the file has been modified since installation */
  modified: boolean
  /** SHA-256 hash of the current content */
  currentHash: string
  /** SHA-256 hash of the original content at install time */
  originalHash: string
}

/**
 * SMI-1865: Detect if a skill has been modified since installation
 * @param installPath - Path to the installed skill directory
 * @param originalHash - SHA-256 hash of the original SKILL.md at install time
 * @returns ModificationResult indicating if the skill has been modified
 */
export async function detectModifications(
  installPath: string,
  originalHash: string
): Promise<ModificationResult> {
  const skillMdPath = path.join(installPath, 'SKILL.md')

  try {
    const currentContent = await fs.readFile(skillMdPath, 'utf-8')
    const currentHash = hashContent(currentContent)

    return {
      modified: currentHash !== originalHash,
      currentHash,
      originalHash,
    }
  } catch (error) {
    // If file doesn't exist, consider it modified (deleted)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        modified: true,
        currentHash: '',
        originalHash,
      }
    }
    throw error
  }
}

/**
 * SMI-1865: Base directory for skill backups
 */
const BACKUPS_DIR = path.join(os.homedir(), '.claude', 'skills', '.backups')

/**
 * SMI-1865: Create a timestamped backup of a skill before update
 * @param skillName - Name of the skill (used for directory naming)
 * @param installPath - Current install path of the skill
 * @param reason - Reason for creating the backup (e.g., 'pre-update', 'conflict')
 * @returns Path to the created backup directory
 */
export async function createSkillBackup(
  skillName: string,
  installPath: string,
  reason: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(BACKUPS_DIR, skillName, `${timestamp}_${reason}`)

  // Create backup directory
  await fs.mkdir(backupDir, { recursive: true })

  // Copy all files from install path to backup
  const entries = await fs.readdir(installPath, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(installPath, entry.name)
    const destPath = path.join(backupDir, entry.name)

    if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath)
    } else if (entry.isDirectory()) {
      // Recursively copy directories
      await copyDirectory(srcPath, destPath)
    }
  }

  return backupDir
}

/**
 * SMI-1865: Recursively copy a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath)
    } else if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath)
    }
  }
}

/**
 * SMI-1865: Store the original content of a skill at install time
 * Used for three-way merge during conflict resolution
 * @param skillName - Name of the skill
 * @param content - Original SKILL.md content
 * @param metadata - Additional metadata to store (version, source, etc.)
 */
export async function storeOriginal(
  skillName: string,
  content: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const originalDir = path.join(BACKUPS_DIR, skillName, '.original')

  // Create directory
  await fs.mkdir(originalDir, { recursive: true })

  // Store SKILL.md content
  await fs.writeFile(path.join(originalDir, 'SKILL.md'), content, 'utf-8')

  // Store metadata
  await fs.writeFile(path.join(originalDir, 'metadata.json'), JSON.stringify(metadata, null, 2))
}

/**
 * SMI-1865: Load the original SKILL.md content stored at install time
 * @param skillName - Name of the skill
 * @returns Original content, or null if not found
 */
export async function loadOriginal(skillName: string): Promise<string | null> {
  const originalPath = path.join(BACKUPS_DIR, skillName, '.original', 'SKILL.md')

  try {
    return await fs.readFile(originalPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * SMI-1865: Clean up old backups, keeping only the most recent ones
 * Never deletes the .original directory
 * @param skillName - Name of the skill
 * @param keepCount - Number of most recent backups to keep (default: 3)
 */
export async function cleanupOldBackups(skillName: string, keepCount: number = 3): Promise<void> {
  const skillBackupDir = path.join(BACKUPS_DIR, skillName)

  try {
    const entries = await fs.readdir(skillBackupDir, { withFileTypes: true })

    // Filter to only timestamped directories (not .original)
    const backupDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name !== '.original')
      .map((entry) => entry.name)
      .sort()
      .reverse() // Most recent first (ISO timestamps sort correctly)

    // Remove old backups beyond keepCount
    const toDelete = backupDirs.slice(keepCount)

    for (const dirName of toDelete) {
      const dirPath = path.join(skillBackupDir, dirName)
      await fs.rm(dirPath, { recursive: true, force: true })
    }
  } catch (error) {
    // If directory doesn't exist, nothing to clean up
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
}
