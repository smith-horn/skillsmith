// SMI-6676 C4: quarantine by rename, delete only by explicit prune (§4.4).
//
// Pure JS, no native shim dependency -- C4 is the FALLBACK for when native
// is unavailable, so it must work with nothing but `node:fs`. Where D1 asks
// for an extra Linux mnt_id check, that's attempted only if a native shim
// happens to already be loaded (best-effort precision), never required.
//
// D1 (owner, 2026-09-15), implemented exactly:
//   - path: <parent>/.skillsmith-trash/<opId>/<name>-<rnd>/, sidecar
//     <parent>/.skillsmith-trash/<opId>/<name>-<rnd>.json beside it.
//   - .skillsmith-trash is validated before use: must be a real directory
//     (not a symlink), same device (and mnt_id, when checkable) as the
//     parent. A .skillsmith-trash that fails this is never used.
//   - If the sibling rename fails for ANY reason (EXDEV, EACCES, EROFS,
//     EBUSY, ENOSPC, or anything else): nothing moves, nothing is deleted.
//     Stops `quarantine-failed`, reports path/entry/errno, and the tree is
//     left exactly where it was -- never a consolation delete, never a walk
//     up to a different parent.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SPIKE_VERSION = 'smi-6676-spike-c4-prototype'

function randSuffix() {
  return crypto.randomBytes(4).toString('hex')
}

function treeBytes(absPath) {
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
 * Validates (and if absent, creates) `<parentAbs>/.skillsmith-trash` per D1.
 * Never follows a symlink at that name, never uses a mount point there.
 *
 * @returns {{ok:true, trashRoot:string}|{ok:false, reason:string, errno:string|null}}
 */
function ensureTrashRoot(parentAbs, nativeShim) {
  const trashRoot = path.join(parentAbs, '.skillsmith-trash')
  let parentStat
  try {
    parentStat = fs.statSync(parentAbs)
  } catch (err) {
    return { ok: false, reason: 'quarantine-failed', errno: err.code ?? null }
  }

  try {
    fs.mkdirSync(trashRoot, { mode: parentStat.mode & 0o777 })
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return { ok: false, reason: 'quarantine-failed', errno: err.code ?? null }
    }
  }

  let trashLstat
  try {
    trashLstat = fs.lstatSync(trashRoot)
  } catch (err) {
    return { ok: false, reason: 'quarantine-failed', errno: err.code ?? null }
  }
  // D1's own words: "The caller stops with reason quarantine-failed" -- one
  // reason code covers every way the sibling rename can't be trusted,
  // including .skillsmith-trash itself being unusable (symlink or a
  // different mount) caught here, before rename is even attempted. `detail`
  // carries the specific diagnosis without diverging from the spec's single
  // outward reason string (caught during this checkpoint: an earlier draft
  // used its own reason codes here instead of D1's literal one).
  if (trashLstat.isSymbolicLink() || !trashLstat.isDirectory()) {
    return { ok: false, reason: 'quarantine-failed', detail: 'trash-unusable', errno: null }
  }
  if (trashLstat.dev !== parentStat.dev) {
    return { ok: false, reason: 'quarantine-failed', detail: 'trash-other-mount', errno: null }
  }
  if (nativeShim) {
    try {
      const pStat = nativeShim.statAt(nativeShim.openDir(parentAbs).fd, '.')
      const tStat = nativeShim.statAt(nativeShim.openDir(trashRoot).fd, '.')
      if (pStat.mntId !== undefined && tStat.mntId !== undefined && pStat.mntId !== tStat.mntId) {
        return {
          ok: false,
          reason: 'quarantine-failed',
          detail: 'trash-other-mount-mntid',
          errno: null,
        }
      }
    } catch {
      // Best-effort only -- a native probe failure here does not block C4,
      // since C4 must work with no native shim at all.
    }
  }

  return { ok: true, trashRoot }
}

/**
 * @param {string} parentAbs - the directory that held the tree
 * @param {string} name - the tree's own basename (never a path)
 * @param {object} [options]
 * @param {string} [options.opId]
 * @param {string} [options.kind]
 * @param {string} [options.client]
 * @param {string} [options.rootKey]
 * @param {string} [options.treeHash]
 * @param {object} [options.nativeShim] - optional, for the extra mnt_id check only
 * @returns {{status:'quarantined', path:string, sidecarPath:string, opId:string}
 *          |{status:'stopped', reason:string, path:string, entry:string, errno:string|null}}
 */
export function quarantineTree(parentAbs, name, options = {}) {
  const opId = options.opId ?? randSuffix()
  const originPath = path.join(parentAbs, name)

  const trash = ensureTrashRoot(parentAbs, options.nativeShim)
  if (!trash.ok) {
    return {
      status: 'stopped',
      reason: trash.reason,
      path: parentAbs,
      entry: name,
      errno: trash.errno,
    }
  }

  const opDir = path.join(trash.trashRoot, opId)
  try {
    fs.mkdirSync(opDir, { mode: 0o700, recursive: false })
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return {
        status: 'stopped',
        reason: 'quarantine-failed',
        path: opDir,
        entry: name,
        errno: err.code ?? null,
      }
    }
  }

  const rnd = randSuffix()
  const destName = `${name}-${rnd}`
  const destPath = path.join(opDir, destName)

  try {
    fs.renameSync(originPath, destPath)
  } catch (err) {
    // rename(2) is atomic: on any failure here, nothing moved. originPath
    // is untouched. Never fall back to a delete, never retarget elsewhere.
    return {
      status: 'stopped',
      reason: 'quarantine-failed',
      path: originPath,
      entry: name,
      errno: err.code ?? null,
    }
  }

  // The tree is already safely quarantined at this point -- rename(2)
  // succeeded, nothing was lost. A failure computing bytes or writing the
  // sidecar (e.g. ENOSPC, found during this checkpoint's own ENOSPC test:
  // the tmpfs had just enough room for the rename but not the sidecar) must
  // never escape as an uncaught exception or attempt anything destructive
  // in response -- it's reported as a quarantined result with the sidecar
  // problem named, not retried, not treated as though nothing happened.
  const sidecarPath = `${destPath}.json`
  try {
    const bytes = treeBytes(destPath)
    const sidecar = {
      opId,
      kind: options.kind ?? 'unspecified',
      client: options.client ?? 'spike',
      rootKey: options.rootKey ?? null,
      originPath,
      treeHash: options.treeHash ?? null,
      bytes,
      createdAt: new Date().toISOString(),
      skillsmithVersion: SPIKE_VERSION,
    }
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2))
  } catch (err) {
    return {
      status: 'quarantined',
      path: destPath,
      sidecarPath,
      opId,
      sidecarError: err.code ?? err.message,
    }
  }

  return { status: 'quarantined', path: destPath, sidecarPath, opId }
}
