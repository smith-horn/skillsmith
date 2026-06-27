/**
 * @fileoverview Public surface of the skill source provenance recovery module.
 * @module @skillsmith/core/provenance
 * @see SMI-5407
 */

export { parseGitConfigRemote, normalizeGitHubRemote } from './git-config.js'
export { parsePluginManifestRepository } from './plugin-manifest.js'
export { scanLocalSkills, type LocalSkillEntry } from './local-skill-scan.js'
export {
  SourceRecoveryService,
  defaultSkillsRoot,
  type RecoverSourcesOptions,
  type RecoverOneOptions,
} from './SourceRecoveryService.js'
export { backfillManifest, type BackfillOptions, type BackfillOutcome } from './backfill.js'
export {
  METHOD_LABELS,
  type RecoveryMethod,
  type RecoveryConfidence,
  type RecoveredSource,
  type RecoveryCandidate,
  type SkillRecoveryStatus,
  type SkillRecoveryResult,
  type RecoverySummary,
  type RecoveryReport,
  type RecoveryDeps,
} from './types.js'
