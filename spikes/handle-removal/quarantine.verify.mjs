// SMI-6715 Step 1b / SMI-7134: the tree walk, mountinfo probe and post-move
// verification (S9), split out of quarantine.postmove.mjs for file length. See that
// file's header for the C4 repair and ADR-166 D-10. fs is imported as the DEFAULT
// export only (c4-fs-boundary.mjs checks it).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { computeTreeHash } from './hash.mjs'
import { MOUNTINFO_APPLIES, readMountPointsAtOrUnder } from './quarantine.mounts.mjs'
import { S_IFMT, opDirOwnerModeProblem } from './quarantine.perms.mjs'

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
 * and never touches the origin. Order (SMI-7134 gate): the CONTENT checks run first
 * -- walk with the st_dev check, mountinfo, re-hash -- and every LOCATION check runs
 * afterwards as one final block. Content is observed first; the location block then
 * confirms where the tree is at that moment. A swap that is still in place at the
 * location block is seen; a swap undone before it, or any write after the hash, is not.
 *
 * The final block (checkLocation) asks whether the entry is the tree C4 bound and
 * sits in the directory C4 validated, not where its own realpath leads: rename(2)
 * keeps the inode and the tree, so a swapped op directory or trash root passes the
 * hash while the tree sits elsewhere. In order: (1) destination identity (type
 * included) equals `boundIdentity`, so a byte-identical COPY placed at destPath
 * fails on its different inode; (2) realpath of the entry's PARENT equals `opReal`;
 * (3) the trash root still matches `trashIdentity`; (4) the op directory still
 * matches `opIdentity`; (5) it still passes the F12 owner/mode check
 * (`opDirOwnerModeProblem`, shared with the pre-move site). The entry itself is
 * never realpath'ed: a symlink skill root resolves to its target, outside the trash
 * by design. Nothing is moved back on a mismatch.
 *
 * WHAT THIS GUARANTEES, HONESTLY: a final snapshot taken AFTER the hash. Content
 * changes after the hash (and a swap undone before the location block) are not
 * detected, nor is the gap between the last check and the return, nor the rename(2)
 * race before it; all are the accepted ADR-166 D-0 content-staleness residual. An absolute guarantee needs a
 * held-directory / fd-relative design that Node 22 does not expose.
 *
 * @returns {{ok:true, treeHash:string}
 *          |{ok:false, reason:'changed-during-move'|'mount-appeared-during-move',
 *            diagnosis:string, treeHash:string|null, located:boolean, safe:boolean}}
 *   `located`: checks (1)-(4) passed, so we know where the tree is. `safe`: (5)
 *   passed too, so it is in a private directory C4 validated. A content failure
 *   (hash, mount) is reported with the location block's verdict, never ahead of it,
 *   so its message claims safety only when the final block confirmed it.
 */
export function verifyAtDestination({
  destPath,
  boundIdentity,
  guardHash,
  bindIdentity,
  sameIdentity,
  trashRoot,
  trashIdentity,
  opReal,
  opIdentity,
}) {
  const held = (reason, diagnosis, treeHash = null, located = false, safe = false) => ({
    ok: false,
    reason,
    diagnosis,
    treeHash,
    located,
    safe,
  })
  const opDir = path.dirname(destPath)
  const checkLocation = () => {
    const at = bindIdentity(destPath)
    if (!at.ok)
      return held('changed-during-move', `identity at destination unreadable (${at.errno})`)
    if (!sameIdentity(boundIdentity, at)) {
      return held(
        'changed-during-move',
        'identity at destination does not match the tree C4 verified'
      )
    }
    let parentReal = null
    try {
      parentReal = fs.realpathSync(opDir)
    } catch (err) {
      return held(
        'changed-during-move',
        `op directory unresolvable after the move (${err.code ?? err.message})`
      )
    }
    if (typeof opReal !== 'string' || parentReal !== opReal) {
      return held(
        'changed-during-move',
        'op directory resolves elsewhere than where C4 validated it'
      )
    }
    const trashNow = bindIdentity(trashRoot)
    if (trashIdentity == null || !trashNow.ok || !sameIdentity(trashIdentity, trashNow)) {
      return held('changed-during-move', 'trash root is no longer the one C4 validated')
    }
    let opNow = null
    try {
      opNow = fs.lstatSync(opDir, { bigint: true })
    } catch (err) {
      return held(
        'changed-during-move',
        `op directory identity unreadable after the move (${err.code ?? err.message})`
      )
    }
    const opNowIdentity = {
      ok: true,
      dev: opNow.dev,
      ino: opNow.ino,
      birthtimeNs: opNow.birthtimeNs,
      fmt: opNow.mode & S_IFMT,
    }
    if (opIdentity == null || !sameIdentity(opIdentity, opNowIdentity)) {
      return held(
        'changed-during-move',
        'op directory identity check failed: it is no longer the directory C4 validated'
      )
    }
    const permProblem = opDirOwnerModeProblem(opNow)
    if (permProblem !== null) {
      return held(
        'changed-during-move',
        `op directory owner/mode check failed after the move: ${permProblem}`,
        null,
        true
      )
    }
    return null
  }
  // Content first; the location verdict decides which result is reported.
  const finish = (content) => {
    const loc = checkLocation()
    if (loc !== null) {
      // The location failure decides; a content failure is still named, not dropped.
      const also =
        content === null
          ? ''
          : `; content check also failed: ${content.reason}: ${content.diagnosis}`
      return { ...loc, diagnosis: loc.diagnosis + also, treeHash: content?.treeHash ?? null }
    }
    if (content === null) return null
    return held(content.reason, content.diagnosis, content.treeHash, true, true)
  }
  const rec = pathTreeRecord(destPath, { mountCheck: true })
  if (!rec.ok) {
    if (rec.reason === 'mount-inside-tree') {
      return finish({
        reason: 'mount-appeared-during-move',
        diagnosis: `mount at ${rec.rel} (st_dev differs from the root)`,
        treeHash: null,
      })
    }
    return finish({
      reason: 'changed-during-move',
      diagnosis: `${rec.reason} at ${rec.path}${rec.errno ? ` (${rec.errno})` : ''}`,
      treeHash: null,
    })
  }
  // opReal is pinned before the rename; probe at opReal + entry name, never
  // realpath(entry): a symlink root would otherwise be checked at its target (SMI-7132).
  // opReal is compared to the live op directory in the location block, not here.
  if (typeof opReal !== 'string') {
    return finish({
      reason: 'changed-during-move',
      diagnosis: 'the pinned op directory path is missing, so mountinfo cannot be probed',
      treeHash: null,
    })
  }
  const mi = mountinfoFinding(path.join(opReal, path.basename(destPath)))
  if (mi !== null) {
    return finish({ reason: 'mount-appeared-during-move', diagnosis: mi, treeHash: null })
  }
  const treeHash = computeTreeHash(rec.record)
  if (treeHash !== guardHash) {
    return finish({
      reason: 'changed-during-move',
      diagnosis: 'tree hash at the destination differs from guardHash',
      treeHash,
    })
  }
  const bad = finish(null)
  return bad ?? { ok: true, treeHash }
}
