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
 */

import { SecurityScanner, TransformationService } from '@skillsmith/core'
import type { TrustTier } from '@skillsmith/core'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'

// Import types
import {
  TRUST_TIER_SCANNER_OPTIONS,
  CLAUDE_SKILLS_DIR,
  type InstallInput,
  type InstallResult,
  type OptimizationInfo,
} from './install.types.js'

// Import helpers
import {
  loadManifest,
  updateManifestSafely,
  parseSkillId,
  parseRepoUrl,
  lookupSkillFromRegistry,
  fetchFromGitHub,
  validateSkillMd,
  generateOptimizedTips,
  hashContent,
  storeOriginal,
} from './install.helpers.js'

// SMI-1867: Conflict resolution logic (extracted per governance review)
import { checkForConflicts, handleMergeAction } from './install.conflict.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export { installInputSchema, type InstallInput, type InstallResult } from './install.types.js'

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

    // SMI-1867: Check for local modifications on reinstall
    let backupPath: string | undefined
    if (manifest.installedSkills[skillName] && input.force) {
      const conflictCheck = await checkForConflicts(
        skillName,
        installPath,
        manifest,
        input.conflictAction,
        input.skillId
      )

      if (!conflictCheck.shouldProceed) {
        return conflictCheck.earlyReturn!
      }

      backupPath = conflictCheck.backupPath
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

    // SMI-1867: Handle merge action for conflict resolution
    if (input.conflictAction === 'merge') {
      const mergeOp = await handleMergeAction(
        skillName,
        installPath,
        skillMdContent,
        manifest,
        owner,
        repo,
        input.skillId
      )

      if (!mergeOp.shouldProceed) {
        return mergeOp.earlyReturn!
      }

      if (mergeOp.mergedContent) {
        skillMdContent = mergeOp.mergedContent
      }
      if (mergeOp.backupPath) {
        backupPath = mergeOp.backupPath
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
    let securityReport: InstallResult['securityReport']
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

    // SMI-1788: Apply Skillsmith Optimization Layer (unless skipped)
    let optimizationInfo: OptimizationInfo = { optimized: false }
    let finalSkillContent = skillMdContent
    let subSkillFiles: Array<{ filename: string; content: string }> = []
    let subagentContent: string | undefined
    let claudeMdSnippet: string | undefined

    if (!input.skipOptimize) {
      try {
        const transformService = new TransformationService(context.db, {
          cacheTtl: 3600, // 1 hour cache
          version: '1.0.0',
        })

        // Extract skill name and description for transformation
        const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m)
        const descMatch = skillMdContent.match(/^description:\s*(.+)$/m)
        const extractedName = nameMatch ? nameMatch[1].trim() : skillName
        const extractedDesc = descMatch ? descMatch[1].trim() : ''

        const transformResult = await transformService.transform(
          input.skillId,
          extractedName,
          extractedDesc,
          skillMdContent
        )

        if (transformResult.transformed) {
          finalSkillContent = transformResult.mainSkillContent
          subSkillFiles = transformResult.subSkills
          subagentContent = transformResult.subagent?.content
          claudeMdSnippet = transformResult.claudeMdSnippet

          optimizationInfo = {
            optimized: true,
            subSkills: subSkillFiles.map((s) => s.filename),
            subagentGenerated: !!subagentContent,
            tokenReductionPercent: transformResult.stats.tokenReductionPercent,
            originalLines: transformResult.stats.originalLines,
            optimizedLines: transformResult.stats.optimizedLines,
          }
        }
      } catch (transformError) {
        // Transformation failed - continue with original content
        console.warn('[install] Optimization failed, using original content:', transformError)
        finalSkillContent = skillMdContent
        optimizationInfo = { optimized: false }
      }
    }

    // SMI-1867: Compute hash before file operations (needed in manifest update)
    const contentHash = hashContent(finalSkillContent)

    // SMI-1792, SMI-1797: Atomic file installation with transaction pattern
    // SMI-1804: Parallelize file writes for better performance
    const writtenFiles: string[] = []
    try {
      // Create installation directory
      await fs.mkdir(installPath, { recursive: true })

      // Write SKILL.md (optimized or original)
      const mainSkillPath = path.join(installPath, 'SKILL.md')
      await fs.writeFile(mainSkillPath, finalSkillContent)
      writtenFiles.push(mainSkillPath)

      // SMI-1867: Store original content for future conflict detection
      await storeOriginal(skillName, finalSkillContent, {
        version: '1.0.0',
        source: 'github:' + owner + '/' + repo,
        installedAt: new Date().toISOString(),
      })

      // Write sub-skills in parallel (SMI-1804: Performance optimization)
      if (subSkillFiles.length > 0) {
        await Promise.all(
          subSkillFiles.map(async (subSkill) => {
            const subPath = path.join(installPath, subSkill.filename)
            await fs.writeFile(subPath, subSkill.content)
            writtenFiles.push(subPath)
          })
        )
      }

      // Write companion subagent if generated
      if (subagentContent) {
        const agentsDir = path.join(os.homedir(), '.claude', 'agents')
        await fs.mkdir(agentsDir, { recursive: true })
        const subagentPath = path.join(agentsDir, `${skillName}-specialist.md`)
        await fs.writeFile(subagentPath, subagentContent)
        writtenFiles.push(subagentPath)
        optimizationInfo.subagentPath = subagentPath
      }
    } catch (writeError) {
      // SMI-1792: Rollback on failure - remove any files we wrote
      for (const filePath of writtenFiles) {
        await fs.unlink(filePath).catch(() => {})
      }
      // Try to remove the directory if we created it and it's now empty
      await fs.rmdir(installPath).catch(() => {})
      throw writeError
    }

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
          originalContentHash: contentHash, // SMI-1867: Track original hash
        },
      },
    }))

    return {
      success: true,
      skillId: input.skillId,
      installPath,
      securityReport,
      trustTier, // SMI-1533: Include trust tier in result
      optimization: optimizationInfo,
      tips: generateOptimizedTips(skillName, optimizationInfo, claudeMdSnippet),
    }
  } catch (error) {
    // SMI-1793: Sanitize error messages to avoid exposing internal details
    let safeErrorMessage = 'Installation failed'
    if (error instanceof Error) {
      // Allow specific known error types through
      if (
        error.message.includes('already installed') ||
        error.message.includes('Could not find SKILL.md') ||
        error.message.includes('Invalid SKILL.md') ||
        error.message.includes('Security scan failed') ||
        error.message.includes('exceeds maximum length')
      ) {
        safeErrorMessage = error.message
      } else {
        // Log the full error for debugging, return sanitized message
        console.error('[install] Error during installation:', error)
        safeErrorMessage = 'Installation failed due to an internal error'
      }
    }
    return {
      success: false,
      skillId: input.skillId,
      installPath: '',
      error: safeErrorMessage,
    }
  }
}

/**
 * MCP tool definition
 */
export const installTool = {
  name: 'install_skill',
  description:
    'Install a Claude Code skill from GitHub. Performs security scan and Skillsmith optimization before installation.',
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
      skipOptimize: {
        type: 'boolean',
        description: 'Skip Skillsmith optimization (decomposition, subagent generation)',
      },
      conflictAction: {
        type: 'string',
        enum: ['overwrite', 'merge', 'cancel'],
        description:
          'Action when local modifications detected: overwrite (backup + replace), merge (three-way), or cancel',
      },
    },
    required: ['skillId'],
  },
}

export default installTool
