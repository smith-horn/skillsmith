/**
 * SMI-6531 (A1 step 3a): the destination end of the park's rename(2), ported
 * from the SMI-6676 spike's `quarantine.mjs` (`ensureTrashRoot` and the op
 * directory block).
 *
 * Both ends of the rename get a bound identity, re-checked immediately before
 * the destructive step (ADR-166 D-3): hardening only the source was itself a
 * finding. The checks narrow the window for accidental concurrent writers; they
 * do not close it against a same-account adversary (ADR-166 D-0), which would
 * need renameat(2) on a held handle, absent from Node 22's fs.
 *
 * @module @skillsmith/core/install/park-tree.destination
 */
import fs from 'node:fs'
import type { BigIntStats, Stats } from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'
import type { PartialParkResult } from './park-result.js'
import { opDirOwnerModeProblem } from './park-tree.perms.js'
import { bindIdentity, identityOf, sameIdentity } from './park-tree.identity.js'
import type { BoundIdentity } from './park-tree.identity.js'

/** The parked area's name inside the parent (ADR-166 D-9, UD26). */
export const PARKED_DIR_NAME = '.skillsmith-parked'

export type ParkedRootResult =
  | { ok: true; parkedRoot: string; parkedRootIdentity: BoundIdentity; parentDev: bigint }
  | { ok: false; errno: string | null; detail: string | null }

/**
 * Validates, creating it if absent, `<parentAbs>/.skillsmith-parked` (ADR-166
 * D-3). Its mkdir requests the parent's permission bits (the process umask
 * still applies), EEXIST accepted, and then it must be a real directory (never
 * a symlink) on the parent's device. Every failure is
 * `park-failed`; `detail` names which (`trash-unusable`, `trash-other-mount`,
 * the spellings A1 plan row Q7 uses).
 */
export function ensureParkedRoot(parentAbs: string): ParkedRootResult {
  const parkedRoot = path.join(parentAbs, PARKED_DIR_NAME)
  let parentStat: Stats
  try {
    parentStat = fs.statSync(parentAbs)
  } catch (err) {
    return { ok: false, errno: errCode(err), detail: null }
  }
  try {
    fs.mkdirSync(parkedRoot, { mode: parentStat.mode & 0o777 })
  } catch (err) {
    if (errCode(err) !== 'EEXIST') return { ok: false, errno: errCode(err), detail: null }
  }
  let st: BigIntStats
  try {
    st = fs.lstatSync(parkedRoot, { bigint: true })
  } catch (err) {
    return { ok: false, errno: errCode(err), detail: null }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { ok: false, errno: null, detail: 'trash-unusable' }
  }
  // parentStat is a Number stat and st a bigint one; `!==` across the two types
  // is always true, so the parent's dev is normalized to bigint once.
  const parentDev = BigInt(parentStat.dev)
  if (st.dev !== parentDev) return { ok: false, errno: null, detail: 'trash-other-mount' }
  // Return the area's IDENTITY, not just its path, so it can be re-checked
  // immediately before the rename and after it.
  return { ok: true, parkedRoot, parkedRootIdentity: identityOf(st), parentDev }
}

export type OpDirResult =
  | { ok: true; opDir: string; opIdentity: BoundIdentity; opReal: string | null }
  | { ok: false; result: PartialParkResult }

/**
 * Creates or accepts `<parkedRoot>/<opId>` and validates it: a real directory,
 * on the parent's device, owned by us and private (spike F9, F12; ADR-166 D-0).
 * A refusal is `kept/park-destination-changed`: nothing moved, a check declined
 * (ADR-166 D-8). The validated identity is bound for the pre-rename re-check
 * (spike F11) and, on a guarded call, the op directory's realpath is pinned for
 * post-move verification (SMI-7132).
 */
export function prepareOpDir(a: {
  parkedRoot: string
  parentDev: bigint
  opId: string
  originPath: string
  name: string
  guarded: boolean
  observedTreeHash: string | null
}): OpDirResult {
  const opDir = path.join(a.parkedRoot, a.opId)
  const kept = (detail: string, errno: string | null = null): OpDirResult => ({
    ok: false,
    result: {
      status: 'kept',
      reason: 'park-destination-changed',
      path: a.originPath,
      entry: a.name,
      treeHash: a.observedTreeHash,
      errno,
      detail,
    },
  })
  const stopped = (errno: string | null): OpDirResult => ({
    ok: false,
    result: { status: 'stopped', reason: 'park-failed', path: opDir, entry: a.name, errno },
  })
  try {
    // The mode is a request only: EEXIST discards it, so it is checked below.
    fs.mkdirSync(opDir, { mode: 0o700, recursive: false })
  } catch (err) {
    if (errCode(err) !== 'EEXIST') return stopped(errCode(err))
  }
  let od: BigIntStats
  try {
    od = fs.lstatSync(opDir, { bigint: true })
  } catch (err) {
    return stopped(errCode(err))
  }
  // A pre-created symlink passes a device check (lstat reports the link's own
  // dev), and rename(2) would resolve it and land the tree elsewhere (spike F9).
  if (od.isSymbolicLink() || !od.isDirectory()) {
    return kept(
      od.isSymbolicLink()
        ? 'op directory is a symlink; rename(2) would resolve it and land the tree elsewhere'
        : 'op directory exists but is not a directory'
    )
  }
  if (od.dev !== a.parentDev) return kept('op directory is on a different device than the parent')
  const permProblem = opDirOwnerModeProblem(od)
  if (permProblem !== null) return kept(permProblem)
  let opReal: string | null = null
  if (a.guarded) {
    // Lstat-validated just above, so realpath resolves only its ancestors.
    try {
      opReal = fs.realpathSync(opDir)
    } catch (err) {
      return kept('op directory could not be resolved before the move', errCode(err))
    }
  }
  return { ok: true, opDir, opIdentity: identityOf(od), opReal }
}

/**
 * The destination re-checks, run immediately before the source re-check and
 * rename(2): the parked area, then the op directory, each against the identity
 * bound when it was validated. Replacing an entry inside a directory leaves the
 * directory's own identity unchanged, so the op directory needs its own check.
 * These run BEFORE the source re-check deliberately, to keep the source's
 * window to the rename short; the source end carries the documented residual.
 * They turn a substitution into a diagnosable `kept`; they do not close the
 * race (ADR-166 D-0).
 */
export function recheckDestination(a: {
  parkedRoot: string
  parkedRootIdentity: BoundIdentity
  opDir: string
  opIdentity: BoundIdentity
  originPath: string
  observedTreeHash: string | null
}): PartialParkResult | null {
  const kept = (detail: string): PartialParkResult => ({
    status: 'kept',
    reason: 'park-destination-changed',
    path: a.originPath,
    treeHash: a.observedTreeHash,
    detail,
  })
  const rootNow = bindIdentity(a.parkedRoot)
  if (!rootNow.ok || !sameIdentity(a.parkedRootIdentity, rootNow)) {
    return kept('parked area was substituted between validation and rename')
  }
  const opNow = bindIdentity(a.opDir)
  if (!opNow.ok || !sameIdentity(a.opIdentity, opNow)) {
    return kept('op directory was substituted between validation and rename')
  }
  return null
}
