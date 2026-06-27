/** @fileoverview SkillInstallationService — shared install/uninstall business logic (SMI-3483) */
import * as path from 'path'
import * as os from 'os'
import { SecurityScanner } from '../security/index.js'
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
  hashContent,
  generateTips,
  extractDepIntel,
  persistDependencies,
  applyOptimization,
  performUninstall,
  sanitizeInstallError,
} from './skill-installation.helpers.js'
import {
  parseSkillIdInternal,
  validateSkillMd,
  checkDepsAgainstQuarantine,
  resolveRegistryInstall,
} from './skill-installation.validate.js'
import {
  fetchFromGitHub,
  writeInstallFiles,
  fetchAndScanOptionalFiles,
} from './skill-installation.io.js'
import { buildInstallFailure, buildConfirmationRequired } from './skill-installation.errors.js'
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
          return buildInstallFailure('REGISTRY_LOOKUP_UNAVAILABLE', {
            skillId,
            installPath: '',
            error:
              'Registry lookup not available. ' +
              'Use a full GitHub URL: install { skillId: "https://github.com/owner/repo" }',
          })
        }
        this.onProgress('lookup', 'Looking up skill in registry')
        const resolution = await resolveRegistryInstall(skillId, this.registryLookup)
        if (!resolution.resolved) return resolution.failure
        owner = resolution.owner
        repo = resolution.repo
        basePath = resolution.basePath
        branch = resolution.branch
        skillName = resolution.skillName
        trustTier = resolution.trustTier
        indexedContentHash = resolution.indexedContentHash
        fromRegistry = true
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
        return buildInstallFailure('ALREADY_INSTALLED', {
          skillId,
          installPath,
          trustTier,
          error: 'Skill "' + skillName + '" is already installed. Use force=true to reinstall.',
        })
      }
      this.onProgress('fetch', 'Fetching SKILL.md from GitHub')
      const skillMdPath = basePath + 'SKILL.md'
      let skillMdContent: string
      try {
        skillMdContent = await fetchFromGitHub(owner, repo, skillMdPath, branch)
      } catch {
        const repoUrl = 'https://github.com/' + owner + '/' + repo
        return buildInstallFailure('FETCH_FAILED', {
          skillId,
          installPath,
          trustTier,
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
        })
      }
      this.onProgress('validate', 'Validating SKILL.md')
      const validation = validateSkillMd(skillMdContent)
      if (!validation.valid) {
        return buildInstallFailure('VALIDATION_FAILED', {
          skillId,
          installPath,
          trustTier,
          error: 'Invalid SKILL.md: ' + validation.errors.join(', '),
          tips: [
            'SKILL.md must have YAML frontmatter with name and description fields',
            'Content must be at least 100 characters',
          ],
        })
      }

      const contentHashMismatch = // SMI-3510
        indexedContentHash != null ? hashContent(skillMdContent) !== indexedContentHash : false
      // Security scan — GAP-06: Restrict skipScan to trusted tiers only
      if (options.skipScan && (trustTier === 'experimental' || trustTier === 'unknown')) {
        return buildInstallFailure('SKIP_SCAN_FORBIDDEN', {
          skillId,
          installPath: '',
          trustTier,
          error:
            'Cannot skip security scan for ' +
            trustTier +
            ' tier skills. ' +
            'Only verified, curated, community, and local tier skills may use skipScan.',
          tips: [
            'Trust tier "' + trustTier + '" requires a security scan before installation',
            'If you believe this skill is safe, request a trust tier upgrade from the author',
          ],
        })
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

          return buildInstallFailure('SCAN_REJECTED', {
            skillId,
            installPath,
            trustTier,
            securityReport,
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
          })
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
        return buildConfirmationRequired({
          skillId,
          installPath,
          trustTier,
          securityReport,
          confirmationReason:
            'This is an ' +
            trustTier +
            ' tier skill. ' +
            scanNote +
            ' Re-run with confirmed=true to proceed.',
          tips: ['Trust tier: ' + trustTier, 'Use confirmed=true to proceed with installation'],
        })
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
      // SMI-5359 Gap-1: fetch + scan optional files BEFORE writing anything, so a
      // malicious optional file rejects the install with no files stranded on disk.
      // (H4: previously writeInstallFiles ran first, so a post-write reject left
      // SKILL.md orphaned; the optional scan also silently `continue`d on failure.)
      const optionalFiles = await fetchAndScanOptionalFiles(
        owner,
        repo,
        basePath,
        branch,
        skillId,
        options.skipScan ? null : TRUST_TIER_SCANNER_OPTIONS[trustTier]
      )
      if (optionalFiles.failedScans.length > 0) {
        const first = optionalFiles.failedScans[0]
        const crit = first.report.findings.filter(
          (f) => f.severity === 'critical' || f.severity === 'high'
        )
        const others = optionalFiles.failedScans.slice(1).map((s) => s.file)
        return buildInstallFailure('SCAN_REJECTED', {
          skillId,
          installPath,
          trustTier,
          securityReport: first.report,
          error:
            'Optional file "' +
            first.file +
            '" failed the security scan with ' +
            crit.length +
            ' critical/high finding(s) (risk score ' +
            first.report.riskScore +
            ').',
          tips: [
            'Rejected optional file: ' + first.file,
            'Risk score: ' + first.report.riskScore,
            ...(others.length > 0 ? ['Other rejected optional files: ' + others.join(', ')] : []),
          ],
        })
      }
      this.onProgress('write', 'Writing skill files')
      // Optional files ride writeInstallFiles' rollback alongside the sub-skills.
      // Dedupe by filename first: a generated sub-skill and a repo optional file
      // could collide (e.g. examples.md), which would race in writeInstallFiles'
      // Promise.all. Drop the colliding sub-skill so the optional wins — matching
      // the prior behavior (optional files were written last, after the sub-skills).
      const subSkillsNoCollision = subSkillFiles.filter(
        (s) => !optionalFiles.filesToWrite.some((o) => o.filename === s.filename)
      )
      const writeResult = await writeInstallFiles(
        installPath,
        this.skillsDir,
        skillName,
        finalSkillContent,
        [...subSkillsNoCollision, ...optionalFiles.filesToWrite],
        subagentContent
      )
      if (writeResult.subagentPath) {
        optimizationInfo.subagentPath = writeResult.subagentPath
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
      tips.push(...optionalFiles.configWarnings)
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
      return buildInstallFailure('UNKNOWN', {
        skillId,
        installPath: '',
        trustTier,
        error: sanitizeInstallError(error),
      })
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
