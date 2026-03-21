/**
 * @fileoverview SkillInstallationService — shared install/uninstall business logic
 * @module @skillsmith/core/services/skill-installation.service
 * @see SMI-3483: Wave 0 — Extract SkillInstallationService into core
 *
 * Both mcp-server and CLI consume this service. The MCP ToolContext coupling is
 * eliminated: callers inject explicit dependencies (db, repositories, paths,
 * registry lookup, progress callback).
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

import { SecurityScanner } from '../security/index.js'
import { safeWriteFile } from '../utils/safe-fs.js'
import { parseRepoUrl } from '../utils/github-url.js'
import type { TrustTier } from '../types/skill.js'
import type { SkillRepository } from '../repositories/SkillRepository.js'
import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'
import type { Database } from '../db/database-interface.js'

import {
  TRUST_TIER_SCANNER_OPTIONS,
  type ProgressCallback,
  type InstallOptions,
  type InstallResult,
  type UninstallOptions,
  type UninstallResult,
  type RegistryLookup,
  type CoInstallRecorder,
} from './skill-installation.types.js'

import { ManifestManager } from './skill-manifest.js'

// SMI-3483: Helpers split to companion file to meet 500-line standard
import {
  parseSkillIdInternal,
  hashContent,
  validateSkillMd,
  fetchFromGitHub,
  generateTips,
  extractDepIntel,
  persistDependencies,
  applyOptimization,
  performUninstall,
} from './skill-installation.helpers.js'

const DEFAULT_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')
const DEFAULT_SKILLSMITH_DIR = path.join(os.homedir(), '.skillsmith')
const DEFAULT_MANIFEST_PATH = path.join(DEFAULT_SKILLSMITH_DIR, 'manifest.json')

export interface SkillInstallationServiceParams {
  db: Database
  skillRepo: SkillRepository
  skillDependencyRepo: SkillDependencyRepository
  /** Directory where skills are installed. Default: ~/.claude/skills */
  skillsDir?: string
  /** Path to the manifest file. Default: ~/.skillsmith/manifest.json */
  manifestPath?: string
  /** Progress callback for reporting stages */
  onProgress?: ProgressCallback
  /** Registry lookup abstraction (API-first for mcp-server, simpler for CLI) */
  registryLookup?: RegistryLookup
  /** Co-install recorder for "also installed" recommendations */
  coInstallRecorder?: CoInstallRecorder
  /** Skill IDs installed in this session (for co-install tracking) */
  sessionInstalledSkillIds?: string[]
}

// ============================================================================
// Service
// ============================================================================

export class SkillInstallationService {
  private readonly db: Database
  private readonly skillRepo: SkillRepository
  private readonly skillDependencyRepo: SkillDependencyRepository
  private readonly skillsDir: string
  private readonly manifest: ManifestManager
  private readonly onProgress: ProgressCallback
  private readonly registryLookup?: RegistryLookup
  private readonly coInstallRecorder?: CoInstallRecorder
  private readonly sessionInstalledSkillIds: string[]

  constructor(params: SkillInstallationServiceParams) {
    this.db = params.db
    this.skillRepo = params.skillRepo
    this.skillDependencyRepo = params.skillDependencyRepo
    this.skillsDir = params.skillsDir ?? DEFAULT_SKILLS_DIR
    this.manifest = new ManifestManager(params.manifestPath ?? DEFAULT_MANIFEST_PATH)
    this.onProgress = params.onProgress ?? (() => {})
    this.registryLookup = params.registryLookup
    this.coInstallRecorder = params.coInstallRecorder
    this.sessionInstalledSkillIds = params.sessionInstalledSkillIds ?? []
  }

  // ==========================================================================
  // Install
  // ==========================================================================

