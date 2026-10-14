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
import crypto from 'node:crypto'
import { computeTreeHash } from './hash.mjs'
import { MOUNTINFO_APPLIES, readMountPointsAtOrUnder } from './quarantine.mounts.mjs'
import { appendParkedIndex } from './trash-index.mjs'

/**
 * Builds a §3.4 tree-hash record from a PATH walk, in the same shape
 * `guardPass()` builds from held handles, so `computeTreeHash()` yields the
 * identical digest for the identical tree (harness/test-guard-hash-parity.mjs).
 * Moved here verbatim from quarantine.mjs, plus `mountCheck`.
 *
 * `mountCheck: true` (S2/S9b) compares each entry's bigint `dev` with the
 * root's -- no extra fs calls -- and stops at the first difference with reason
 * `mount-inside-tree` and `rel`, the entry's path relative to the root. The
 * default stays mount-TOLERANT, because the harness's caller hash
 * (`computePathTreeHash`) must walk through a mount (design §1, R13).
 *
 * @returns {{ok:true, record:Map}|{ok:false, reason:string, path:string, rel?:string, errno:string|null}}
 */
export function pathTreeRecord(absRoot, { mountCheck = false } = {}) {
  const record = new Map()
  let rootDev = null
  function visit(rel, abs) {
    let st
    try {
      st = fs.lstatSync(abs, { bigint: true })
    } catch (err) {
      return { ok: false, reason: 'guard-unreadable', path: abs, errno: err.code ?? null }
    }
    if (rootDev === null) rootDev = st.dev
    else if (mountCheck && st.dev !== rootDev) {
      return { ok: false, reason: 'mount-inside-tree', path: abs, rel, errno: null }
    }
    const mode = Number(st.mode)
    const size = st.size
    if (st.isDirectory()) {
      record.set(rel, { type: 'dir', mode, size })
      let names
      try {
        names = fs.readdirSync(abs).sort()
      } catch (err) {
        return { ok: false, reason: 'guard-unreadable', path: abs, errno: err.code ?? null }
      }
      for (const name of names) {
        const r = visit(rel ? `${rel}/${name}` : name, path.join(abs, name))
        if (r && r.ok === false) return r
      }
      return null
    }
    if (st.isSymbolicLink()) {
      try {
        record.set(rel, { type: 'symlink', mode, size, linkText: fs.readlinkSync(abs) })
      } catch (err) {
        return { ok: false, reason: 'guard-unreadable', path: abs, errno: err.code ?? null }
      }
      return null
    }
    if (st.isFile()) {
      let buf
      try {
        buf = fs.readFileSync(abs)
      } catch (err) {
        return { ok: false, reason: 'guard-unreadable', path: abs, errno: err.code ?? null }
      }
      record.set(rel, {
        type: 'file',
        mode,
        size,
        contentHash: crypto.createHash('sha256').update(buf).digest('hex'),
      })
      return null
    }
    return { ok: false, reason: 'guard-unsupported-type', path: abs, errno: null }
  }
  const failure = visit('', absRoot)
  if (failure) return failure
  return { ok: true, record }
}

/**
 * S2b / S9c: on Linux, a mountinfo mount point at or under `dirReal`.
 * Returns null when there is none, else a detail string. An unreadable table
 * FAILS CLOSED -- it is reported as a possible mount, never as "none" -- since
 * a same-filesystem bind mount is otherwise undetectable (design §6).
 */
export function mountinfoFinding(dirReal) {
  if (!MOUNTINFO_APPLIES) return null
  const m = readMountPointsAtOrUnder(dirReal)
  if (!m.ok) return `mountinfo unreadable (${m.errno}); a bind mount cannot be ruled out`
  return m.points.length > 0 ? `mount point ${m.points[0]}` : null
}

/**
 * S9: post-move verification at `destPath`. Reads only; never writes anywhere,
 * and never touches the origin. Order per design §1: identity (a), walk with
 * the st_dev check (b), mountinfo (c), re-hash (d).
 *
 * @returns {{ok:true, treeHash:string}
 *          |{ok:false, reason:'changed-during-move'|'mount-appeared-during-move',
 *            diagnosis:string, treeHash:string|null}}
 */
export function verifyAtDestination({
  destPath,
  boundIdentity,
  guardHash,
  bindIdentity,
  sameIdentity,
}) {
  const held = (reason, diagnosis, treeHash = null) => ({ ok: false, reason, diagnosis, treeHash })
  const at = bindIdentity(destPath)
  if (!at.ok) return held('changed-during-move', `identity at destination unreadable (${at.errno})`)
  if (!sameIdentity(boundIdentity, at)) {
    return held(
      'changed-during-move',
      'identity at destination does not match the tree C4 verified'
    )
  }
  const rec = pathTreeRecord(destPath, { mountCheck: true })
  if (!rec.ok) {
    if (rec.reason === 'mount-inside-tree') {
      return held(
        'mount-appeared-during-move',
        `mount at ${rec.rel} (st_dev differs from the root)`
      )
    }
    return held(
      'changed-during-move',
      `${rec.reason} at ${rec.path}${rec.errno ? ` (${rec.errno})` : ''}`
    )
  }
  let destReal
  try {
    destReal = fs.realpathSync(destPath)
  } catch (err) {
    return held('changed-during-move', `destination realpath failed (${err.code ?? err.message})`)
  }
  const mi = mountinfoFinding(destReal)
  if (mi !== null) return held('mount-appeared-during-move', mi)
  const treeHash = computeTreeHash(rec.record)
  if (treeHash !== guardHash) {
    return held(
      'changed-during-move',
      'tree hash at the destination differs from guardHash',
      treeHash
    )
  }
  return { ok: true, treeHash }
}

/** POSIX single-quote escaping, for the reference restore line in `detail` only. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * The `detail` of a held result. Names the diagnosis, where the tree is, the
 * origin, and the product restore command (owner decision 2026-10-12:
 * `skillsmith restore <id>`, built in SMI-6531).
 */
export function heldDetail({ diagnosis, destPath, originPath, opId }) {
  return (
    `${diagnosis}. Changed during removal; your tree is safe at ${shq(destPath)}. ` +
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
      detail: heldDetail({ diagnosis: verified.diagnosis, destPath, originPath, opId }),
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
