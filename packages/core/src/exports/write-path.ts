/**
 * SMI-6531 A1: the update write path's public surface (A1 plan §3.2-§3.4): lock 1 and the
 * staging binding, the `.gitignore` hints, the tree primitives, the staged swap and the
 * absent-root rule. Re-exported from the package root by `index.ts`.
 *
 * @module @skillsmith/core/exports/write-path
 */
// SMI-6531 A1 step 2: lock 1, the per-skills-root write lock (plan §3.2, §3.3).
export {
  bindSkillsRoot,
  bindSkillsRootReadOnly,
  checkSkillsRootBinding,
  SKILL_WRITE_LOCK_BASENAME,
  skillsRootLockPaths,
  SkillWriteStop,
  STAGING_DIR_NAME,
  withSkillWriteLock,
  type CheckScope,
  type SkillsRootBinding,
  type SkillWriteContext,
  type SkillWriteLockOptions,
  type SkillWriteResult,
  type SkillWriteStopCode,
} from '../services/skill-write-lock.js'
// SMI-6531 A1 step 2: the hardened `git check-ignore` hint (computed after lock 1 is released).
export {
  PARKED_GITIGNORE_HINT,
  parkedAreaGitignoreHint,
  STAGING_GITIGNORE_HINT,
  stagingGitignoreHint,
  type GitignoreHintOptions,
} from '../services/skill-write-lock.gitignore.js'
// SMI-6531 A1 step 3: the tree hash, the no-follow copy and claim-publish (plan §3.4).
export {
  claimPublish,
  copyTreeNoFollow,
  treeHashOf,
  type ClaimPublishResult,
  type CopyFailureReason,
  type CopyResult,
  type TreeHashResult,
} from '../services/skill-tree.js'
// SMI-6531 A1 step 7a: the manifest port, its entry model and the canonical form its CAS compares.
export {
  canonicalize,
  canonicalJson,
  type JsonObject,
  type JsonValue,
} from '../services/skill-manifest.canonical.js'
export {
  buildPostEntry,
  classifyEntry,
  ENTRY_WRITABLE_FIELDS,
  ManifestEntryChanged,
  rawEntryAt,
  readEntryState,
  type EntryState,
  type EntryWritable,
  type EntryWritableField,
} from '../services/skill-manifest.entry.js'
export {
  createManifestPort,
  type ManifestPortOptions,
  type ManifestPortTarget,
} from '../services/skill-manifest.port.js'
export { withManifestLockHeld, type ManifestLockHold } from '../services/skill-manifest.lock.js'
// SMI-6531 A1 steps 4a-4c: the in-place update transaction, on one device and across devices (plan §3.3).
export {
  computeRecordSha256,
  swapInPlace,
  type ManifestCommitHandle,
  type ManifestPort,
  type SwapHookPoint,
  type SwapIncomplete,
  type SwapInput,
  type SwapOptions,
  type SwapRecord,
  type SwapRefuseReason,
  type SwapResult,
  type SwapStopReason,
  type SwapWarning,
  type SwapWriteEntry,
  type TraceOp,
} from '../services/skill-swap.js'
// SMI-6531 A1 step 7b: the in-place update of a tracked folder: target, plan, execute (plan §3.1, §3.7).
export {
  buildUpdateTarget,
  type BuildUpdateTargetInput,
  type BuildUpdateTargetOptions,
} from '../services/skill-update.target.js'
export { manifestKeyOwner, type RealPathOf } from '../services/skill-update.owner.js'
export { planSkillUpdate, type PlanSkillUpdateInput } from '../services/skill-update.plan.js'
export { recoveryNextStep, updateInPlace } from '../services/skill-update.js'
export type {
  PlannedFile,
  UpdateInPlaceOptions,
  UpdatePlan,
  UpdateRefusal,
  UpdateRefusalReason,
  UpdateResult,
  UpdateTarget,
  UpdateTargetResult,
} from '../services/skill-update.types.js'
// SMI-6531 A1 step 5: the record scan of `.skillsmith-staging/` (plan §3.3 step 3, R1).
export {
  isSwapRecord,
  recordsNaming,
  scanStagingRecords,
  type PendingRecord,
  type RecordScan,
  type UnreadableRecord,
  type UnreadableRecordWhy,
} from '../services/skill-swap.records.js'
// SMI-6531 A1 step 4a: the absent-root rule (UD22), run by `swapInPlace` before R is bound.
export {
  ensureSkillsRoot,
  type EnsureRootOptions,
  type EnsureRootResult,
  type EnsureRootTraceOp,
} from '../services/skill-root.ensure.js'
// The types of `SkillsRootBinding`'s `stagingBits` and `rootSync` fields.
export type { BitsApplied } from '../install/mkdir-parent-bits.js'
export type { DirSyncOutcome } from '../install/dir-sync.js'
// SMI-6531 A1 step 6a-i: `doctor recovery`'s read-only core: discovery, the classifier, the plan table.
export {
  discoverRoots,
  type DiscoveredRoot,
  type Discovery,
  type DiscoverOptions,
  type SkippedRoot,
} from '../services/skill-recovery.discover.js'
export type { ClassifyContext } from '../services/skill-recovery.classify.js'
export type { ReaderOptions } from '../services/skill-recovery.reader.js'
export {
  listRecovery,
  listRoot,
  reportOp,
  type ListOptions,
  type OpReport,
  type RootReport,
} from '../services/skill-recovery.listing.js'
export {
  classLabel,
  planAction,
  plansFor,
  RECOVERY_ACTIONS,
} from '../services/skill-recovery.plan.js'
export { GUARD_WORD, PERFORMED } from '../services/skill-recovery.plan.actions.js'
export { rootLockEntries, type RootLockEntry } from '../services/skill-recovery.locks.js'
// SMI-6531 A1 steps 6a-ii, 6b-i: targeting and the run under lock 1 for every action.
export { planRecovery } from '../services/skill-recovery.target.js'
export { executeRecovery } from '../services/skill-recovery.exec.js'
export type {
  AuditOutcome,
  PlannedRecovery,
  RecoveryDone,
  RecoveryPlanResult,
  RecoveryRefusal,
  RecoveryRequest,
  RecoveryRunOptions,
  RecoveryRunResult,
  RecoveryStopped,
} from '../services/skill-recovery.run.types.js'
export type { ProbeFact } from '../services/skill-recovery.opdir.js'
export type {
  ActionPlan,
  Disposition,
  OpFacts,
  PlanStep,
  RecoveryAction,
  RecoveryClass,
  RecoveryRefuseReason,
  RowState,
  UnreadableObservation,
} from '../services/skill-recovery.types.js'
