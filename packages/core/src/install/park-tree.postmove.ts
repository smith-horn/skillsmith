/**
 * SMI-6531 (A1 step 3a): the guarded pre-move walk and everything after a
 * successful rename, ported from the SMI-6676 spike's `quarantine.postmove.mjs`
 * (ADR-166 D-10).
 *
 * Before the move, a guarded park also refuses a mount below the root
 * (`st_dev` per entry, and Linux mountinfo). After the move, a guarded park
 * verifies the tree again at its destination and on any mismatch returns
 * `held`. NOTHING IS EVER MOVED BACK (owner decision A, 2026-10-12): renaming
 * onto the origin can replace an empty directory a writer has just re-created
 * and holds open, orphaning its later writes. Nothing here creates, renames
 * onto, or writes at the origin.
 *
 * @module @skillsmith/core/install/park-tree.postmove
 */
import fs from 'node:fs'
import path from 'node:path'
import { computeTreeHash } from './tree-hash.js'
import { errCode, errCodeOrMessage } from './park-result.js'
import type { ParkIdentity, PartialParkResult, ResolvedParkOptions } from './park-result.js'
import { appendParkedIndex } from './parked-index.js'
import { mountinfoFinding, pathTreeRecord, verifyAtDestination } from './park-tree.verify.js'

/** POSIX single-quote escaping, for paths quoted in a held `detail`. */
const shq = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * The `detail` of a held result: the diagnosis, where the tree is, the origin,
 * and the restore command (`skillsmith restore <id>`, SMI-6531). It claims the
 * tree is safe only when the final location block confirmed it (SMI-7134).
 */
export function heldDetail(a: {
  diagnosis: string
  destPath: string
  originPath: string
  opId: string
  located?: boolean
  safe?: boolean
}): string {
  const where = a.safe
    ? `your tree is safe at ${shq(a.destPath)}`
    : a.located
      ? `the tree was observed at ${shq(a.destPath)}, but its directory is not private (${a.diagnosis})`
      : `the location of your tree could not be confirmed (reported path ${shq(a.destPath)}; reason: ${a.diagnosis})`
  return (
    `${a.diagnosis}. Changed during removal; ${where}. ` +
    `If something now exists at ${shq(a.originPath)}, move it aside first, then run ` +
    `\`skillsmith restore ${a.opId}\`.`
  )
}

/**
 * Writes a sidecar with flag `wx`, so it never overwrites an existing file.
 * Returns null on success, else the error code; the caller records it as
 * `sidecarError` and the status does not change. `build` runs inside the try,
 * so a failure computing a field is recorded the same way.
 */
export function writeSidecarWx(sidecarPath: string, build: () => object): string | null {
  try {
    fs.writeFileSync(sidecarPath, JSON.stringify(build(), null, 2), { flag: 'wx' })
    return null
  } catch (err) {
    return errCodeOrMessage(err)
  }
}

