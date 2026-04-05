/** @fileoverview SkillInstallationService — shared install/uninstall business logic (SMI-3483) */
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SecurityScanner } from '../security/index.js'
import { safeWriteFile } from '../utils/safe-fs.js'
import { parseRepoUrl } from '../utils/github-url.js'
import type { TrustTier } from '../types/skill.js'
import type { SkillRepository } from '../repositories/SkillRepository.js'
import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'
import type { RiskScoreHistoryRepository } from '../repositories/RiskScoreHistoryRepository.js'
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
  type QuarantineStatus,
  type AiDefenceFeedback,
} from './skill-installation.types.js'
import { recordAiDefenceFeedback, collectTrendWarnings } from './skill-installation.feedback.js'
import { ManifestManager } from './skill-manifest.js'
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
  sanitizeInstallError,
  validateOptionalConfig,
  checkDepsAgainstQuarantine,
} from './skill-installation.helpers.js'
const DEFAULT_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')
const DEFAULT_MANIFEST_PATH = path.join(os.homedir(), '.skillsmith', 'manifest.json')
export interface SkillInstallationServiceParams {
  db: Database
  skillRepo: SkillRepository
  skillDependencyRepo: SkillDependencyRepository
  skillsDir?: string
  manifestPath?: string
  onProgress?: ProgressCallback
  registryLookup?: RegistryLookup
  coInstallRecorder?: CoInstallRecorder
  sessionInstalledSkillIds?: string[]
  quarantineLookup?: (skillId: string) => QuarantineStatus | null // SMI-3871
  riskHistoryRepo?: RiskScoreHistoryRepository // SMI-3874
  aiDefenceFeedback?: AiDefenceFeedback // SMI-3873
}
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
  private readonly quarantineLookup?: (skillId: string) => QuarantineStatus | null
  private readonly riskHistoryRepo?: RiskScoreHistoryRepository
  private readonly aiDefenceFeedback?: AiDefenceFeedback
  constructor(params: SkillInstallationServiceParams) {
    this.db = params.db
    this.skillRepo = params.skillRepo
    this.skillDependencyRepo = params.skillDependencyRepo
    this.skillsDir = params.skillsDir ?? DEFAULT_SKILLS_DIR
    this.manifest = new ManifestManager(params.manifestPath ?? DEFAULT_MANIFEST_PATH)
    this.onProgress = params.onProgress ?? (() => {})
    this.registryLookup = params.registryLookup
    this.coInstallRecorder = params.coInstallRecorder
    this.quarantineLookup = params.quarantineLookup
    this.riskHistoryRepo = params.riskHistoryRepo
    this.aiDefenceFeedback = params.aiDefenceFeedback
    this.sessionInstalledSkillIds = params.sessionInstalledSkillIds ?? []
  }
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
      let indexedContentHash: string | undefined
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
        indexedContentHash = registrySkill.contentHash
      } else {
        owner = parsed.owner
        repo = parsed.repo
        basePath = parsed.path ? parsed.path + '/' : ''
        skillName = parsed.path ? path.basename(parsed.path) : repo
      }

      const installPath = path.join(this.skillsDir, skillName)
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
            ? 'This skill is indexed in the Skillsmith registry but its installation source appears broken (SKILL.md not found at ' +
              (basePath || 'repository root') +
              '). This is a registry data quality issue. Please report it at https://skillsmith.app/contact?topic=registry-quality. Repository: ' +
              repoUrl
            : 'Could not find SKILL.md at ' +
              (basePath || 'repository root') +
              '. Skills must have a SKILL.md file with YAML frontmatter to be installable. Repository: ' +
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

      const contentHashMismatch = // SMI-3510
        indexedContentHash != null ? hashContent(skillMdContent) !== indexedContentHash : false
      // Security scan — GAP-06: Restrict skipScan to trusted tiers only
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
          recordAiDefenceFeedback({
            feedback: this.aiDefenceFeedback,
            skillMdContent,
            scanReport: securityReport,
            blocked: true,
          })
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

      // SMI-3863: Pre-install confirmation gate for experimental/unknown registry skills
      const needsConfirmation =
        fromRegistry &&
        (trustTier === 'experimental' || trustTier === 'unknown') &&
        !options.confirmed
      if (needsConfirmation) {
        const scanNote = securityReport
          ? securityReport.passed
            ? trustTier + ' tier skills have not been reviewed.'
            : 'Security scan detected issues.'
          : 'No security scan was performed.'
        return {
          success: false,
          skillId,
          installPath,
          securityReport,
          trustTier,
          requiresConfirmation: true,
          confirmationReason:
            'This is an ' +
            trustTier +
            ' tier skill. ' +
            scanNote +
            ' Re-run with confirmed=true to proceed.',
          tips: ['Trust tier: ' + trustTier, 'Use confirmed=true to proceed with installation'],
        }
      }
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
      const configWarnings: string[] = []
      for (const file of optionalFiles) {
        try {
          const content = await fetchFromGitHub(owner, repo, basePath + file, branch)
          if (optionalFileScanner) {
            const fileScan = optionalFileScanner.scan(skillId + '/' + file, content)
            if (!fileScan.passed) continue
          }
          if (file === 'config.json') {
            const configCheck = validateOptionalConfig(content)
            if (!configCheck.valid) continue // SMI-3870: skip invalid config
            configWarnings.push(...configCheck.warnings)
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
            originalContentHash: contentHash, // hash of optimized content (post-applyOptimization)
          },
        },
      }))
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
        /* best-effort */
      }
      let quarantinedDeps: string[] | undefined // SMI-3871
      if (this.quarantineLookup) {
        try {
          const dqResult = checkDepsAgainstQuarantine(depIntel, this.quarantineLookup)
          if (dqResult.quarantinedDeps.length > 0) {
            quarantinedDeps = dqResult.quarantinedDeps
            depIntel.dep_warnings.push(...dqResult.warnings)
          }
        } catch {
          /* best-effort */
        }
      }
      const trendWarnings = securityReport
        ? collectTrendWarnings({
            historyRepo: this.riskHistoryRepo,
            skillId,
            scanReport: securityReport,
            contentHash,
          })
        : []
      recordAiDefenceFeedback({
        feedback: this.aiDefenceFeedback,
        skillMdContent,
        scanReport: securityReport,
        blocked: false,
      })
      this.onProgress('done', 'Installation complete')
      const tips = generateTips(skillName, optimizationInfo)
      tips.unshift(...trendWarnings)
      tips.push(...configWarnings)
      if (options.skipScan) {
        tips.unshift('Security scan was skipped. This skill was not scanned for malicious content.')
      }
      if (contentHashMismatch) {
        tips.unshift(
          "Content has changed since Skillsmith last indexed this skill. This may mean the author updated it, or the content was modified. Review recent changes at the skill's repository before using."
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
        contentHashMismatch,
        quarantinedDeps,
        tips,
      }
    } catch (error) {
      return {
        success: false,
        skillId,
        installPath: '',
        error: sanitizeInstallError(error),
      }
    }
  }

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
