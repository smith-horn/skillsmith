/**
 * @fileoverview Post-write success path for SkillInstallationService.install().
 * @module @skillsmith/core/services/skill-installation.service.finalize
 * @see SMI-6529 Wave A0: pure move out of skill-installation.service.ts to make
 *   headroom for the pre-write target guard (checkInstallTarget) — no behavior
 *   change. Mirrors this service's existing domain-driven split convention
 *   (skill-installation.io.ts, skill-installation.content.ts, etc).
 *
 * Everything `install()` does AFTER `writeInstallFiles()` succeeds: update the
 * manifest, record co-install/dependency-intelligence/AI-defence signals
 * (all best-effort), and assemble the final `success: true` InstallResult.
 */

import type { ScanReport } from '../security/index.js'
import type { TrustTier } from '../types/skill.js'
import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'
import type { RiskScoreHistoryRepository } from '../repositories/RiskScoreHistoryRepository.js'
import type { ClientId } from '../install/paths.js'
import type { ManifestManager } from './skill-manifest.js'
import type {
  AiDefenceFeedback,
  CoInstallRecorder,
  InstallResult,
  OptimizationInfo,
  ProgressCallback,
  QuarantineStatus,
} from './skill-installation.types.js'
import { extractDepIntel, persistDependencies, generateTips } from './skill-installation.helpers.js'
import { checkDepsAgainstQuarantine } from './skill-installation.validate.js'
import { recordAiDefenceFeedback, collectTrendWarnings } from './skill-installation.feedback.js'

/** Everything {@link finalizeSuccessfulInstall} needs from the service and the install in progress. */
export interface FinalizeInstallParams {
  manifest: ManifestManager
  coInstallRecorder: CoInstallRecorder | undefined
  /** Mutated in place (pushed to) — same array the service instance owns. */
  sessionInstalledSkillIds: string[]
  skillDependencyRepo: SkillDependencyRepository
  quarantineLookup: ((skillId: string) => QuarantineStatus | null) | undefined
  riskHistoryRepo: RiskScoreHistoryRepository | undefined
  aiDefenceFeedback: AiDefenceFeedback | undefined
  onProgress: ProgressCallback
  client: ClientId
  skillsDir: string
  skillId: string
  owner: string
  repo: string
  skillName: string
  installPath: string
  manifestKey: string
  contentHash: string
  skillMdContent: string
  optimizationInfo: OptimizationInfo
  securityReport: ScanReport | undefined
  configWarnings: string[]
  skipScanRequested: boolean | undefined
  contentHashMismatch: boolean
  trustTier: TrustTier
  /**
   * SMI-6529 M10: extra tips to append verbatim after the standard set below
   * (e.g. a warning that a companion agent file was NOT overwritten because
   * it already existed on a fresh install). Optional — omitted callers see
   * no change in behavior.
   */
  extraTips?: string[]
}

/**
 * Everything after a successful `writeInstallFiles()`: manifest update,
 * best-effort dependency/quarantine/trend/AI-defence bookkeeping, and the
 * final `InstallResult`. Never throws for a best-effort step — only the
 * manifest update itself (via `updateSafely`) can propagate.
 */
export async function finalizeSuccessfulInstall(
  params: FinalizeInstallParams
): Promise<InstallResult> {
  const {
    manifest,
    coInstallRecorder,
    sessionInstalledSkillIds,
    skillDependencyRepo,
    quarantineLookup,
    riskHistoryRepo,
    aiDefenceFeedback,
    onProgress,
    client,
    skillsDir,
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
    configWarnings,
    skipScanRequested,
    contentHashMismatch,
    trustTier,
    extraTips,
  } = params

  onProgress('manifest', 'Updating manifest')
  await manifest.updateSafely((currentManifest) => ({
    ...currentManifest,
    installedSkills: {
      ...currentManifest.installedSkills,
      [manifestKey]: {
        id: skillId,
        name: skillName,
        version: '1.0.0',
        source: 'github:' + owner + '/' + repo,
        installPath,
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        originalContentHash: contentHash, // hash of optimized content (post-applyOptimization)
        client,
      },
    },
  }))
  // SMI-6529 N4 (round 4): best-effort — this call used to sit outside any
  // try/catch, so a throw from it (e.g. a SQLite busy/lock error) propagated
  // all the way out of `finalizeSuccessfulInstall()` AFTER the manifest write
  // above had already committed successfully. The caller (service.ts /
  // content.ts) treats ANY exception from this function as "undo the write,"
  // so an unrelated co-install-recording hiccup was rolling back files and a
  // manifest entry that were both already correct. Co-install session
  // tracking has no bearing on whether the install itself succeeded.
  if (coInstallRecorder) {
    try {
      coInstallRecorder.recordSessionCoInstalls([...sessionInstalledSkillIds, skillId])
      sessionInstalledSkillIds.push(skillId)
    } catch {
      /* best-effort */
    }
  }
  // Persist dependency intelligence (best-effort)
  const depIntel = extractDepIntel(skillMdContent)
  try {
    persistDependencies(skillDependencyRepo, skillId, skillMdContent, depIntel.dep_declared)
  } catch {
    /* best-effort */
  }
  let quarantinedDeps: string[] | undefined // SMI-3871
  if (quarantineLookup) {
    try {
      const dqResult = checkDepsAgainstQuarantine(depIntel, quarantineLookup)
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
        historyRepo: riskHistoryRepo,
        skillId,
        scanReport: securityReport,
        contentHash,
      })
    : []
  recordAiDefenceFeedback({
    feedback: aiDefenceFeedback,
    skillMdContent,
    scanReport: securityReport,
    blocked: false,
  })
  onProgress('done', 'Installation complete')
  const tips = generateTips(skillName, optimizationInfo, client, skillsDir)
  tips.unshift(...trendWarnings)
  tips.push(...configWarnings)
  if (skipScanRequested) {
    tips.unshift('Security scan was skipped. This skill was not scanned for malicious content.')
  }
  if (contentHashMismatch) {
    tips.unshift(
      "Content has changed since Skillsmith last indexed this skill. This may mean the author updated it, or the content was modified. Review recent changes at the skill's repository before using."
    )
  }
  if (extraTips && extraTips.length > 0) {
    tips.push(...extraTips)
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
}
