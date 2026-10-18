/**
 * SMI-6531 (A1 step 3a): `parkTree`, removal by rename (ADR-166 D-1, D-9),
 * ported from the SMI-6676 spike's `quarantine.mjs`. Not wired to any caller
 * yet: A1 step 8 routes every automatic removal through it.
 *
 * `parkTree(parent, name, options)` renames `<parent>/<name>` to
 * `<parent>/.skillsmith-parked/<opId>/<name>-<rnd>` and writes a `wx` sidecar
 * `<name>-<rnd>.json` beside it. It never deletes and never retries: if the
 * rename fails for any reason, nothing moves and nothing is deleted (ADR-166
 * D-4). A directory, a regular file and a symlink move the same way (UD30).
 *
 * THREAT MODEL (ADR-166 D-0): safe against accidental concurrent writers (a
 * second session, an editor, a sync tool); not against an adversary with write
 * access to the parent racing the final rename(2). Closing that window needs
 * renameat(2) on a held directory handle, which Node 22's fs lacks. A lost race
 * misplaces a tree; the park never deletes one.
 *
 * Every fs call goes through the `node:fs` default import, looked up at call
 * time, so the static boundary test can trace each one (ADR-166 D-11).
 *
 * @module @skillsmith/core/install/park-tree
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { VERSION } from '../index.js'
import { computeTreeHash } from './tree-hash.js'
import { assertPathSegment, errCode, resolveParkOptions, shapeResult } from './park-result.js'
import type {
  ParkIdentity,
  ParkOptions,
  ParkResult,
  PartialParkResult,
  ResolvedParkOptions,
} from './park-result.js'
import { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from './park-tree.perms.js'
import { bindIdentity, sameIdentity } from './park-tree.identity.js'
import { ensureParkedRoot, prepareOpDir, recheckDestination } from './park-tree.destination.js'
import { pathTreeRecord } from './park-tree.verify.js'
import { finishAfterRename, preMoveGuard } from './park-tree.postmove.js'

/** 8 random hex characters: the `<rnd>` suffix and a generated opId (ADR-166 D-3). */
function randSuffix(): string {
  return crypto.randomBytes(4).toString('hex')
}

export type PathTreeHashResult =
  | { ok: true; treeHash: string }
  | Extract<ReturnType<typeof pathTreeRecord>, { ok: false }>

/**
 * The §3.4 tree hash of the tree at `absRoot`, from the same walk and hash
 * function the park recomputes, so a caller's `guardHash` from here matches a
 * guarded park of the unchanged tree. Mount-tolerant: a caller's hash walks
 * through a mount; the park itself refuses one.
 */
export function computePathTreeHash(absRoot: string): PathTreeHashResult {
  const r = pathTreeRecord(absRoot)
  if (!r.ok) return r
  return { ok: true, treeHash: computeTreeHash(r.record) }
}

const PARKABLE_TYPES: ReadonlySet<bigint> = new Set([S_IFDIR, S_IFREG, S_IFLNK])

/** UD30: a FIFO, socket or device root is refused before anything moves. */
function unsupportedRoot(originPath: string, name: string): PartialParkResult {
  return {
    status: 'stopped',
    reason: 'guard-unsupported-type',
    path: originPath,
    entry: name,
    errno: null,
    detail: 'the root is not a directory, a regular file or a symlink, so it is not parked (UD30)',
  }
}