/** Sum of file and symlink `lstat` sizes in a tree, for the sidecar. Never follows a link. */
export function treeBytes(absPath: string): number {
  const st = fs.lstatSync(absPath)
  if (st.isSymbolicLink() || st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  let total = 0
  for (const name of fs.readdirSync(absPath)) total += treeBytes(path.join(absPath, name))
  return total
}

/**
 * The guarded pre-move walk (runs only with a guard hash). Returns `{result}`
 * when the park must stop here, with nothing moved, or `{treeHash}` (the hash
 * this park verified) to continue:
 *  - an entry whose `st_dev` differs from the root's: `kept/mount-inside-tree`
 *  - a read failure: `stopped` `guard-unreadable` or `guard-unsupported-type`
 *  - Linux: a mountinfo mount point at or under realpath(parentAbs)/name:
 *    `kept/mount-inside-tree`
 *  - the hash differs from `guardHash`: `kept/identity-changed`
 */
export function preMoveGuard(a: {
  originPath: string
  parentAbs: string
  name: string
  guardHash: string
}): { result: PartialParkResult } | { treeHash: string } {
  const kept = (detail: string): { result: PartialParkResult } => ({
    result: {
      status: 'kept',
      reason: 'mount-inside-tree',
      path: a.originPath,
      treeHash: null,
      detail,
    },
  })
  const walk = pathTreeRecord(a.originPath, { mountCheck: true })
  if (!walk.ok && walk.reason === 'mount-inside-tree') {
    return kept(`mount at ${walk.rel} (st_dev differs from the root); nothing was moved`)
  }
  if (!walk.ok) {
    return {
      result: {
        status: 'stopped',
        reason: walk.reason,
        path: walk.path,
        entry: a.name,
        errno: walk.errno,
      },
    }
  }
  // realpath runs on the parent, never the origin, so a symlink root is
  // probed at its own name and not at its target.
  let parentReal: string
  try {
    parentReal = fs.realpathSync(a.parentAbs)
  } catch (err) {
    return {
      result: {
        status: 'stopped',
        reason: 'park-failed',
        path: a.parentAbs,
        entry: a.name,
        errno: errCode(err),
      },
    }
  }
  const mi = mountinfoFinding(path.join(parentReal, a.name))
  if (mi !== null) return kept(`${mi}; nothing was moved`)
  const treeHash = computeTreeHash(walk.record)
  if (treeHash !== a.guardHash) {
    return {
      result: { status: 'kept', reason: 'identity-changed', path: a.originPath, treeHash },
    }
  }
  return { treeHash }
}

export interface FinishInput {
  destPath: string
  originPath: string
  name: string
  opId: string
  options: ResolvedParkOptions
  observedTreeHash: string | null
  boundIdentity: ParkIdentity | null
  parkedRoot: string
  parkedRootIdentity: ParkIdentity
  opReal: string | null
  opIdentity: ParkIdentity
  skillsmithVersion: string
}

/**
 * Everything after a successful root rename: post-move verification (guarded
 * only), then `held` or `parked`, each with a `wx` sidecar, then one index line.
 *
 * A failure computing bytes, writing the sidecar or appending the index never
 * escapes and never triggers anything destructive; it is reported as
 * `sidecarError` / `indexError` and the status stands. The held sidecar is
 * written only after verification has decided, so a crash before it leaves no
 * sidecar, which prune treats as held.
 *
 * `treeHash` on a parked result is the hash this park verified before the
 * move, or null when unguarded; on a held result it is the hash computed at
 * the destination, or null when verification stopped before hashing.
 */
export function finishAfterRename(a: FinishInput): PartialParkResult {
  const { destPath, originPath, name, opId, options, observedTreeHash } = a
  const guardHash = options.guardHash
  const sidecarPath = `${destPath}.json`
  const kind = options.kind
  let bytes: number | null = null
  let createdAt: string | null = null
  const baseSidecar = (): Record<string, unknown> => {
    bytes = treeBytes(destPath)
    createdAt = new Date().toISOString()
    return {
      opId,
      kind,
      client: options.client,
      rootKey: options.rootKey,
      originPath,
      treeHash: observedTreeHash,
      bytes,
      createdAt,
      skillsmithVersion: a.skillsmithVersion,
    }
  }
  const indexed = (): { indexError?: string } => {
    if (options.indexPath === undefined) return {}
    try {
      // Lock 4 (withFileLock on the index path, UD31) and lock 1' wrap this append in part B.
      appendParkedIndex(options.indexPath, {
        opId,
        path: destPath,
        client: options.client,
        rootKey: options.rootKey,
        kind,
        bytes,
        createdAt: createdAt ?? new Date().toISOString(),
      })
      return {}
    } catch (err) {
      return { indexError: errCodeOrMessage(err) }
    }
  }
  // A guarded park always binds an identity first; a missing one fails closed
  // (an identity with no file type never compares equal), never skips the check.
  const verified =
    guardHash !== undefined
      ? verifyAtDestination({
          destPath,
          boundIdentity: a.boundIdentity ?? { dev: -1n, ino: -1n, birthtimeNs: -1n },
          guardHash,
          parkedRoot: a.parkedRoot,
          parkedRootIdentity: a.parkedRootIdentity,
          opReal: a.opReal,
          opIdentity: a.opIdentity,
        })
      : null

  if (verified !== null && !verified.ok) {
    const sidecarError = writeSidecarWx(sidecarPath, () => ({
      ...baseSidecar(),
      hold: true,
      reason: verified.reason,
      heldPath: destPath,
      guardHash,
      postMoveTreeHash: verified.treeHash,
    }))
    return {
      status: 'held',
      reason: verified.reason,
      path: destPath,
      originPath,
      heldPath: destPath,
      entry: name,
      treeHash: verified.treeHash,
      sidecarPath,
      opId,
      errno: null,
      detail: heldDetail({
        diagnosis: verified.diagnosis,
        destPath,
        originPath,
        opId,
        located: verified.located,
        safe: verified.safe,
      }),
      ...(sidecarError === null ? {} : { sidecarError }),
      ...indexed(),
    }
  }

  const sidecarError = writeSidecarWx(sidecarPath, () =>
    verified === null
      ? baseSidecar()
      : { ...baseSidecar(), postMoveVerified: true, postMoveTreeHash: verified.treeHash }
  )
  return {
    status: 'parked',
    path: destPath,
    entry: name,
    treeHash: observedTreeHash,
    sidecarPath,
    opId,
    ...(sidecarError === null ? {} : { sidecarError }),
    ...indexed(),
  }
}
