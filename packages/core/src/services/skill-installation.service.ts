/** @fileoverview SkillInstallationService — shared install/uninstall business logic (SMI-3483) */
import * as path from 'path'
import * as os from 'os'
import type { TrustTier } from '../types/skill.js'
import type { SkillRepository } from '../repositories/SkillRepository.js'
import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'
import type { RiskScoreHistoryRepository } from '../repositories/RiskScoreHistoryRepository.js'
import type { Database } from '../db/database-interface.js'
import {
  type ProgressCallback,
  type InstallOptions,
  type InstallResult,
  type InstallFromContentOptions,
  type UninstallOptions,
  type UninstallResult,
  type RegistryLookup,
  type CoInstallRecorder,
  type QuarantineStatus,
  type AiDefenceFeedback,
} from './skill-installation.types.js'
import { installFromContent } from './skill-installation.content.js'
import { installedSkillsOf, ManifestManager } from './skill-manifest.js'
import {
  hashContent,
  applyOptimization,
  performUninstall,
  sanitizeInstallError,
  manifestKeyFor,
} from './skill-installation.helpers.js'
import { CANONICAL_CLIENT, type ClientId } from '../install/paths.js'
import { writeInstallFiles } from './skill-installation.io.js'
import {
  fetchAndScanOptional,
  fetchAndScanSkillMd,
  resolveInstallSource,
} from './skill-installation.fetch-scan.js'
import { buildInstallFailure } from './skill-installation.errors.js'
import { checkInstallTarget } from './skill-installation.target-guard.js'
import { finalizeSuccessfulInstall } from './skill-installation.service.finalize.js'
import { updateInPlace } from './skill-update.js'
import type { UpdateInPlaceOptions, UpdatePlan, UpdateResult } from './skill-update.types.js'
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
  /**
   * SMI-5894 (Wave 1 Step 3): the client this install/uninstall targets.
   * Defaults to the canonical client (`claude-code`) — every existing
   * caller that doesn't pass it (MCP's install/uninstall tools, and any
   * pre-Wave-1 test) keeps writing/reading manifest entries under the
   * legacy bare-name key, unchanged. Only used for manifest keying
   * (`manifestKeyFor`) and post-install tips — callers still supply their
   * own already-resolved `skillsDir` (e.g. via `resolveClientPath`/
   * `getInstallPath`); this does not re-derive `skillsDir` from `client`.
   */
  client?: ClientId
  // SMI-5982: base dir for a relative companion-agent target (Antigravity); never defaults to process.cwd() — omission fails closed via resolveCompanionAgentPath()'s required-baseDir guard.
  companionBaseDir?: string
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
  private readonly client: ClientId
  private readonly companionBaseDir: string | undefined
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
    this.client = params.client ?? CANONICAL_CLIENT
    this.companionBaseDir = params.companionBaseDir // no `?? process.cwd()` — see doc above
  }
  async install(skillId: string, options: InstallOptions = {}): Promise<InstallResult> {
    let trustTier: TrustTier = 'unknown'
    try {
      // SMI-6531 A1 step 7b: parse, fetch and scan are shared with the in-place
      // update planner (`skill-installation.fetch-scan.ts`, moved unchanged).
      const resolved = await resolveInstallSource(skillId, this.registryLookup, this.onProgress)
      if (!resolved.ok) return resolved.result
      const source = resolved.value
      const { owner, repo, skillName } = source
      trustTier = source.trustTier

      const installPath = path.join(this.skillsDir, skillName)
      this.onProgress('manifest', 'Checking manifest')
      const manifest = await this.manifest.load()
      const manifestKey = manifestKeyFor(skillName, this.client)
      // SMI-6529 Wave A0: pre-write install-target safety guard — refuses an
      // untracked pre-existing directory, a git working tree, or (when `update`
      // sets `expectedInstallPath`) a write anywhere other than the directory it
      // diffed against. Runs BEFORE any content fetch or disk write. Replaces
      // the bare manifest-membership ALREADY_INSTALLED check this used to be.
      const targetCheck = await checkInstallTarget({
        installPath,
        skillsDir: this.skillsDir,
        // SMI-6733 MAJOR 3: a nullish `installedSkills` classifies `ok`, so a
        // bare subscript here type-checks and throws at runtime.
        manifestEntry: installedSkillsOf(manifest)[manifestKey],
        force: options.force ?? false,
        expectedInstallPath: options.expectedInstallPath,
      })
      if (!targetCheck.ok) {
        return buildInstallFailure(targetCheck.code, {
          skillId,
          installPath,
          trustTier,
          error: targetCheck.error,
          ...(targetCheck.tips !== undefined && { tips: targetCheck.tips }),
        })
      }
      // Fetch and validate SKILL.md, the skip-scan gate, the scan and the confirmation gate.
      const skillMd = await fetchAndScanSkillMd(source, {
        skillId,
        installPath,
        skipScan: options.skipScan,
        confirmed: options.confirmed,
        onProgress: this.onProgress,
        aiDefenceFeedback: this.aiDefenceFeedback,
      })
      if (!skillMd.ok) return skillMd.result
      const { skillMdContent, contentHashMismatch, securityReport } = skillMd.value
      this.onProgress('optimize', 'Applying optimization')
      const optimizeResult = options.skipOptimize
        ? {
            finalSkillContent: skillMdContent,
            subSkillFiles: [] as Array<{ filename: string; content: string }>,
            subagentContent: undefined as string | undefined,
            claudeMdSnippet: undefined as string | undefined,
            optimizationInfo: { optimized: false as const },
          }
        : await applyOptimization(this.db, skillId, skillName, skillMdContent, this.client)

      const { finalSkillContent, subSkillFiles, subagentContent, optimizationInfo } = optimizeResult
      const contentHash = hashContent(finalSkillContent)
      // SMI-5359 Gap-1: fetch + scan optional files BEFORE writing anything, so a
      // malicious optional file rejects the install with no files stranded on disk.
      // (H4: previously writeInstallFiles ran first, so a post-write reject left
      // SKILL.md orphaned; the optional scan also silently `continue`d on failure.)
      const optional = await fetchAndScanOptional(source, skillId, installPath, options.skipScan)
      if (!optional.ok) return optional.result
      const optionalFiles = optional.value
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
        subagentContent,
        this.client,
        this.companionBaseDir
      )
      if (writeResult.subagentPath) {
        optimizationInfo.subagentPath = writeResult.subagentPath
      }
      // SMI-6529 M10: a companion agent file was left untouched because this
      // was a fresh install and something already occupied the target path.
      const extraTips: string[] = []
      if (writeResult.companionSkipped) {
        extraTips.push(
          'A companion agent file already existed at the target location and was not overwritten (fresh install). Remove it manually if you want Skillsmith to regenerate it.'
        )
      }
      // SMI-6529 (Wave A0): everything after a successful write — manifest
      // update, best-effort dependency/quarantine/trend/AI-defence bookkeeping,
      // and the final result — moved to a sibling module (pure move, no
      // behavior change) to keep this file under the 500-line CI gate once
      // the target guard above was added.
      try {
        return await finalizeSuccessfulInstall({
          manifest: this.manifest,
          coInstallRecorder: this.coInstallRecorder,
          sessionInstalledSkillIds: this.sessionInstalledSkillIds,
          skillDependencyRepo: this.skillDependencyRepo,
          quarantineLookup: this.quarantineLookup,
          riskHistoryRepo: this.riskHistoryRepo,
          aiDefenceFeedback: this.aiDefenceFeedback,
          onProgress: this.onProgress,
          client: this.client,
          skillsDir: this.skillsDir,
          skillId,
          owner,
          repo,
          skillName,
          installPath,
          manifestKey,
          contentHash,
          skillMdContent,
          optimizationInfo,
          securityReport,
          configWarnings: optionalFiles.configWarnings,
          skipScanRequested: options.skipScan,
          contentHashMismatch,
          trustTier,
          extraTips,
        })
      } catch (finalizeError) {
        // SMI-6529 M7: the write itself already succeeded — a failure HERE
        // (the manifest update, the only step in finalizeSuccessfulInstall
        // that can actually throw) must undo it via the SAME rollback logic
        // writeInstallFiles runs on its own internal failure, or the skill
        // is left on disk with no manifest entry at all. `rollback()` throws
        // an InstallRestoreError instead if the restore itself also fails,
        // which supersedes `finalizeError` below.
        await writeResult.rollback(finalizeError)
        throw finalizeError
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

  /**
   * SMI-5905 Wave 1: install an already-resolved private-registry skill's
   * content to disk. Thin delegate — see skill-installation.content.ts for
   * the full implementation and its documented scope trim vs. install().
   */
  async installFromContent(options: InstallFromContentOptions): Promise<InstallResult> {
    return installFromContent({
      ...options,
      db: this.db,
      skillsDir: this.skillsDir,
      manifest: this.manifest,
      client: this.client,
      companionBaseDir: this.companionBaseDir,
      onProgress: this.onProgress,
    })
  }

  /**
   * SMI-6531 A1 step 7b: updates an existing tracked folder in place from a
   * plan `planSkillUpdate` built (`skill-update.ts`). No production caller
   * until A1 step 9; `update` still calls `install()`.
   */
  async updateInPlace(plan: UpdatePlan, options: UpdateInPlaceOptions = {}): Promise<UpdateResult> {
    return updateInPlace(plan, { onProgress: this.onProgress, ...options })
  }

  async uninstall(skillName: string, options: UninstallOptions = {}): Promise<UninstallResult> {
    return performUninstall({
      skillName,
      force: options.force ?? false,
      skillsDir: this.skillsDir,
      manifest: this.manifest,
      skillDependencyRepo: this.skillDependencyRepo,
      onProgress: this.onProgress,
      client: this.client,
    })
  }
}
