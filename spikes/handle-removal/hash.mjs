// SMI-6676 VR's guard pass: hash through held handles (§4.1, §3.4).
//
// Depth-first from an already-open directory fd (the caller's T, from
// walk.mjs's bind step). Every directory opened along the way is HELD (its
// fd kept open, never re-resolved by path) until the removal pass is done
// with it -- that is the whole point of VR over C0: identity is pinned by
// an open handle, not re-checked against a name that could have changed.
//
// Tree hash, per docs/internal/implementation/update-safety-and-source-
// resolution.md §3.4 verbatim: "sha256 over the entries of an lstat walk
// that never follows links, sorted by relative path: rel, type, mode, size,
// and sha256 for a file or the link text for a symlink. Directories are
// included." Per-entry records additionally carry (dev, ino) -- §4.1's own
// guard-pass record shape, {type, dev, ino, mode, size, contentHash|
// linkText} -- since VR's removal pass re-verifies identity as well as
// content, not just content.

import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'

// EXDEV's numeric value differs across platforms this spike targets (Linux
// 18, macOS 62, seen from the shim's synthetic mount-boundary signal and its
// openat2 fallback) -- resolved once, from Node's own os.constants, rather
// than hardcoded per platform.
const EXDEV_ERRNO = -os.constants.errno.EXDEV

const REL_ROOT = ''

function childRel(parentRel, name) {
  return parentRel ? `${parentRel}/${name}` : name
}

/**
 * @param {object} shim - the loaded native-c addon
 * @param {number} topFd - already-open fd for the top of the tree (T)
 * @param {object} [options]
 * @param {Record<string, Function>} [options.hooks] - afterListing(relPath,
 *   entries), afterOpen(relPath, type) -- fired once per entry, right after
 *   it is opened/stat'd during the guard pass -- and afterSubtree(relPath),
 *   fired for a DIRECTORY once its whole subtree has been recorded.
 *
 *   These hooks bracket the window during which this pass was still reading
 *   anything about `relPath`, and WHICH HOOK MARKS THE START DEPENDS ON THE
 *   TYPE -- the asymmetry that matters most here:
 *
 *     directory        afterOpen (fd starts being held)  ..  afterSubtree
 *     file / symlink   beforeRead                        ..  afterOpen
 *
 *   afterOpen fires for a directory immediately after its openAt, but for a
 *   file only after its content has been read and hashed, and for a symlink
 *   after readlinkAt. So for a non-directory afterOpen is the window's END.
 *   `beforeRead(relPath, type)` supplies the missing START for those two
 *   types. Without it a consumer treating afterOpen as a start labels a
 *   mutation landing between the openAt and the hash as "the guard hashed the
 *   substitute" -- which is false, because the fd pinned the inode at openAt,
 *   and false in the direction that HIDES a V2 gap.
 *
 *   A caller timestamping the pair for an entry can say, for ONE entry,
 *   whether a concurrent mutation could have been visible to this pass --
 *   which the pass-level "guard started / guard ended" pair cannot (see
 *   harness/attacks/a13-vr.mjs classifyEntryPhase). afterSubtree fires ONLY on
 *   a subtree that completed; a pass that stopped part-way leaves it unfired
 *   for the enclosing directories, deliberately, so its absence means "not
 *   fully observed" rather than an instant that overstates what was read.
 *
 *   All are no-ops when the caller registers no such hook (the `typeof`
 *   check below), so they cost existing callers nothing.
 * @param {number} [options.maxHeldFds=512] - §4.1 step 3's cap.
 * @returns {{status:'ok', record:Map, heldFds:Map, treeHash:string}
 *          |{status:'stopped', reason:string, path:string, errno:number|null}}
 */
