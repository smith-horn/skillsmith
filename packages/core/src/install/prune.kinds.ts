/**
 * SMI-6531 (A1 step 6c-ii-a): prune's policy per kept or parked kind (PLAN
 * 1706-1721, 1739-1745; UD64, UD65), as data. fs-free: no import of `fs`.
 *
 * A row says what a selector may do with a kind, never whether a given tree
 * is safe to delete: that is the D-11 class (`prune.classify.ts`). The two
 * tables are `satisfies` over the full kind unions, so a kind a writer gains
 * fails to compile here until someone decides its policy. Step 8 adds the four
 * `NoWriterKind`s to `PublishKind`; until then they are policy rows only, and
 * the strict backup parser stays closed to them (owner decision D3), so a
 * sidecar naming one classifies unverified.
 *
 * No caller yet in this wave: 6c-ii-b's planner reads these tables.
 *
 * @module @skillsmith/core/install/prune.kinds
 */
import type { PublishKind } from '../services/skill-swap.sidecar.js'
import type { ParkedKind } from './park-callers.js'

/** Kinds UD64 names that no writer produces yet (step 8 adds them to `PublishKind`). */
export type NoWriterKind = 'pre-rename' | 'merge-base' | 'saved-edits' | 'pre-edit'

/**
 * How a selector reaches a kind:
 *  - `default`: selected without `--include-kept`;
 *  - `include-kept`: only with `--include-kept`;
 *  - `default-if-source-unchanged`: a `partial-copy` is `default` when its
 *    sidecar says `sourceUnchanged: true`, and `include-kept` otherwise.
 */
export type KindSelection = 'default' | 'include-kept' | 'default-if-source-unchanged'

export interface KindPolicy {
  selection: KindSelection
  /** Counted by, and guarded by, `--keep` (UD65): `backup` and `pre-rename`. */
  countedByKeep: boolean
  /** Never selected when it is the newest of its group (UD64: `merge-base`). */
  neverNewest: boolean
}

const DEFAULT: KindPolicy = { selection: 'default', countedByKeep: false, neverNewest: false }
const KEPT: KindPolicy = { selection: 'include-kept', countedByKeep: false, neverNewest: false }
const COUNTED: KindPolicy = { selection: 'default', countedByKeep: true, neverNewest: false }

/** The backup-area kinds: every `PublishKind`, plus UD64's four rows with no writer. */
export const BACKUP_KIND_POLICY = {
  backup: COUNTED,
  undone: DEFAULT,
  'unused-new': DEFAULT,
  'partial-copy': {
    selection: 'default-if-source-unchanged',
    countedByKeep: false,
    neverNewest: false,
  },
  conflict: KEPT,
  'edited-new': KEPT,
  'unrecorded-new': KEPT,
  'failed-build': KEPT,
  'abandoned-old': KEPT,
  'abandoned-new': KEPT,
  'abandoned-undone': KEPT,
  'pre-rename': COUNTED,
  'merge-base': { selection: 'include-kept', countedByKeep: false, neverNewest: true },
  'saved-edits': KEPT,
  'pre-edit': KEPT,
} as const satisfies Record<PublishKind | NoWriterKind, KindPolicy>

/** The parked kinds: every one is default-selectable except `unreadable-record`. */
export const PARKED_KIND_POLICY = {
  'abort-new': DEFAULT,
  'move-source': DEFAULT,
  uninstall: DEFAULT,
  'fan-out-cleanup': DEFAULT,
  'fan-out-undo': DEFAULT,
  'fan-out-staging': DEFAULT,
  'fan-out-symlink': DEFAULT,
  'fan-out-backup': DEFAULT,
  'install-rollback': DEFAULT,
  'activation-undo': DEFAULT,
  'init-rollback': DEFAULT,
  'agent-uninstall': DEFAULT,
  'companion-rollback': DEFAULT,
  'unreadable-record': KEPT,
} as const satisfies Record<ParkedKind, KindPolicy>

export type PolicyStore = 'parked' | 'backup'

const has = (t: object, k: string): boolean => Object.prototype.hasOwnProperty.call(t, k)

/**
 * The policy row for `kind` in `store`, or null when prune does not recognise
 * the kind. An unrecognised kind is unverified and never selected by default
 * (UD64); a caller must treat null as exactly that.
 */
export function policyFor(store: PolicyStore, kind: string): KindPolicy | null {
  if (store === 'parked') {
    return has(PARKED_KIND_POLICY, kind)
      ? PARKED_KIND_POLICY[kind as keyof typeof PARKED_KIND_POLICY]
      : null
  }
  return has(BACKUP_KIND_POLICY, kind)
    ? BACKUP_KIND_POLICY[kind as keyof typeof BACKUP_KIND_POLICY]
    : null
}
