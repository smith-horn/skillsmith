/**
 * SMI-6531 (A1 step 6d-ii, D5): which parked kinds `skillsmith restore` may put
 * back. An internal origin is Skillsmith's own scratch space (PLAN:2097-2100),
 * so there is nothing to restore into. `satisfies Record<ParkedKind, ...>` makes
 * a new kind fail to compile until it is classified here.
 *
 * @module @skillsmith/core/services/skill-restore.kinds
 */
import type { ParkedKind } from '../install/park-callers.js'

export type RestoreClass = { restorable: true } | { restorable: false; what: string }

const YES: RestoreClass = { restorable: true }
const no = (what: string): RestoreClass => ({ restorable: false, what })

export const RESTORE_CLASS = {
  'abort-new': no('staging area'),
  'move-source': no('staging area'),
  'unreadable-record': no('staging area'),
  'fan-out-staging': no('temporary staging folder'),
  'fan-out-backup': no('backup folder'),
  uninstall: YES,
  'fan-out-cleanup': YES,
  'fan-out-undo': YES,
  'fan-out-symlink': YES,
  'install-rollback': YES,
  'activation-undo': YES,
  'init-rollback': YES,
  'agent-uninstall': YES,
  'companion-rollback': YES,
} as const satisfies Record<ParkedKind, RestoreClass>

/** The class of `kind`, or null when this version does not know it (including the retired `fan-out-overwrite`). */
export function restoreClassOf(kind: string): RestoreClass | null {
  return Object.prototype.hasOwnProperty.call(RESTORE_CLASS, kind)
    ? RESTORE_CLASS[kind as keyof typeof RESTORE_CLASS]
    : null
}
