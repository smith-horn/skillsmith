// SMI-6715 Step 1b (C4 repair, ADR-166 D-10; design §1 S2, S9, S11, S12, §5).
// Split out of quarantine.mjs for the file-length limit.
//
// THE DEFECT. A guarded C4 call re-checked only the ROOT's (dev, ino,
// birthtimeNs) before rename(2). Every A4 / A7-late mutation lands after C4's
// own hash and before the rename, without changing the root's identity, so C4
// MOVED the mutated tree and reported `quarantined` (Probe 2: append, chmod and
// create, all three). A real mount inside the tree moved with it too (Probe 3).
//
// THE REPAIR. (1) The pre-move walk also compares every entry's st_dev with the
// root's, and on Linux consults mountinfo (quarantine.mounts.mjs): a mount
// below the root is refused before anything moves. (2) After the rename, the
// tree is verified again AT ITS DESTINATION -- identity, mounts, re-hash -- and
// any mismatch returns `held`. NOTHING IS EVER MOVED BACK (owner decision A,
// 2026-10-12): renaming onto the origin replaces an empty directory a writer
// may hold open and orphans that writer's later writes (Sol round 1, F1).
// Nothing here creates, renames onto, or writes at the origin.
//
// The hash at the destination is meaningful because computeTreeHash keys every
// record by its path RELATIVE to the walk root (hash.mjs); no absolute path or
// root name enters it (Probe 1: equal hash after a 3-level move on APFS).
//
// fs is imported as the DEFAULT export only (c4-fs-boundary.mjs checks it).

import fs from 'node:fs'
import path from 'node:path'
import { computeTreeHash } from './hash.mjs'
import { appendParkedIndex } from './trash-index.mjs'
import { pathTreeRecord, mountinfoFinding, verifyAtDestination } from './quarantine.verify.mjs'

// The walk, mountinfo probe and S9 verification live in quarantine.verify.mjs
// (file length); re-exported so existing importers keep working.
export { pathTreeRecord, mountinfoFinding, verifyAtDestination }

/** POSIX single-quote escaping, for the reference restore line in `detail` only. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * The `detail` of a held result. Names the diagnosis, where the tree is, the
 * origin, and the product restore command (owner decision 2026-10-12:
 * `skillsmith restore <id>`, built in SMI-6531).
 */
export function heldDetail({
  diagnosis,
  destPath,
  originPath,
  opId,
  located = false,
  safe = false,
}) {
  // Three truthful wordings (SMI-7134): safe only when the final location block
  // passed; located-but-not-private when only the owner/mode check failed; else the
  // reported path may lead through a swapped link or directory.
  const where = safe
    ? `your tree is safe at ${shq(destPath)}`
    : located
      ? `the tree was observed at ${shq(destPath)}, but its directory is not private (${diagnosis})`
      : `the location of your tree could not be confirmed (reported path ${shq(destPath)}; reason: ${diagnosis})`
  return (
    `${diagnosis}. Changed during removal; ${where}. ` +
    `If something now exists at ${shq(originPath)}, move it aside first, then run ` +
    `\`skillsmith restore ${opId}\`.`
  )
}

/**
 * Writes a sidecar with flag 'wx', so it NEVER overwrites (design §5). Returns
 * null on success, else the error code; the caller records it as sidecarError
 * and does not change the outcome. `buildSidecar` runs inside the try, so a
 * failure computing a field (treeBytes on a vanished entry) is recorded the
 * same way.
 */
export function writeSidecarWx(sidecarPath, buildSidecar) {
  try {
    fs.writeFileSync(sidecarPath, JSON.stringify(buildSidecar(), null, 2), { flag: 'wx' })
    return null
  } catch (err) {
    return err.code ?? err.message
  }
}

