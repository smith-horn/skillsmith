// SMI-6676 VR: verified removal through handles (§4.1). V0/V1/V2, sharing
// one bind + guard-pass + post-order removal skeleton, differing only in
// what the removal pass checks before it acts on each entry:
//   V0 -- handle-relative only, no re-check at removal time.
//   V1 -- V0 plus a (dev, ino) identity re-check before each unlink.
//   V2 -- V1 plus per-entry content/identity re-verification and a rename
//         into a private quarantine directory before every unlink (§4.1
//         step 4's full algorithm: fd = openAt, fstat compare, re-hash,
//         renameAtNoReplace into Q, statAt(Q) compare, then unlink from Q).
//
// Every directory the guard pass opens is HELD (fd kept open) until the
// removal pass is done with it -- identity is pinned by the open handle,
// never re-resolved by name. That is what checkpoint 1's C0 (a path-based
// walk with no handles held) cannot do, and is the property this checkpoint
// is measuring.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { loadShim } from './native-c/load.mjs'
import { guardPass, computeTreeHash } from './hash.mjs'

const EXDEV_ERRNO = -os.constants.errno.EXDEV

function childRel(parentRel, name) {
  return parentRel ? `${parentRel}/${name}` : name
}

function randSuffix() {
  return crypto.randomBytes(4).toString('hex')
}

function statIdentity(shim, dirFd, name) {
  const st = shim.statAt(dirFd, name)
  if (st.errno !== 0) return { ok: false, errno: st.errno }
  return { ok: true, st }
}

function fstatIdentity(fd) {
  const st = fs.fstatSync(fd, { bigint: true })
  return { dev: st.dev, ino: st.ino, mode: Number(st.mode), size: st.size }
}

/**
 * Removes `targetRoot` through held handles.
 *
 * @param {string} targetRoot - absolute path to the top of the tree
 * @param {object} [options]
 * @param {'V0'|'V1'|'V2'} [options.variant='V2']
 * @param {string} [options.guardHash] - if given, the guard pass's tree hash
 *   must equal this or the operation returns `kept` without removing
 *   anything (the plan's guard concept, §3/§4.1 step 3).
 * @param {string} [options.opId] - used to name V2's quarantine directory.
 * @param {Record<string, Function>} [options.hooks] - beforeBind(),
 *   afterBind() [T is open and held; the guard pass has not started],
 *   afterListing(relPath, entries) [guard pass], afterOpen(relPath, type)
 *   [guard pass -- fired the instant a directory is opened and its fd
 *   starts being held, before its own children are listed], AND fired for
 *   files/symlinks too, right after they're read/readlinked, betweenGuard
 *   AndRemoval(), beforeUnlink(relPath, type) [removal pass, fired once per
 *   entry right before it is acted on].
 * @returns {{status:'removed'|'kept', treeHash?:string}
 *          |{status:'stopped', reason:string, path:string, errno:number|null}}
 */