  async install(skillId: string, options: InstallOptions = {}): Promise<InstallResult> {
    let trustTier: TrustTier = 'unknown'

    try {
      this.onProgress('parse', 'Parsing skill ID')
      const parsed = parseSkillIdInternal(skillId)

      let owner: string
      let repo: string
      let basePath: string
      let skillName: string
      let branch: string = 'main'
      let fromRegistry = false

      if (parsed.isRegistryId) {
        if (!this.registryLookup) {
          return {
            success: false,
            skillId,
            installPath: '',
            error:
              'Registry lookup not available. ' +
              'Use a full GitHub URL: install { skillId: "https://github.com/owner/repo" }',
          }
        }

        this.onProgress('lookup', 'Looking up skill in registry')
        const registrySkill = await this.registryLookup.lookup(skillId)

        if (!registrySkill) {
          return {
            success: false,
            skillId,
            installPath: '',
            error:
              'Skill "' +
              skillId +
              '" is indexed for discovery only. ' +
              'No installation source available (repo_url is missing). ' +
              'This may be placeholder/seed data or a metadata-only entry.',
            tips: [
              'Use a full GitHub URL instead: install { skillId: "https://github.com/owner/repo" }',
              'Search for installable skills using the search tool',
              'Many indexed skills are metadata-only and cannot be installed directly',
            ],
          }
        }

        if (registrySkill.quarantined) {
          return {
            success: false,
            skillId,
            installPath: '',
            error:
              'Skill "' +
              skillId +
              '" has been quarantined due to security concerns. ' +
              'Installation is blocked to protect your environment.',
            tips: [
              'Visit https://skillsmith.app/docs/quarantine for details on quarantine policies',
              'If you believe this is a false positive, contact support via https://skillsmith.app/contact?topic=security',
              'Contact the skill author or visit the quarantine documentation for more information',
            ],
          }
        }

        const repoInfo = parseRepoUrl(registrySkill.repoUrl)
        owner = repoInfo.owner
        repo = repoInfo.repo
        basePath = repoInfo.path ? repoInfo.path + '/' : ''
        branch = repoInfo.branch
        skillName = registrySkill.name
        trustTier = registrySkill.trustTier
        fromRegistry = true
      } else {
        owner = parsed.owner
        repo = parsed.repo
        basePath = parsed.path ? parsed.path + '/' : ''
        skillName = parsed.path ? path.basename(parsed.path) : repo
      }

      const installPath = path.join(this.skillsDir, skillName)

      // Check if already installed
      this.onProgress('manifest', 'Checking manifest')
      const manifest = await this.manifest.load()
      if (manifest.installedSkills[skillName] && !options.force) {
        return {
          success: false,
          skillId,
          installPath,
          error: 'Skill "' + skillName + '" is already installed. Use force=true to reinstall.',
        }
      }

      // Fetch SKILL.md
      this.onProgress('fetch', 'Fetching SKILL.md from GitHub')
      const skillMdPath = basePath + 'SKILL.md'
      let skillMdContent: string
      try {
        skillMdContent = await fetchFromGitHub(owner, repo, skillMdPath, branch)
      } catch {
        const repoUrl = 'https://github.com/' + owner + '/' + repo
        return {
          success: false,
          skillId,
          installPath,
          error: fromRegistry
            ? 'This skill is indexed in the Skillsmith registry but its installation source ' +
              'appears broken (SKILL.md not found at ' +
              (basePath || 'repository root') +
              '). ' +
              'This is a registry data quality issue. ' +
              'Please report it at https://skillsmith.app/contact?topic=registry-quality. ' +
              'Repository: ' +
              repoUrl
            : 'Could not find SKILL.md at ' +
              (basePath || 'repository root') +
              '. ' +
              'Skills must have a SKILL.md file with YAML frontmatter to be installable. ' +
              'Repository: ' +
              repoUrl,
          tips: fromRegistry
            ? [
                'This is a registry data quality issue, not a path format error',
                'Report the broken entry: https://skillsmith.app/contact?topic=registry-quality',
              ]
            : [
                'This skill may be browse-only (no SKILL.md at expected location)',
                'Verify the repository exists: ' + repoUrl,
              ],
        }
      }

      // Validate SKILL.md
      this.onProgress('validate', 'Validating SKILL.md')
      const validation = validateSkillMd(skillMdContent)
      if (!validation.valid) {
        return {
          success: false,
          skillId,
          installPath,
          error: 'Invalid SKILL.md: ' + validation.errors.join(', '),
          tips: [
            'SKILL.md must have YAML frontmatter with name and description fields',
            'Content must be at least 100 characters',
          ],
        }
      }

      // Security scan
      // GAP-06: Restrict skipScan to trusted tiers only
      if (options.skipScan && (trustTier === 'experimental' || trustTier === 'unknown')) {
        return {
          success: false,
          skillId,
          installPath: '',
          error:
            'Cannot skip security scan for ' +
            trustTier +
            ' tier skills. ' +
            'Only verified, curated, community, and local tier skills may use skipScan.',
          tips: [
            'Trust tier "' + trustTier + '" requires a security scan before installation',
            'If you believe this skill is safe, request a trust tier upgrade from the author',
          ],
        }
      }

      let securityReport: InstallResult['securityReport']
      if (!options.skipScan) {
        this.onProgress('scan', 'Running security scan')
        const scannerOptions = TRUST_TIER_SCANNER_OPTIONS[trustTier]
        const scanner = new SecurityScanner(scannerOptions)
        securityReport = scanner.scan(skillId, skillMdContent)

        if (!securityReport.passed) {
          const criticalFindings = securityReport.findings.filter(
            (f) => f.severity === 'critical' || f.severity === 'high'
          )
          const tierContext =
            trustTier === 'unknown'
              ? ' (Direct GitHub install - strictest scanning applied)'
              : trustTier === 'experimental'
                ? ' (Experimental skill - aggressive scanning applied)'
                : ''

          return {
            success: false,
            skillId,
            installPath,
            securityReport,
            trustTier,
            error:
              'Security scan failed with ' +
              criticalFindings.length +
              ' critical/high findings' +
              tierContext +
              (trustTier === 'experimental' || trustTier === 'unknown'
                ? '. skipScan is not available for ' + trustTier + ' tier skills.'
                : '. Use skipScan=true to override (not recommended).'),
            tips: [
              'Trust tier: ' + trustTier + ' (threshold: ' + scannerOptions.riskThreshold + ')',
              'Risk score: ' + securityReport.riskScore,
            ],
          }
        }
      }

      // Optimization
      this.onProgress('optimize', 'Applying optimization')
      const optimizeResult = options.skipOptimize
        ? {
            finalSkillContent: skillMdContent,
            subSkillFiles: [] as Array<{ filename: string; content: string }>,
            subagentContent: undefined as string | undefined,
            claudeMdSnippet: undefined as string | undefined,
            optimizationInfo: { optimized: false as const },
          }
        : await applyOptimization(this.db, skillId, skillName, skillMdContent)

      const { finalSkillContent, subSkillFiles, subagentContent, optimizationInfo } = optimizeResult

      const contentHash = hashContent(finalSkillContent)

      // Write files
      this.onProgress('write', 'Writing skill files')
      const writtenFiles: string[] = []
      try {
        await fs.mkdir(installPath, { recursive: true })

        // Validate directory is not a symlink escape
        const realInstallPath = await fs.realpath(installPath)
        const expectedPrefix = path.resolve(this.skillsDir)
        if (
          !realInstallPath.startsWith(expectedPrefix + path.sep) &&
          realInstallPath !== expectedPrefix
        ) {
          throw new Error('Install path escapes skills directory: ' + installPath)
        }

        const mainSkillPath = path.join(installPath, 'SKILL.md')
        await safeWriteFile(mainSkillPath, finalSkillContent)
        writtenFiles.push(mainSkillPath)

        // Write sub-skills in parallel
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
          const subagentPath = path.join(agentsDir, skillName + '-specialist.md')
          await safeWriteFile(subagentPath, subagentContent)
          writtenFiles.push(subagentPath)
          optimizationInfo.subagentPath = subagentPath
        }
      } catch (writeError) {
        // Rollback on failure
        for (const filePath of writtenFiles) {
          await fs.unlink(filePath).catch(() => {})
        }
        await fs.rmdir(installPath).catch(() => {})
        throw writeError
      }

      // Fetch optional files
      const optionalFileScanner = options.skipScan
        ? null
        : new SecurityScanner(TRUST_TIER_SCANNER_OPTIONS[trustTier])
      const optionalFiles = ['README.md', 'examples.md', 'config.json']
      for (const file of optionalFiles) {
        try {
          const content = await fetchFromGitHub(owner, repo, basePath + file, branch)
          if (optionalFileScanner) {
            const fileScan = optionalFileScanner.scan(skillId + '/' + file, content)
            if (!fileScan.passed) {
              continue
            }
          }
          await safeWriteFile(path.join(installPath, file), content)
        } catch {
          // Optional files are fine to skip
        }
      }

      // Update manifest
      this.onProgress('manifest', 'Updating manifest')
      await this.manifest.updateSafely((currentManifest) => ({
        ...currentManifest,
        installedSkills: {
          ...currentManifest.installedSkills,
          [skillName]: {
            id: skillId,
            name: skillName,
            version: '1.0.0',
            source: 'github:' + owner + '/' + repo,
            installPath,
            installedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            originalContentHash: contentHash,
          },
        },
      }))

      // Record co-install session
      if (this.coInstallRecorder) {
        this.coInstallRecorder.recordSessionCoInstalls([...this.sessionInstalledSkillIds, skillId])
        this.sessionInstalledSkillIds.push(skillId)
      }

      // Persist dependency intelligence (best-effort)
      const depIntel = extractDepIntel(skillMdContent)
      try {
        persistDependencies(
          this.skillDependencyRepo,
          skillId,
          skillMdContent,
          depIntel.dep_declared
        )
      } catch {
        // Dependency persistence is best-effort
      }

      this.onProgress('done', 'Installation complete')

      const tips = generateTips(skillName, optimizationInfo)

      // GAP-06: Warn when skipScan was used (allowed tiers only reach here)
      if (options.skipScan) {
        tips.unshift(
          'Security scan was skipped. This skill was not scanned for malicious content.'
        )
      }

      return {
        success: true,
        skillId,
        installPath,
        securityReport,
        trustTier,
        optimization: optimizationInfo,
        depIntel,
        tips,
      }
    } catch (error) {
      let safeErrorMessage = 'Installation failed'
      if (error instanceof Error) {
        const knownPrefixes = [
          'already installed',
          'Could not find SKILL.md',
          'registry data quality issue',
          'Invalid SKILL.md',
          'Invalid skill ID format',
          'Security scan failed',
          'exceeds maximum length',
          'Refusing to write to symlink',
          'Refusing to write to hardlinked file',
          'Install path escapes skills directory',
        ]
        if (knownPrefixes.some((p) => error.message.includes(p))) {
          safeErrorMessage = error.message
        } else {
          safeErrorMessage = 'Installation failed due to an internal error'
        }
      }
      return {
        success: false,
        skillId,
        installPath: '',
        error: safeErrorMessage,
      }
    }
  }

  // ==========================================================================
  // Uninstall
  // ==========================================================================

  async uninstall(skillName: string, options: UninstallOptions = {}): Promise<UninstallResult> {
    return performUninstall({
      skillName,
      force: options.force ?? false,
      skillsDir: this.skillsDir,
      manifest: this.manifest,
      skillDependencyRepo: this.skillDependencyRepo,
      onProgress: this.onProgress,
    })
  }
}
