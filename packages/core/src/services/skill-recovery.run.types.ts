/**
 * SMI-6531 (A1 step 6a-ii): the types of doctor's one-device `--apply` and
 * `--undo` (`skill-recovery.target.ts` plans and targets, `skill-recovery.run.ts`
 * acts under lock 1).
 *
 * @module @skillsmith/core/services/skill-recovery.run.types
 */
import type { AppendOnceOutcome } from '../journal/writer.js'
import type { JournalRecordInput } from '../journal/types.js'
import type { ReaderOptions } from './skill-recovery.reader.js'
import type { OpReport } from './skill-recovery.listing.js'
import type { SweepEntry, SweepResult } from './skill-recovery.finish.js'
import type { ActionPlan, RecoveryRefuseReason, TreePosition } from './skill-recovery.types.js'
import type { ManifestPort, SwapOptions, SwapWarning } from './skill-swap.types.js'
import type { SkillWriteStopCode } from './skill-write-lock.types.js'

export interface RecoveryRequest {
  action: 'apply' | 'undo'
  opId: string
  /** The skills roots discovery found (native real paths); the op is looked for in each. */
  roots: readonly string[]
  /** `--root`: only the root this resolves to is searched (compared by native real path). */
  root?: string
  /** `--accept-identity`: waives check 5 only; each present tree must hash to its role's hash. */
  acceptIdentity?: boolean
  /** @internal Test seam: the effective uid (default `process.geteuid()`). */
  euid?: number
  /** The journal checked and appended to (default `getJournalFilePath()`). */
  journalFile?: string
  /** @internal Test seam passed to every reader. */
  reader?: ReaderOptions
}

/** A refusal before anything changed (no lock taken, or under it with zero mutation). */
export interface RecoveryRefusal {
  status: 'refused'
  reason: RecoveryRefuseReason | SkillWriteStopCode
  detail: string
  /** The op dirs a `recovery-ambiguous` refusal names, or the one refused. */
  paths: string[]
}

/** The plan shown before the prompt, and what the re-plan under lock 1 must reproduce. */
export interface PlannedRecovery {
  status: 'planned'
  request: RecoveryRequest
  /** The skills root holding the op dir. */
  root: string
  opDir: string
  report: OpReport
  plan: Extract<ActionPlan, { offered: true }>
  /** Leftover probes and other empty op dirs the plan listed: the sweep's candidates. */
  sweep: SweepEntry[]
  /** The target itself was an empty op dir (a kill after its `record.json` went). */
  emptyTarget: SweepEntry | null
}

export type RecoveryPlanResult = RecoveryRefusal | PlannedRecovery

/** What the audit step did. */
export type AuditOutcome =
  | { kind: 'none' }
  | { kind: 'appended' | 'present'; file: string }
  /** The journal ends mid-line: nothing was appended, and once the record goes the gap is permanent. */
  | { kind: 'not-recorded'; file: string; detail: string }

export interface RecoveryDone {
  status: 'done'
  opId: string
  action: 'apply' | 'undo'
  /** The class label the action ran from. */
  from: string
  installed: TreePosition | null
  kept: Array<{ tree: TreePosition; kind: string; path: string }>
  manifest: 'committed' | 'untouched'
  audit: AuditOutcome
  warnings: SwapWarning[]
  swept: SweepResult
}

/** Stopped partway: the record is kept (unless named otherwise) and the same command resumes it. */
export interface RecoveryStopped {
  status: 'stopped'
  opId: string
  reason: string
  detail: string
  recordPath: string | null
  warnings: SwapWarning[]
}

export type RecoveryRunResult = RecoveryRefusal | RecoveryDone | RecoveryStopped

/** @internal Test seams for the run under lock. */
export interface RecoveryRunOptions {
  swap?: SwapOptions
  /** Lock 1's wait (default 30 s). */
  lockTimeoutMs?: number
  /** Replaces `appendJournalRecordOnce`. */
  appendOnce?: (input: JournalRecordInput, o: { file?: string }) => Promise<AppendOnceOutcome>
  /** Runs under lock 1 after the re-plan matched, before the first mutation. */
  afterReplan?: () => void | Promise<void>
  /** Replaces the manifest port built from the record. */
  manifestPort?: ManifestPort
}
