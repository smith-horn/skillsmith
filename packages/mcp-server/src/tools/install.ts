/**
 * @fileoverview MCP Install Skill Tool for downloading and installing skills
 * @module @skillsmith/mcp-server/tools/install
 * @see {@link https://github.com/wrsmith108/skillsmith|Skillsmith Repository}
 *
 * Provides skill installation functionality with:
 * - GitHub repository fetching (supports owner/repo and full URLs)
 * - Automatic security scanning before installation
 * - SKILL.md validation
 * - Manifest tracking of installed skills
 * - Optional file fetching (README.md, examples.md, config.json)
 *
 * Skills are installed to ~/.claude/skills/ and tracked in ~/.skillsmith/manifest.json
 *
 * @example
 * // Install from owner/repo format
 * const result = await installSkill({ skillId: 'anthropic/commit' });
 *
 * @example
 * // Install from GitHub URL
 * const result = await installSkill({
 *   skillId: 'https://github.com/user/repo/tree/main/skills/my-skill'
 * });
 *
 * @example
 * // Force reinstall with security scan skip
 * const result = await installSkill({
 *   skillId: 'community/helper',
 *   force: true,
 *   skipScan: true // Not recommended
 * });
 */

import { z } from 'zod'
import { SecurityScanner, type ScanReport, type ScannerOptions } from '@skillsmith/core'
import type { TrustTier } from '@skillsmith/core'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'

/**
 * SMI-1533: Valid trust tier values
 */
const VALID_TRUST_TIERS: readonly TrustTier[] = ['verified', 'community', 'experimental', 'unknown']

/**
 * SMI-1533: Validate and normalize trust tier value
 * Returns 'unknown' for invalid or missing values to ensure strictest scanning
 *
 * NOTE: 'verified' tier currently relies on registry data without cryptographic
 * verification. Future enhancement: implement signature verification for
 * Anthropic-verified skills using PKI.
 */
export function validateTrustTier(value: string | null | undefined): TrustTier {
  if (!value) return 'unknown'
  const normalized = value.toLowerCase() as TrustTier
  if (!VALID_TRUST_TIERS.includes(normalized)) return 'unknown'

  // SMI-1533: Log warning for 'verified' tier until PKI is implemented
  if (normalized === 'verified') {
    console.debug(
      '[install] Trust tier "verified" accepted from registry. ' +
        'Note: Cryptographic signature verification not yet implemented.'
    )
  }

  return normalized
}

/**
 * SMI-1533: Security scan configuration per trust tier
 *
 * - verified: Minimal scanning (trust Anthropic-verified skills)
 * - community: Standard scanning (balanced security)
 * - experimental: Aggressive scanning (highest scrutiny for new/beta skills)
 * - unknown: Most aggressive scanning
 */
const TRUST_TIER_SCANNER_OPTIONS: Record<TrustTier, ScannerOptions> = {
  verified: {
    // Anthropic-verified skills get minimal scanning
    riskThreshold: 70, // Higher threshold - more tolerant
    maxContentLength: 2_000_000, // Allow larger skills
  },
  community: {
    // Standard scanning for community-reviewed skills
    riskThreshold: 40, // Default threshold
    maxContentLength: 1_000_000,
  },
  experimental: {
    // Aggressive scanning for new/beta skills
    riskThreshold: 25, // Lower threshold - less tolerant
    maxContentLength: 500_000, // Limit skill size
  },
  unknown: {
    // Most aggressive scanning for unknown origins
    riskThreshold: 20, // Very strict
    maxContentLength: 250_000, // Very limited size
  },
}

// Input schema
export const installInputSchema = z.object({
  skillId: z.string().min(1).describe('Skill ID or GitHub URL'),
  force: z.boolean().default(false).describe('Force reinstall if exists'),
  skipScan: z.boolean().default(false).describe('Skip security scan (not recommended)'),
})

export type InstallInput = z.infer<typeof installInputSchema>

// Output type
export interface InstallResult {
  success: boolean
  skillId: string
  installPath: string
  securityReport?: ScanReport
  tips?: string[]
  error?: string
  /** SMI-1533: Trust tier used for security scanning */
  trustTier?: TrustTier
}