export function guardPass(shim, topFd, options = {}) {
  const hooks = options.hooks ?? {}
  const maxHeldFds = options.maxHeldFds ?? 512
  const callHook = (name, ...args) => {
    if (typeof hooks[name] === 'function') hooks[name](...args)
  }

  const record = new Map()
  const heldFds = new Map([[REL_ROOT, topFd]])
  let stopped = null

  function stop(reason, relPath, errno) {
    if (!stopped) stopped = { status: 'stopped', reason, path: relPath, errno: errno ?? null }
  }

  function fstatType(fd) {
    // fstat via Node's own fs on the shim's raw fd (confirmed accepted,
    // checkpoint 2 step 4). Used only for the root, which the shim opened
    // directly (openAt/openDir) rather than via a statAt(parent, name) call.
    const st = fs.fstatSync(fd, { bigint: true })
    return {
      dev: st.dev,
      ino: st.ino,
      mode: Number(st.mode),
      size: st.size,
      type: st.isDirectory()
        ? 'dir'
        : st.isSymbolicLink()
          ? 'symlink'
          : st.isFile()
            ? 'file'
            : 'other',
    }
  }

  // The root's own record comes from fstat on the already-open T, since
  // there is no "parent + name" to statAt through for it.
  const rootSt = fstatType(topFd)
  record.set(REL_ROOT, {
    type: rootSt.type,
    dev: rootSt.dev,
    ino: rootSt.ino,
    mode: rootSt.mode,
    size: rootSt.size,
  })

  function walk(relPath, dirFd) {
    if (stopped) return
    const rd = shim.readdirFd(dirFd)
    if (rd.errno !== 0) return stop('entry-removed', relPath, rd.errno)
    callHook('afterListing', relPath, rd.entries)

    const names = rd.entries.map((e) => e.name).sort()
    for (const name of names) {
      if (stopped) return
      const rel = childRel(relPath, name)
      const st = shim.statAt(dirFd, name)
      if (st.errno !== 0) return stop('entry-removed', rel, st.errno)

      if (st.type === 'other') return stop('unsupported-type', rel, null)

      if (st.type === 'dir') {
        if (heldFds.size >= maxHeldFds) return stop('tree-too-large', rel, null)
        const opened = shim.openAt(dirFd, name, true)
        if (opened.errno !== 0) {
          // EXDEV (mount boundary, real or synthetic from the shim's dev/
          // mnt_id compare) is UD21's mount-stop; anything else is a plain
          // open failure (vanished, ELOOP on a swapped-in symlink, etc).
          return stop(
            opened.errno === EXDEV_ERRNO ? 'mount-inside' : 'entry-removed',
            rel,
            opened.errno
          )
        }
        heldFds.set(rel, opened.fd)
        record.set(rel, { type: 'dir', dev: st.dev, ino: st.ino, mode: st.mode, size: st.size })
        callHook('afterOpen', rel, 'dir')
        walk(rel, opened.fd)
        if (!stopped) callHook('afterSubtree', rel)
      } else if (st.type === 'file') {
        // `beforeRead` marks the START of a non-directory's observation window.
        // A directory's window is bracketed by afterOpen..afterSubtree, but a
        // file's afterOpen fires only AFTER the content hash is taken -- so
        // afterOpen is its window's END, and a consumer treating it as a start
        // misreads a mutation landing between the openAt below and the hash as
        // "the guard hashed the substitute". It did not: the fd pins the inode
        // at openAt, so the guard provably read the ORIGINAL. That mislabelling
        // ran in the direction that HIDES a V2 gap.
        callHook('beforeRead', rel, 'file')
        const opened = shim.openAt(dirFd, name, false)
        if (opened.errno !== 0) return stop('entry-removed', rel, opened.errno)
        const size = Number(st.size)
        const buf = size > 0 ? Buffer.alloc(size) : Buffer.alloc(0)
        if (size > 0) fs.readSync(opened.fd, buf, 0, size, 0)
        const contentHash = crypto.createHash('sha256').update(buf).digest('hex')
        fs.closeSync(opened.fd)
        record.set(rel, {
          type: 'file',
          dev: st.dev,
          ino: st.ino,
          mode: st.mode,
          size: st.size,
          contentHash,
        })
        callHook('afterOpen', rel, 'file')
      } else if (st.type === 'symlink') {
        // Same asymmetry as the file branch: afterOpen fires after readlinkAt,
        // so it is this entry's window END, not its start.
        callHook('beforeRead', rel, 'symlink')
        const rl = shim.readlinkAt(dirFd, name)
        if (rl.errno !== 0) return stop('entry-removed', rel, rl.errno)
        record.set(rel, {
          type: 'symlink',
          dev: st.dev,
          ino: st.ino,
          mode: st.mode,
          size: st.size,
          linkText: rl.target,
        })
        callHook('afterOpen', rel, 'symlink')
      }
    }
  }

  walk(REL_ROOT, topFd)
  // The root gets no afterOpen -- it is fstat'd above, before the pass
  // proper begins, so its own observation instant IS the caller's
  // "guard started" timestamp. It does get an afterSubtree, on the same
  // completed-only rule as every other directory.
  if (!stopped) callHook('afterSubtree', REL_ROOT)

  if (stopped) {
    for (const fd of heldFds.values()) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already gone */
      }
    }
    return stopped
  }

  return { status: 'ok', record, heldFds, treeHash: computeTreeHash(record) }
}

/**
 * §3.4's tree hash, computed from a guardPass() record instead of a path
 * walk -- the serialization rule (sorted by rel, {rel, type, mode, size,
 * contentHash|linkText}) is the same either way, which is exactly what lets
 * checkpoint 2's own "done when" compare the two.
 */
export function computeTreeHash(record) {
  const rels = [...record.keys()].sort()
  const hash = crypto.createHash('sha256')
  for (const rel of rels) {
    const e = record.get(rel)
    const contentPart = e.type === 'file' ? e.contentHash : e.type === 'symlink' ? e.linkText : ''
    hash.update(`${rel} ${e.type} ${e.mode} ${e.size} ${contentPart}\n`)
  }
  return hash.digest('hex')
}
