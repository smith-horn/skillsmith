/**
 * @fileoverview MCP Install Skill Tool for downloading and installing skills
 * @module @skillsmith/mcp-server/tools/install
 * @see SMI-2741: Split to meet 500-line standard
 * @see SMI-3137: Wave 4 — Dependency intelligence persistence
 *
 * Skills are installed to ~/.claude/skills/ and tracked in ~/.skillsmith/manifest.json
 */

import { SecurityScanner, safeWriteFile, type TrustTier } from '@skillsmith/core'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'
import {
  TRUST_TIER_SCANNER_OPTIONS,
  CLAUDE_SKILLS_DIR,
  type InstallInput,
  type InstallResult,
} from './install.types.js'
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

// SMI-1788/SMI-2741: Optimization layer extracted to companion file
import { applySkillOptimization } from './install.optimize.js'
// SMI-3137: Dependency intelligence persistence
import { extractDepIntel, persistDependencies } from './install.dep-helpers.js'

// SMI-2741: MCP tool definition extracted to companion file
export { installTool } from './install.tool.js'
export { default } from './install.tool.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export { installInputSchema, type InstallInput, type InstallResult } from './install.types.js'

/**
 * Install a skill from GitHub to the local Claude Code skills directory.
 *
 * @param input - Installation parameters (skillId, force, skipScan)
 * @param _context - Optional tool context (falls back to singleton)
 * @returns Installation result with success status, security report, and dep intel
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

      // SMI-2383: Block installation of quarantined skills
      if (registrySkill.quarantined) {
        return {
          success: false,
          skillId: input.skillId,
          installPath: '',
          error:
            'Skill "' +
            input.skillId +
            '" has been quarantined due to security concerns. ' +
            'Installation is blocked to protect your environment.',
          tips: [
            'Visit https://skillsmith.app/docs/quarantine for details on quarantine policies',
            'If you believe this is a false positive, contact support via https://skillsmith.app/contact?topic=security',
            'You can install from a direct GitHub URL to bypass registry quarantine (at your own risk)',
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

    // SMI-2723: Track whether this install originated from a registry lookup so that
    // SKILL.md fetch failures can surface registry data quality issues instead of
    // misleading "path format" error messages.
    const fromRegistry = parsed.isRegistryId

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
    // SMI-1895: Track backup path to include in result
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
      // SMI-2723: Distinguish registry data quality issues from user path errors
      const repoUrl = 'https://github.com/' + owner + '/' + repo
      return {
        success: false,
        skillId: input.skillId,
        installPath,
        error: fromRegistry
          ? 'This skill is indexed in the Skillsmith registry but its installation source ' +
            'appears broken (SKILL.md not found at ' +
            (basePath || 'repository root') +
            '). ' +
            'This is a registry data quality issue — the path registered does not match the ' +
            'actual repository structure. ' +
            'Please report it at https://skillsmith.app/contact?topic=registry-quality. ' +
            'Repository: ' +
            repoUrl
          : 'Could not find SKILL.md at ' +
            (basePath || 'repository root') +
            '. ' +
            'Skills must have a SKILL.md file with YAML frontmatter (name, description) to be installable. ' +
            'Repository: ' +
            repoUrl,
        tips: fromRegistry
          ? [
              'This is a registry data quality issue, not a path format error',
              'The other skills in this repository may still be installable',
              'Report the broken entry: https://skillsmith.app/contact?topic=registry-quality',
              'Workaround: clone the repo and manually copy the skill directory to ~/.claude/skills/',
            ]
          : [
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
      // SMI-1895: Capture backup path from merge operation
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
          'See template: https://github.com/wrsmith108/skillsmith/blob/main/.claude/templates/skill-template.md',
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
    const optimizeResult = input.skipOptimize
      ? {
          finalSkillContent: skillMdContent,
          subSkillFiles: [] as Array<{ filename: string; content: string }>,
          subagentContent: undefined as string | undefined,
          claudeMdSnippet: undefined as string | undefined,
          optimizationInfo: { optimized: false as const },
        }
      : await applySkillOptimization(input.skillId, skillName, skillMdContent, context.db)

    const { finalSkillContent, subSkillFiles, subagentContent, claudeMdSnippet, optimizationInfo } =
      optimizeResult

    // SMI-1867: Compute hash before file operations (needed in manifest update)
    const contentHash = hashContent(finalSkillContent)

    // SMI-1792, SMI-1797: Atomic file installation with transaction pattern
    // SMI-1804: Parallelize file writes for better performance
    const writtenFiles: string[] = []
    try {
      // Create installation directory
      await fs.mkdir(installPath, { recursive: true })

      // SMI-2287: Validate directory is not a symlink escape
      const realInstallPath = await fs.realpath(installPath)
      const expectedPrefix = path.resolve(CLAUDE_SKILLS_DIR)
      if (
        !realInstallPath.startsWith(expectedPrefix + path.sep) &&
        realInstallPath !== expectedPrefix
      ) {
        throw new Error(`Install path escapes skills directory: ${installPath}`)
      }

      // Write SKILL.md (optimized or original)
      // SMI-2274: Use safeWriteFile to prevent symlink attacks
      const mainSkillPath = path.join(installPath, 'SKILL.md')
      await safeWriteFile(mainSkillPath, finalSkillContent)
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
            await safeWriteFile(subPath, subSkill.content)
            writtenFiles.push(subPath)
          })
        )
      }

      // Write companion subagent if generated
      if (subagentContent) {
        const agentsDir = path.join(os.homedir(), '.claude', 'agents')
        await fs.mkdir(agentsDir, { recursive: true })
        const subagentPath = path.join(agentsDir, `${skillName}-specialist.md`)
        await safeWriteFile(subagentPath, subagentContent)
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

        await safeWriteFile(path.join(installPath, file), content)
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

    // SMI-2761: Record session co-install pairs for "also installed" recommendations
    context.coInstallRepository.recordSessionCoInstalls([
      ...context.sessionInstalledSkillIds,
      input.skillId,
    ])
    context.sessionInstalledSkillIds.push(input.skillId)

    // SMI-3137: Extract and persist dependency intelligence
    const depIntel = extractDepIntel(skillMdContent, null)
    try {
      persistDependencies(
        context.skillDependencyRepository,
        input.skillId,
        skillMdContent,
        depIntel.dep_declared
      )
    } catch {
      // Dependency persistence is best-effort
    }

    return {
      success: true,
      skillId: input.skillId,
      installPath,
      securityReport,
      trustTier, // SMI-1533: Include trust tier in result
      optimization: optimizationInfo,
      backupPath, // SMI-1895: Include backup path if created during conflict resolution
      depIntel, // SMI-3137: Dependency intelligence
      tips: generateOptimizedTips(skillName, optimizationInfo, claudeMdSnippet),
    }
  } catch (error) {
    // SMI-1793: Sanitize error messages to avoid exposing internal details
    let safeErrorMessage = 'Installation failed'
    if (error instanceof Error) {
      // Allow specific known error types through
      const knownPrefixes = [
        'already installed',
        'Could not find SKILL.md',
        'registry data quality issue',
        'Invalid SKILL.md',
        'Security scan failed',
        'exceeds maximum length',
        'Refusing to write to symlink',
        'Refusing to write to hardlinked file',
        'Install path escapes skills directory',
      ]
      if (knownPrefixes.some((p) => error.message.includes(p))) {
        safeErrorMessage = error.message
      } else {
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