/** Sum of lstat sizes in a tree, for the sidecar. Moved from quarantine.mjs. */
export function treeBytes(absPath) {
  let total = 0
  const st = fs.lstatSync(absPath)
  if (st.isSymbolicLink() || st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  for (const name of fs.readdirSync(absPath)) {
    total += treeBytes(path.join(absPath, name))
  }
  return total
}

/**
 * S2, S2b, S2c: the guarded pre-move walk. Runs only when a guard hash is
 * supplied. Returns {result} when the call must stop here (nothing moved), or
 * {treeHash} -- the hash this call verified -- to continue.
 *
 *  - S2: an entry whose st_dev differs from the root's -> kept/mount-inside-tree
 *  - a read failure -> stopped guard-unreadable | guard-unsupported-type (as before)
 *  - S2b (Linux): a mountinfo mount point at or under realpath(parentAbs)/name
 *    -> kept/mount-inside-tree. realpath runs on parentAbs, never originPath,
 *    so the root call skeleton the harness matches is unchanged.
 *  - S2c: hash !== guardHash -> kept/identity-changed (as before)
 */
export function preMoveGuard({ originPath, parentAbs, name, guardHash }) {
  const kept = (detail) => ({
    result: {
      status: 'kept',
      reason: 'mount-inside-tree',
      path: originPath,
      treeHash: null,
      detail,
    },
  })
  const walk = pathTreeRecord(originPath, { mountCheck: true })
  if (!walk.ok && walk.reason === 'mount-inside-tree') {
    return kept(`mount at ${walk.rel} (st_dev differs from the root); nothing was moved`)
  }
  if (!walk.ok) {
    return {
      result: {
        status: 'stopped',
        reason: walk.reason,
        path: walk.path,
        entry: name,
        errno: walk.errno,
      },
    }
  }
  let parentReal
  try {
    parentReal = fs.realpathSync(parentAbs)
  } catch (err) {
    return {
      result: {
        status: 'stopped',
        reason: 'quarantine-failed',
        path: parentAbs,
        entry: name,
        errno: err.code ?? null,
      },
    }
  }
  const mi = mountinfoFinding(path.join(parentReal, name))
  if (mi !== null) return kept(`${mi}; nothing was moved`)
  const treeHash = computeTreeHash(walk.record)
  if (treeHash !== guardHash) {
    return { result: { status: 'kept', reason: 'identity-changed', path: originPath, treeHash } }
  }
  return { treeHash }
}

/**
 * Everything after a successful root rename: S9 (guarded only), then S11
 * (held) or S12 (quarantined), each with a 'wx' sidecar.
 *
 * The tree is safely in the trash at this point whatever happens next. A
 * failure computing bytes or writing the sidecar (e.g. ENOSPC: a tmpfs with
 * room for the rename but not the sidecar) never escapes and never triggers
 * anything destructive; it is reported as `sidecarError` on the result, whose
 * status it does not change. The held sidecar is written only after S9 has
 * decided, so a crash before it leaves no sidecar, which prune treats as held.
 *
 * `treeHash` on a quarantined result is the hash this call VERIFIED before the
 * move, or null when no guard hash was supplied (A1 plan UD14/UD15/UD17 need a
 * non-null value to authorize a removal). On a held result it is the hash S9
 * computed at the destination, or null when S9 stopped before hashing.
 */
export function finishAfterRename(a) {
  const { destPath, originPath, name, opId, options, guardHash, observedTreeHash } = a
  const sidecarPath = `${destPath}.json`
  let built = null
  const baseSidecar = () => {
    built = {
      opId,
      kind: options.kind ?? 'unspecified',
      client: options.client ?? 'spike',
      rootKey: options.rootKey ?? null,
      originPath,
      treeHash: observedTreeHash,
      bytes: treeBytes(destPath),
      createdAt: new Date().toISOString(),
      skillsmithVersion: a.skillsmithVersion,
    }
    return built
  }
  // SMI-7123 W5 (design §5): after the sidecar, one line in the parked index.
  // A failure is reported as `indexError` and never changes the status.
  const indexed = () => {
    if (typeof options.indexPath !== 'string') return {}
    try {
      appendParkedIndex(options.indexPath, {
        opId,
        path: destPath,
        client: built?.client ?? options.client ?? 'spike',
        rootKey: built?.rootKey ?? options.rootKey ?? null,
        kind: built?.kind ?? options.kind ?? 'unspecified',
        bytes: built?.bytes ?? null,
        createdAt: built?.createdAt ?? new Date().toISOString(),
      })
      return {}
    } catch (err) {
      return { indexError: err.code ?? err.message }
    }
  }
  const guarded = guardHash !== undefined && guardHash !== null
  const verified = guarded
    ? verifyAtDestination({
        destPath,
        boundIdentity: a.boundIdentity,
        guardHash,
        bindIdentity: a.bindIdentity,
        sameIdentity: a.sameIdentity,
        trashRoot: a.trashRoot,
        trashIdentity: a.trashIdentity,
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
    status: 'quarantined',
    path: destPath,
    entry: name,
    treeHash: observedTreeHash,
    sidecarPath,
    opId,
    ...(sidecarError === null ? {} : { sidecarError }),
    ...indexed(),
  }
}