// Paths
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')
const SKILLSMITH_DIR = path.join(os.homedir(), '.skillsmith')
const MANIFEST_PATH = path.join(SKILLSMITH_DIR, 'manifest.json')

interface SkillManifest {
  version: string
  installedSkills: Record<
    string,
    {
      id: string
      name: string
      version: string
      source: string
      installPath: string
      installedAt: string
      lastUpdated: string
    }
  >
}

/**
 * Load or create manifest
 */
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
async function acquireManifestLock(): Promise<void> {
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
async function releaseManifestLock(): Promise<void> {
  try {
    await fs.unlink(MANIFEST_LOCK_PATH)
  } catch {
    // Ignore errors - lock may already be released
  }
}

async function loadManifest(): Promise<SkillManifest> {
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
async function saveManifest(manifest: SkillManifest): Promise<void> {
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
async function updateManifestSafely(
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

/**
 * Parse skill ID or URL to get components
 * SMI-1491: Added isRegistryId flag to detect registry skill IDs vs direct GitHub URLs
 */
function parseSkillId(input: string): {
  owner: string
  repo: string
  path: string
  isRegistryId: boolean
} {
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
 * Parse repo_url from registry to extract GitHub components
 * SMI-1491: Handles various GitHub URL formats stored in registry
 *
 * @example
 * // Repo root
 * parseRepoUrl('https://github.com/owner/repo')
 * // => { owner: 'owner', repo: 'repo', path: '', branch: 'main' }
 *
 * @example
 * // Skill in subdirectory
 * parseRepoUrl('https://github.com/owner/repo/tree/main/skills/commit')
 * // => { owner: 'owner', repo: 'repo', path: 'skills/commit', branch: 'main' }
 */
/**
 * Allowed hostnames for skill installation
 * SMI-1533: Restrict to trusted code hosting platforms
 */
const ALLOWED_HOSTS = ['github.com', 'www.github.com']

function parseRepoUrl(repoUrl: string): {
  owner: string
  repo: string
  path: string
  branch: string
} {
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

/**
 * Look up skill in registry to get repo_url
 * SMI-1491: Enables install to work with registry IDs like "author/skill-name"
 *
 * Follows API-first pattern: tries live API, falls back to local DB
 *
 * @param skillId - Skill ID in author/skill-name format
 * @param context - Tool context with apiClient and skillRepository
 * @returns Skill info with repoUrl, or null if not found/no repo_url
 */
async function lookupSkillFromRegistry(
  skillId: string,
  context: ToolContext
): Promise<{ repoUrl: string; name: string; trustTier: TrustTier } | null> {
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

/**
 * Fetch file from GitHub
 * SMI-1491: Added optional branch parameter to use branch from repo_url
 */
async function fetchFromGitHub(
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

/**
 * Validate SKILL.md content
 */
function validateSkillMd(content: string): { valid: boolean; errors: string[] } {
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
function generateTips(skillName: string): string[] {
  return [
    'Skill "' + skillName + '" installed successfully!',
    'To use this skill, mention it in Claude Code: "Use the ' + skillName + ' skill to..."',
    'View installed skills: ls ~/.claude/skills/',
    'To uninstall: use the uninstall_skill tool',
  ]
}

/**
 * Install a skill from GitHub to the local Claude Code skills directory.
 *
 * This function:
 * 1. Parses the skill ID or GitHub URL
 * 2. Checks if already installed (returns error unless force=true)
 * 3. Fetches SKILL.md from GitHub (required)
 * 4. Validates SKILL.md content
 * 5. Runs security scan (unless skipScan=true)
 * 6. Creates installation directory at ~/.claude/skills/{skillName}
 * 7. Writes skill files
 * 8. Updates manifest at ~/.skillsmith/manifest.json
 *
 * @param input - Installation parameters
 * @param input.skillId - Skill ID (owner/repo) or full GitHub URL
 * @param input.force - Force reinstall if skill already exists (default: false)
 * @param input.skipScan - Skip security scan (default: false, not recommended)
 * @returns Promise resolving to installation result with success status
 *
 * @example
 * // Successful installation
 * const result = await installSkill({ skillId: 'anthropic/commit' });
 * if (result.success) {
 *   console.log(`Installed to ${result.installPath}`);
 *   result.tips?.forEach(tip => console.log(tip));
 * }
 *
 * @example
 * // Handle security scan failure
 * const result = await installSkill({ skillId: 'untrusted/skill' });
 * if (!result.success && result.securityReport) {
 *   console.log('Security issues found:');
 *   result.securityReport.findings.forEach(f =>
 *     console.log(`  ${f.severity}: ${f.message}`)
 *   );
 * }
 */
export async function installSkill(
  input: InstallInput,
  _context?: ToolContext
): Promise<InstallResult> {
  // SMI-1491: Get context for registry lookup (use provided or fallback to singleton)
  const context = _context ?? getToolContext()

  // SMI-1533: Trust tier for security scan configuration (default to unknown for direct paths)
  let trustTier: TrustTier = 'unknown'

  try {
    // Parse skill ID
    const parsed = parseSkillId(input.skillId)

    // SMI-1491: Variables that will be set differently based on registry vs direct path
    let owner: string
    let repo: string
    let basePath: string
    let skillName: string
    let branch: string = 'main'

    if (parsed.isRegistryId) {
      // REGISTRY LOOKUP PATH (SMI-1491)
      // 2-part IDs like "author/skill-name" need registry lookup to get real repo_url
      const registrySkill = await lookupSkillFromRegistry(input.skillId, context)

      if (!registrySkill) {
        // Skill not found or has no repo_url (seed data)
        return {
          success: false,
          skillId: input.skillId,
          installPath: '',
          error:
            'Skill "' +
            input.skillId +
            '" is indexed for discovery only. ' +
            'No installation source available (repo_url is missing). ' +
            'This may be placeholder/seed data or a metadata-only entry.',
          tips: [
            'Use a full GitHub URL instead: install_skill { skillId: "https://github.com/owner/repo" }',
            'Search for installable skills using the search tool',
            'Many indexed skills are metadata-only and cannot be installed directly',
          ],
        }
      }

      // Parse the repo_url to get GitHub components
      const repoInfo = parseRepoUrl(registrySkill.repoUrl)
      owner = repoInfo.owner
      repo = repoInfo.repo
      basePath = repoInfo.path ? repoInfo.path + '/' : ''
      branch = repoInfo.branch
      skillName = registrySkill.name
      // SMI-1533: Use trust tier from registry for security scan configuration
      trustTier = registrySkill.trustTier
    } else {
      // DIRECT PATH (existing behavior)
      // Full GitHub URLs or owner/repo/path format
      owner = parsed.owner
      repo = parsed.repo
      basePath = parsed.path ? parsed.path + '/' : ''
      skillName = parsed.path ? path.basename(parsed.path) : repo
    }

    const installPath = path.join(CLAUDE_SKILLS_DIR, skillName)

    // Check if already installed
    const manifest = await loadManifest()
    if (manifest.installedSkills[skillName] && !input.force) {
      return {
        success: false,
        skillId: input.skillId,
        installPath,
        error: 'Skill "' + skillName + '" is already installed. Use force=true to reinstall.',
      }
    }

    // Determine files to fetch
    const skillMdPath = basePath + 'SKILL.md'

    // Fetch SKILL.md (required)
    let skillMdContent: string
    try {
      skillMdContent = await fetchFromGitHub(owner, repo, skillMdPath, branch)
    } catch {
      // SMI-1491: Improved error message
      const repoUrl = 'https://github.com/' + owner + '/' + repo
      return {
        success: false,
        skillId: input.skillId,
        installPath,
        error:
          'Could not find SKILL.md at ' +
          (basePath || 'repository root') +
          '. ' +
          'Skills must have a SKILL.md file with YAML frontmatter (name, description) to be installable. ' +
          'Repository: ' +
          repoUrl,
        tips: [
          'This skill may be browse-only (no SKILL.md at expected location)',
          'Verify the repository exists: ' + repoUrl,
          'You can manually install by: 1) Clone the repo, 2) Create a SKILL.md, 3) Copy to ~/.claude/skills/',
          'Check if the skill has a SKILL.md in a subdirectory and use the full path',
        ],
      }
    }

    // Validate SKILL.md
    const validation = validateSkillMd(skillMdContent)
    if (!validation.valid) {
      return {
        success: false,
        skillId: input.skillId,
        installPath,
        error: 'Invalid SKILL.md: ' + validation.errors.join(', '),
        tips: [
          'SKILL.md must have YAML frontmatter with name and description fields',
          'Content must be at least 100 characters',
          'See template: https://github.com/wrsmith108/skillsmith/blob/main/docs/templates/skill-template.md',
        ],
      }
    }

    // SMI-1533: Security scan with trust-tier sensitive configuration
    let securityReport: ScanReport | undefined
    if (!input.skipScan) {
      // Get scanner options based on trust tier
      const scannerOptions = TRUST_TIER_SCANNER_OPTIONS[trustTier]
      const scanner = new SecurityScanner(scannerOptions)

      securityReport = scanner.scan(input.skillId, skillMdContent)

      if (!securityReport.passed) {
        const criticalFindings = securityReport.findings.filter(
          (f) => f.severity === 'critical' || f.severity === 'high'
        )

        // SMI-1533: Include trust tier context in error message
        const tierContext =
          trustTier === 'unknown'
            ? ' (Direct GitHub install - strictest scanning applied)'
            : trustTier === 'experimental'
              ? ' (Experimental skill - aggressive scanning applied)'
              : ''

        return {
          success: false,
          skillId: input.skillId,
          installPath,
          securityReport,
          trustTier,
          error:
            'Security scan failed with ' +
            criticalFindings.length +
            ' critical/high findings' +
            tierContext +
            '. Use skipScan=true to override (not recommended).',
          tips: [
            'Trust tier: ' + trustTier + ' (threshold: ' + scannerOptions.riskThreshold + ')',
            'Risk score: ' + securityReport.riskScore,
            'Consider reviewing the skill content for the flagged issues',
            trustTier === 'unknown'
              ? 'Skills from the registry have more lenient scanning thresholds'
              : undefined,
          ].filter(Boolean) as string[],
        }
      }
    }

    // Create installation directory
    await fs.mkdir(installPath, { recursive: true })

    // Write SKILL.md
    await fs.writeFile(path.join(installPath, 'SKILL.md'), skillMdContent)

    // Try to fetch optional files
    // SMI-1533: Use same trust-tier scanner for optional files
    const optionalFileScanner = input.skipScan
      ? null
      : new SecurityScanner(TRUST_TIER_SCANNER_OPTIONS[trustTier])
    const optionalFiles = ['README.md', 'examples.md', 'config.json']
    for (const file of optionalFiles) {
      try {
        const content = await fetchFromGitHub(owner, repo, basePath + file, branch)

        // Scan optional files too
        if (optionalFileScanner) {
          const fileScan = optionalFileScanner.scan(input.skillId + '/' + file, content)
          if (!fileScan.passed) {
            console.warn('Skipping ' + file + ' due to security findings')
            continue
          }
        }

        await fs.writeFile(path.join(installPath, file), content)
      } catch {
        // Optional files are fine to skip
      }
    }

    // Update manifest with locking to prevent race conditions
    await updateManifestSafely((currentManifest) => ({
      ...currentManifest,
      installedSkills: {
        ...currentManifest.installedSkills,
        [skillName]: {
          id: input.skillId,
          name: skillName,
          version: '1.0.0',
          source: 'github:' + owner + '/' + repo,
          installPath,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      },
    }))

    return {
      success: true,
      skillId: input.skillId,
      installPath,
      securityReport,
      trustTier, // SMI-1533: Include trust tier in result
      tips: generateTips(skillName),
    }
  } catch (error) {
    return {
      success: false,
      skillId: input.skillId,
      installPath: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * MCP tool definition
 */
export const installTool = {
  name: 'install_skill',
  description:
    'Install a Claude Code skill from GitHub. Performs security scan before installation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillId: {
        type: 'string',
        description: 'Skill ID (owner/repo/skill) or GitHub URL',
      },
      force: {
        type: 'boolean',
        description: 'Force reinstall if skill already exists',
      },
      skipScan: {
        type: 'boolean',
        description: 'Skip security scan (not recommended)',
      },
    },
    required: ['skillId'],
  },
}

export default installTool
