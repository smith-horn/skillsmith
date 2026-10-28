/**
 * SMI-6531 (A1 step 6b-ii): the types of `doctor recovery --clean-staging`,
 * for an op dir with no `record.json` (design `step6b-design.md` § 1.2).
 *
 * @module @skillsmith/core/services/skill-recovery.clean.types
 */
import type { Attribution } from './skill-recovery.attribution.js'
import type { KeepGroup, RoleRes, StatFact } from './skill-recovery.types.js'
import type { RecordIdentity } from './skill-swap.types.js'

/**
 * Whether `owner.json`'s owner can be shown gone. Where `owner.json` is
 * present, only `same-host-dead` lets `--clean-staging` act without
 * `--unsafe-unverified-owner`: a pid that `kill(pid, 0)` answers `ESRCH` on
 * this host. `EPERM` (the process exists, owned by someone else) and every
 * other answer count as alive. The one exception: an op dir with a verifying
 * `park-intent.json` and no `owner.json` (`absent`) needs neither, because
 * the writer made the intent durable before it unlinked `owner.json`.
 */
export type OwnerVerdict =
  | 'same-host-dead'
  | 'same-host-alive'
  | 'other-host'
  | 'unparseable'
  | 'absent'

/** How the classifier judges an owner: this host's name and a pid probe (`probePidAlive`'s answer). */
export interface OwnerProbe {
  host: string
  /** `false` only when the pid is gone; `true` or `null` (not probed) are never "gone". */
  alive: (pid: number) => boolean | null
}

/**
 * What the classifier read of a no-record op dir for `--clean-staging`, all
 * through the reader, so the re-plan digest covers it; the owner verdict,
 * which is not a read, is in the serialized plan instead.
 */
export interface NoRecordObservation {
  /** OP's identity, from its `lstat`: the finish binds OP with it. */
  opIdentity: RecordIdentity
  verdict: OwnerVerdict
  /** The verdict in words: what `owner.json` claims and why its owner is or is not shown gone. */
  verdictWhy: string
  /** O1, all or nothing, from `owner.json` and a verifying intent. */
  attribution: Attribution
  /** Where a keep files (`keepAreaOf`); null with no state root at all. */
  area: string | null
  /** Every entry of OP with its no-follow `lstat`. */
  entries: Array<{ name: string; stat: StatFact }>
  /** The metadata temps doctor can prove are this op's (`record.json.tmp`, `park-intent.json.tmp`), by path. */
  temps: string[]
  /** The first entry doctor cannot prove it wrote (O2), with why; null when there is none. */
  unprovable: { name: string; why: string } | null
  /** `new/`: a source (with the keep abort cleanup started, if any), a verified keep, or absent. */
  n: RoleRes
  /** This op's keep groups in `area`, in name order. */
  groups: KeepGroup[]
  /** Why those groups cannot be acted on (the area unlistable, a conflict, an unclassified keep); null when they can. */
  groupsBlocked: string | null
  /** With a verifying intent: why `--clean-staging` cannot finish its park; null when it can. */
  intentBlocked: string | null
}