function parkTreeInner(
  parentAbs: string,
  name: string,
  o: ResolvedParkOptions,
  skillsmithVersion: string
): PartialParkResult {
  const opId = o.opId ?? randSuffix()
  const originPath = path.join(parentAbs, name)
  const guardHash = o.guardHash
  const guarded = guardHash !== undefined
  let observedTreeHash: string | null = null
  const stoppedAtOrigin = (errno: string | null): PartialParkResult => ({
    status: 'stopped',
    reason: 'park-failed',
    path: originPath,
    entry: name,
    errno,
  })

  // B2: the walk resolves the path and rename(2) resolves it again, so the
  // guard could certify one tree while the rename moved another. Identity
  // (UD24, file type included per SMI-7130) is bound before the walk and
  // re-compared immediately before the rename. `expectIdentity` lets a caller
  // bind it earlier than this function can.
  let boundIdentity: ParkIdentity | null = o.expectIdentity ?? null

  // Identity and UD25's clock gate run whenever `expectIdentity`,
  // `maxBirthtimeNs` or a guard is given, independently of the hash: the gate
  // must hold for a caller that passes no hash (UD25, ADR-166 D-0).
  const needIdentity = boundIdentity !== null || o.maxBirthtimeNs !== undefined || guarded
  let rootFmt: bigint
  if (needIdentity) {
    const before = bindIdentity(originPath)
    if (!before.ok) return stoppedAtOrigin(before.errno)
    if (boundIdentity !== null && !sameIdentity(boundIdentity, before)) {
      return { status: 'kept', reason: 'identity-changed', path: originPath, treeHash: null }
    }
    boundIdentity = boundIdentity ?? before
    rootFmt = before.fmt
    // UD25: a tree that existed before the gate ran is strictly older than
    // probe 2. What this buys and what it cannot (a substitute recycling both
    // inode and birthtime passes it) is A1 plan §3.3 "Clock gate".
    if (o.maxBirthtimeNs !== undefined && !(boundIdentity.birthtimeNs < o.maxBirthtimeNs)) {
      return {
        status: 'kept',
        reason: 'identity-not-older-than-probe',
        path: originPath,
        treeHash: null,
      }
    }
  } else {
    let st: BigIntStats
    try {
      st = fs.lstatSync(originPath, { bigint: true })
    } catch (err) {
      return stoppedAtOrigin(errCode(err))
    }
    rootFmt = st.mode & S_IFMT
  }
  // A guarded park's walk refuses an unsupported root itself (guard-unsupported-type
  // with the walk's own path); an unguarded park has no walk, so it checks here.
  if (!guarded && !PARKABLE_TYPES.has(rootFmt)) return unsupportedRoot(originPath, name)

  // The guarded walk also refuses a mount below the root (ADR-166 D-10 item 5),
  // before anything moves and before the hash comparison.
  if (guarded) {
    const pre = preMoveGuard({ originPath, parentAbs, name, guardHash })
    if ('result' in pre) return pre.result
    observedTreeHash = pre.treeHash
  }

  const area = ensureParkedRoot(parentAbs)
  if (!area.ok) {
    return {
      status: 'stopped',
      reason: 'park-failed',
      path: parentAbs,
      entry: name,
      errno: area.errno,
      detail: area.detail,
    }
  }

  const op = prepareOpDir({
    parkedRoot: area.parkedRoot,
    parentDev: area.parentDev,
    opId,
    originPath,
    name,
    guarded,
    observedTreeHash,
  })
  if (!op.ok) return op.result

  const destPath = path.join(op.opDir, `${name}-${randSuffix()}`)

  const destChanged = recheckDestination({
    parkedRoot: area.parkedRoot,
    parkedRootIdentity: area.parkedRootIdentity,
    opDir: op.opDir,
    opIdentity: op.opIdentity,
    originPath,
    observedTreeHash,
  })
  if (destChanged !== null) return destChanged

  // The source re-check: UD24's rule, the identity checked immediately before
  // the destructive step. A MITIGATION, NOT A CLOSURE: a window remains between
  // this lstat and rename(2), accepted under ADR-166 D-0.
  if (boundIdentity !== null) {
    const atRename = bindIdentity(originPath)
    if (!atRename.ok) return stoppedAtOrigin(atRename.errno)
    if (!sameIdentity(boundIdentity, atRename)) {
      return {
        status: 'kept',
        reason: 'identity-changed',
        // A live substitution and a caller's wrong expectIdentity must not look
        // identical (spike M-5).
        detail: 'bound identity does not match the tree now at this path',
        path: originPath,
        treeHash: observedTreeHash,
      }
    }
  }

  try {
    fs.renameSync(originPath, destPath)
  } catch (err) {
    // rename(2) is atomic: on failure nothing moved. Never fall back to a
    // delete, never retarget elsewhere (ADR-166 D-4).
    return stoppedAtOrigin(errCode(err))
  }

  return finishAfterRename({
    destPath,
    originPath,
    name,
    opId,
    options: o,
    observedTreeHash,
    boundIdentity,
    parkedRoot: area.parkedRoot,
    parkedRootIdentity: area.parkedRootIdentity,
    opReal: op.opReal,
    opIdentity: op.opIdentity,
    skillsmithVersion,
  })
}

/** The barrel's VERSION, or an Error saying it was unavailable and nothing moved. */
function readCoreVersion(): string {
  let v: unknown
  try {
    v = VERSION
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(
      `parkTree: the @skillsmith/core version was unavailable (${why}); nothing was moved`
    )
  }
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(
      `parkTree: the @skillsmith/core version was unavailable (got ${String(v)}); nothing was moved`
    )
  }
  return v
}

/**
 * Parks `<parentAbs>/<name>`. `name` is a single path segment. Options are
 * read once and validated before any filesystem work; an unknown key, a
 * missing `client` or `kind`, or a `guardHash` that is neither omitted nor a
 * non-empty string throws TypeError (ADR-166 D-5). An unavailable core version
 * throws Error, also with nothing moved.
 *
 * Outcomes (ADR-166 D-8): `parked` (done); `kept` (nothing moved, a check
 * refused); `held` (moved, then found changed at its parked path, left there
 * whole); `stopped` (nothing moved: `park-failed`, `guard-unreadable`,
 * `guard-unsupported-type`). Only `parked` is done; the caller never retries.
 */
export function parkTree(parentAbs: string, name: string, options: ParkOptions): ParkResult {
  assertPathSegment('name', name)
  const resolved = resolveParkOptions(options)
  // Read once, before any filesystem work: a barrel module calling parkTree
  // during initialization would see VERSION in its TDZ, and nothing may move
  // on a failure (ADR-166 D-4).
  const skillsmithVersion = readCoreVersion()
  return shapeResult({
    entry: name,
    ...parkTreeInner(parentAbs, name, resolved, skillsmithVersion),
  })
}