export function removeVR(targetRoot, options = {}) {
  const { variant = 'V2', guardHash, opId = randSuffix(), hooks = {} } = options
  const shim = loadShim()
  const callHook = (name, ...args) => {
    if (typeof hooks[name] === 'function') hooks[name](...args)
  }

  callHook('beforeBind')

  const parentAbs = path.dirname(targetRoot)
  const name = path.basename(targetRoot)

  const P = shim.openDir(parentAbs)
  if (P.errno !== 0) return { status: 'stopped', reason: 'bind-failed', path: '', errno: P.errno }
  const T = shim.openAt(P.fd, name, true)
  if (T.errno !== 0) {
    fs.closeSync(P.fd)
    return {
      status: 'stopped',
      reason: T.errno === EXDEV_ERRNO ? 'mount-inside' : 'bind-failed',
      path: '',
      errno: T.errno,
    }
  }

  callHook('afterBind')

  // Guard pass: hash through handles, holding every directory fd.
  const guard = guardPass(shim, T.fd, { hooks })
  if (guard.status === 'stopped') {
    fs.closeSync(P.fd)
    return guard
  }
  const { record, heldFds, treeHash } = guard

  callHook('betweenGuardAndRemoval')

  if (guardHash !== undefined && guardHash !== treeHash) {
    for (const fd of heldFds.values()) closeQuiet(fd)
    closeQuiet(P.fd)
    return { status: 'kept', treeHash }
  }

  // V2 only: a private quarantine directory, sibling of the tree, on P.
  let Q = null
  let qname = null
  if (variant === 'V2') {
    qname = `.skillsmith-rm-${opId}`
    const mk = shim.mkdirAt(P.fd, qname, 0o700)
    if (mk.errno !== 0) {
      for (const fd of heldFds.values()) closeQuiet(fd)
      closeQuiet(P.fd)
      return { status: 'stopped', reason: 'quarantine-failed', path: '', errno: mk.errno }
    }
    const qopen = shim.openAt(P.fd, qname, true)
    if (qopen.errno !== 0) {
      for (const fd of heldFds.values()) closeQuiet(fd)
      closeQuiet(P.fd)
      return { status: 'stopped', reason: 'quarantine-failed', path: '', errno: qopen.errno }
    }
    Q = qopen.fd
  }

  let stopped = null
  function stop(reason, relPath, errno) {
    if (!stopped) stopped = { status: 'stopped', reason, path: relPath, errno: errno ?? null }
  }

  // --- per-entry removal actions, one per variant -----------------------

  function removeLeafV0(D, name, rel, rec) {
    callHook('beforeUnlink', rel, rec.type)
    const r = shim.unlinkAt(D, name, false)
    if (r.errno !== 0) stop('removal-failed', rel, r.errno)
  }

  function removeLeafV1(D, name, rel, rec) {
    const id = statIdentity(shim, D, name)
    if (!id.ok) return stop('entry-removed', rel, id.errno)
    if (id.st.dev !== rec.dev || id.st.ino !== rec.ino) return stop('identity-changed', rel, null)
    removeLeafV0(D, name, rel, rec)
  }

  // Shared V2 primitive (§4.1 step 4/5): rename an entry into Q under a
  // random name, ask `verifyFn(rnd)` whether what landed in Q is really the
  // thing that was pinned/expected, unlink it from Q, and revert the rename
  // (back to its original (D, name)) on ANY failure past the initial
  // rename -- not just a verify mismatch. (A real bug caught by
  // A6-VR/root/none/V2 during checkpoint 2: three of the four call sites
  // originally skipped the revert step for a verify mismatch and only the
  // file path had it. A SECOND instance of the identical three-of-four-
  // sites shape was found via A13's real concurrent racer, checkpoint 6's
  // closing pass: all four call sites reverted on a verify mismatch, but
  // NONE of them reverted when the final unlinkAt/rmdir itself failed AFTER
  // a successful verify -- e.g. a racing process adds a new file inside a
  // directory before it's quarantined but after its own children were
  // already processed, so the directory's OWN identity still verifies
  // (rename doesn't change dev/ino) but the final rmdir then fails
  // ENOTEMPTY. That left the entry (and the racer's own content inside it)
  // correctly un-destroyed but permanently stranded under a random name in
  // the operation's own quarantine directory instead of restored to where
  // a caller or a doctor-style scan would expect to find it. Reverting is
  // safe here for the same reason it's safe on a verify mismatch: rename(2)
  // moves the entry (and whatever it currently contains) atomically,
  // regardless of what raced its way inside it first.)
  function quarantineAndRemove(D, name, isDir, verifyFn) {
    const rnd = randSuffix()
    const rn = shim.renameAtNoReplace(D, name, Q, rnd)
    if (rn.errno !== 0) return { ok: false, reason: 'entry-substituted', errno: rn.errno }
    if (!verifyFn(rnd)) {
      const back = shim.renameAtNoReplace(Q, rnd, D, name)
      return {
        ok: false,
        reason: back.errno === 0 ? 'entry-substituted' : 'entry-substituted-left-in-quarantine',
        errno: null,
      }
    }
    const un = shim.unlinkAt(Q, rnd, isDir)
    if (un.errno !== 0) {
      const back = shim.renameAtNoReplace(Q, rnd, D, name)
      return {
        ok: false,
        reason: back.errno === 0 ? 'removal-failed' : 'removal-failed-left-in-quarantine',
        errno: un.errno,
      }
    }
    return { ok: true, rnd }
  }

  function removeFileV2(D, name, rel, rec) {
    const opened = shim.openAt(D, name, false)
    if (opened.errno !== 0) return stop('entry-removed', rel, opened.errno)
    const pinned = fstatIdentity(opened.fd)
    if (pinned.dev !== rec.dev || pinned.ino !== rec.ino) {
      fs.closeSync(opened.fd)
      return stop('identity-changed', rel, null)
    }
    const size = Number(pinned.size)
    const buf = size > 0 ? Buffer.alloc(size) : Buffer.alloc(0)
    if (size > 0) fs.readSync(opened.fd, buf, 0, size, 0)
    const contentHash = crypto.createHash('sha256').update(buf).digest('hex')
    if (pinned.size !== rec.size || pinned.mode !== rec.mode || contentHash !== rec.contentHash) {
      fs.closeSync(opened.fd)
      return stop('entry-changed', rel, null)
    }
    callHook('beforeUnlink', rel, rec.type)
    const q = quarantineAndRemove(D, name, false, (rnd) => {
      const qst = shim.statAt(Q, rnd)
      return qst.errno === 0 && qst.dev === pinned.dev && qst.ino === pinned.ino
    })
    fs.closeSync(opened.fd)
    if (!q.ok) return stop(q.reason, rel, q.errno)
  }

  function removeSymlinkV2(D, name, rel, rec) {
    const rl = shim.readlinkAt(D, name)
    if (rl.errno !== 0) return stop('entry-removed', rel, rl.errno)
    if (rl.target !== rec.linkText) return stop('entry-changed', rel, null)
    callHook('beforeUnlink', rel, rec.type)
    const q = quarantineAndRemove(D, name, false, (rnd) => {
      const qrl = shim.readlinkAt(Q, rnd)
      return qrl.errno === 0 && qrl.target === rec.linkText
    })
    if (!q.ok) return stop(q.reason, rel, q.errno)
  }

  function removeDirV2(D, name, rel, rec) {
    const heldFd = heldFds.get(rel)
    if (heldFd === undefined) return stop('entry-removed', rel, null)
    const id = statIdentity(shim, D, name)
    if (!id.ok) return stop('entry-removed', rel, id.errno)
    const pinned = fstatIdentity(heldFd)
    if (id.st.dev !== pinned.dev || id.st.ino !== pinned.ino)
      return stop('identity-changed', rel, null)
    callHook('beforeUnlink', rel, rec.type)
    // isDir=true here means the final step is an rmdir (ENOTEMPTY/EBUSY
    // land in the un.errno check inside quarantineAndRemove) -- on failure
    // the rename is now reverted instead of leaving the entry stranded in Q.
    const q = quarantineAndRemove(D, name, true, (rnd) => {
      const qst = shim.statAt(Q, rnd)
      return qst.errno === 0 && qst.dev === pinned.dev && qst.ino === pinned.ino
    })
    if (!q.ok) return stop(q.reason, rel, q.errno)
    fs.closeSync(heldFd)
  }

  // --- shared post-order removal walk ------------------------------------

  function removalWalk(relPath) {
    if (stopped) return
    const D = heldFds.get(relPath)
    const rd = shim.readdirFd(D)
    if (rd.errno !== 0) return stop('entry-removed', relPath, rd.errno)
    const names = rd.entries.map((e) => e.name).sort()
    for (const name of names) {
      if (stopped) return
      const rel = childRel(relPath, name)
      const rec = record.get(rel)
      if (!rec) return stop('entry-added', rel, null)

      if (rec.type === 'dir') {
        removalWalk(rel)
        if (stopped) return
        if (variant === 'V2') removeDirV2(D, name, rel, rec)
        else {
          if (variant === 'V1') {
            const id = statIdentity(shim, D, name)
            if (!id.ok) return stop('entry-removed', rel, id.errno)
            if (id.st.dev !== rec.dev || id.st.ino !== rec.ino)
              return stop('identity-changed', rel, null)
          }
          callHook('beforeUnlink', rel, rec.type)
          const r = shim.unlinkAt(D, name, true)
          if (r.errno !== 0) stop('removal-failed', rel, r.errno)
          else fs.closeSync(heldFds.get(rel))
        }
      } else if (rec.type === 'file') {
        if (variant === 'V2') removeFileV2(D, name, rel, rec)
        else if (variant === 'V1') removeLeafV1(D, name, rel, rec)
        else removeLeafV0(D, name, rel, rec)
      } else if (rec.type === 'symlink') {
        if (variant === 'V2') removeSymlinkV2(D, name, rel, rec)
        else if (variant === 'V1') removeLeafV1(D, name, rel, rec)
        else removeLeafV0(D, name, rel, rec)
      }
    }
  }

  removalWalk('')

  // Top of the tree, per §4.1 step 5 (V2) or the V0/V1 equivalent.
  if (!stopped) {
    if (variant === 'V2') {
      const pinned = fstatIdentity(T.fd)
      const q = quarantineAndRemove(P.fd, name, true, (rnd) => {
        const qst = shim.statAt(Q, rnd)
        return qst.errno === 0 && qst.dev === pinned.dev && qst.ino === pinned.ino
      })
      if (!q.ok) stop(q.reason, '', q.errno)
    } else {
      if (variant === 'V1') {
        const id = statIdentity(shim, P.fd, name)
        const rootRec = record.get('')
        if (!id.ok) stop('entry-removed', '', id.errno)
        else if (id.st.dev !== rootRec.dev || id.st.ino !== rootRec.ino)
          stop('identity-changed', '', null)
      }
      if (!stopped) {
        const r = shim.unlinkAt(P.fd, name, true)
        if (r.errno !== 0) stop('removal-failed', '', r.errno)
      }
    }
  }

  // V2 only: Q should hold nothing once every entry has been quarantined
  // and unlinked in turn -- rmdir it too on a clean run. A stop leaves it
  // (at most one entry, per §4.1 step 6), reported by the caller, never
  // removed here.
  if (!stopped && variant === 'V2') {
    const rmq = shim.unlinkAt(P.fd, qname, true)
    if (rmq.errno !== 0) stop('removal-failed', '', rmq.errno)
  }

  // On a stop, some held fds below the stop point were never reached by a
  // successful directory removal (which is what closes them in the happy
  // path) -- close every remaining one now rather than leaking descriptors
  // across a 300-run attack cell.
  for (const fd of heldFds.values()) closeQuiet(fd)
  if (Q !== null) closeQuiet(Q)
  closeQuiet(P.fd)

  if (stopped) return stopped
  return { status: 'removed', treeHash }
}

function closeQuiet(fd) {
  try {
    fs.closeSync(fd)
  } catch {
    /* already gone */
  }
}
