// SMI-7123 Wave 5 (design §5, §6, §7): every named stub and mutant, one export each.
//
// Two kinds:
//  - FUNCTION STUBS: a deliberately wrong implementation of one function, used
//    as the red target of a test or as a row's control arm. They are
//    self-contained and import none of the W5 modules they stand in for, so a
//    test can be run red against them before the real module exists.
//  - SOURCE MUTANTS (WALKER_MUTANTS, MUTATIONS): an exact text edit to a real
//    module. `materialize()` (w5-variant.mjs) applies it to a temporary copy,
//    asserting the edit matches exactly once, and rewrites the copy's relative
//    imports to this spike's absolute paths. Nothing in the spike is edited.
import fs from 'node:fs'
import path from 'node:path'
import { computePathTreeHash } from '../quarantine.mjs'

const readJsonOrNull = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** classify-lenient (T2): any parseable sidecar whose hash matches is clean; no schema. */
export function classifyLenient(copy) {
  const sc = readJsonOrNull(copy.sidecarPath)
  const fresh = computePathTreeHash(copy.copyPath)
  const freshHash = fresh.ok ? fresh.treeHash : null
  if (sc === null || sc.hold === true) return { klass: 'held', reason: 'lenient', freshHash }
  const recorded = sc.postMoveTreeHash ?? sc.treeHash ?? null
  return { klass: recorded === freshHash ? 'clean' : 'changed', reason: null, freshHash }
}

/** classify-default-clean (T4): clean unless something positively says otherwise. */
export function classifyDefaultClean(copy) {
  const sc = readJsonOrNull(copy.sidecarPath)
  const fresh = computePathTreeHash(copy.copyPath)
  const freshHash = fresh.ok ? fresh.treeHash : null
  if (sc !== null && sc.hold === true) return { klass: 'held', reason: 'hold', freshHash }
  if (sc !== null && sc.postMoveTreeHash && sc.postMoveTreeHash !== freshHash) {
    return { klass: 'changed', reason: null, freshHash }
  }
  return { klass: 'clean', reason: null, freshHash }
}

/** read-once (T3): one read, no second fstat, so a write between reads is invisible. */
export function readOnce(p, { afterRead } = {}) {
  let fd
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: err.code ?? null }
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true })
    const bytes = fs.readFileSync(fd)
    if (typeof afterRead === 'function') afterRead()
    return { ok: true, bytes, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs }
  } finally {
    fs.closeSync(fd)
  }
}

/** warn-max-not-min (T19, W1 control): the threshold uses max() where min() is required. */
export function warnMaxNotMin(usage, { capBytes = 1e9, freeFraction = 0.05 } = {}) {
  const perVolume = usage.volumes.map((v) => {
    const thresholdBytes = Math.max(capBytes, freeFraction * v.freeBytes)
    const totalBytes = v.copies.reduce((n, c) => n + c.bytes, 0)
    return { thresholdBytes, totalBytes, over: totalBytes > thresholdBytes, largest: [] }
  })
  return { over: perVolume.some((p) => p.over), perVolume, message: null }
}

/** Reference min() threshold, used only so the stub-only red run has a counterpart. */
export function warnMinReference(usage, { capBytes = 1e9, freeFraction = 0.05 } = {}) {
  const perVolume = usage.volumes.map((v) => {
    const thresholdBytes = Math.min(capBytes, freeFraction * v.freeBytes)
    const totalBytes = v.copies.reduce((n, c) => n + c.bytes, 0)
    return { thresholdBytes, totalBytes, over: totalBytes > thresholdBytes, largest: [] }
  })
  return { over: perVolume.some((p) => p.over), perVolume, message: null }
}

/** warn-apparent-bytes (W1 control): totals the sidecar's apparent `bytes`, the design's revision-2 rule. */
export function usageApparentBytes({ roots, statfs = fs.statfsSync }) {
  const copies = naiveCopies(roots).map((c) => {
    const sc = readJsonOrNull(c.sidecarPath)
    return {
      path: c.copyPath,
      bytes: Number.isSafeInteger(sc?.bytes) ? sc.bytes : 0,
      originPath: sc?.originPath ?? null,
      opId: path.basename(path.dirname(c.copyPath)),
    }
  })
  const s = statfs(roots[0])
  return {
    volumes: [
      { dev: 'apparent', freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize, copies },
    ],
  }
}

// ---------------------------------------------------------------------------
// Prune-level FUNCTION STUBS (same signature as prune()). Each lists the trash
// itself (a plain readdir, no W5 module) and deletes with rmSync.
// ---------------------------------------------------------------------------

function naiveCopies(roots) {
  const out = []
  for (const root of roots) {
    const trash = path.join(root, '.skillsmith-trash')
    let ops = []
    try {
      ops = fs.readdirSync(trash)
    } catch {
      continue
    }
    for (const op of ops) {
      const opDir = path.join(trash, op)
      if (op.startsWith('.') || !fs.lstatSync(opDir).isDirectory()) continue
      for (const x of fs.readdirSync(opDir)) {
        if (!x.endsWith('.json'))
          out.push({
            copyPath: path.join(opDir, x),
            sidecarPath: path.join(opDir, `${x}.json`),
            name: x,
          })
      }
    }
  }
  return out
}
/**
 * Depth-first delete, children before parents, crossing mounts -- what `rm -rf`
 * does. NOT fs.rmSync: node's rimraf tries rmdir(2) on a directory before
 * descending, so on darwin it stops with EBUSY at a mount point and never
 * reaches the mounted bytes (measured: T5 stayed green against an rmSync stub).
 * Errors are swallowed per entry, like `rm -rf`, so it keeps going.
 */
export function rmRf(p) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch {
    return
  }
  if (st.isDirectory()) {
    let names = []
    try {
      names = fs.readdirSync(p)
    } catch {
      /* keep going */
    }
    for (const n of names) rmRf(path.join(p, n))
    try {
      fs.rmdirSync(p)
    } catch {
      /* EBUSY at a mount point: rm -rf reports and continues */
    }
  } else {
    try {
      fs.unlinkSync(p)
    } catch {
      /* keep going */
    }
  }
}
const rmCopy = (c) => {
  rmRf(c.copyPath)
  rmRf(c.sidecarPath)
}
const removedItem = (c) => ({
  status: 'removed',
  reason: null,
  path: c.copyPath,
  entry: c.name,
  misplaced: null,
})

/** prune-naive (T5, R1/P1/P2/P4 control): every copy deleted with rmSync, whatever its class. */
export function pruneNaive({ roots, apply = false, confirmBatch }) {
  const copies = naiveCopies(roots)
  if (!apply) return { plan: { count: copies.length }, items: [], exitCode: 0 }
  if (typeof confirmBatch === 'function' && confirmBatch(copies, '') !== true) {
    return { plan: {}, items: [], exitCode: 0 }
  }
  for (const c of copies) rmCopy(c)
  return { plan: { count: copies.length }, items: copies.map(removedItem), exitCode: 0 }
}

/** prune-warn-only (T6, P6 control): --allow-changed is a warning, the batch yes covers everything. */
export function pruneWarnOnly({ roots, apply = false, allowChanged = false, confirmBatch }) {
  const copies = naiveCopies(roots)
  if (!apply) return { plan: {}, items: [], exitCode: 0 }
  const fresh = (c) => computePathTreeHash(c.copyPath)
  const items = []
  const yes = typeof confirmBatch === 'function' && confirmBatch(copies, '') === true
  for (const c of copies) {
    const sc = readJsonOrNull(c.sidecarPath)
    const clean = sc && sc.postMoveTreeHash && fresh(c).treeHash === sc.postMoveTreeHash
    if (!clean)
      console.warn(
        `warning: ${c.copyPath} is not clean${allowChanged ? '' : ' (pass --allow-changed)'}`
      )
    if (yes && (clean || allowChanged)) {
      rmCopy(c)
      items.push(removedItem(c))
    }
  }
  return { plan: {}, items, exitCode: 0 }
}

/** apply-ignored (T7, R1 negative control): deletes even when apply is false. */
export function applyIgnored({ roots }) {
  const copies = naiveCopies(roots)
  for (const c of copies) rmCopy(c)
  return { plan: { count: copies.length }, items: copies.map(removedItem), exitCode: 0 }
}

/** prune-resume-blind (T17, P5 control): staging leftovers are deleted at listing, unasked. */
export function pruneResumeBlind({ roots }) {
  const gone = []
  for (const root of roots) {
    const trash = path.join(root, '.skillsmith-trash')
    let names = []
    try {
      names = fs.readdirSync(trash)
    } catch {
      continue
    }
    for (const n of names.filter((x) => x.startsWith('.prune-'))) {
      fs.rmSync(path.join(trash, n), { recursive: true, force: true })
      gone.push(n)
    }
  }
  return { plan: { leftoversDeleted: gone }, items: [], exitCode: 0 }
}

// ---------------------------------------------------------------------------
// Walker FUNCTION STUBS: run by harness/w5-walker-stub.mjs in the walker child.
// ---------------------------------------------------------------------------

const stubOut = (job, status, reason, detail = null) => ({
  status,
  reason,
  path: job.copyPath,
  entry: job.leaf,
  detail,
  misplaced: null,
  walkerPid: process.pid,
})

/** prune-in-place (T11, P3 control): verify and delete AT THE TRASH PATH; no staging. */
function pruneInPlace(job) {
  const h = computePathTreeHash(job.copyPath)
  if (!h.ok || h.treeHash !== job.approvedHash)
    return stubOut(job, 'kept', 'class-worsened', 'in-place hash differs')
  fs.rmSync(job.copyPath, { recursive: true, force: true })
  if (job.sidecarPath) fs.rmSync(job.sidecarPath, { force: true })
  return stubOut(job, 'removed', null)
}

/** prune-follow (T14, P7 control): deletes recursively, FOLLOWING symlinks. */
function pruneFollow(job) {
  const del = (p) => {
    let st
    try {
      st = fs.statSync(p) // FOLLOWS a symlink: the defect this stub stands for
    } catch {
      st = fs.lstatSync(p) // a dangling link is deleted as itself
    }
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(p)) del(path.join(p, n))
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p)
      else fs.rmdirSync(p)
    } else fs.unlinkSync(p)
  }
  try {
    del(job.copyPath)
  } catch (err) {
    return stubOut(job, 'stopped', 'delete-failed', String(err.code))
  }
  return stubOut(job, 'removed', null)
}

/** prune-c0 (T18, P1 control): D-2's C0 walk -- in place, guarded by st_dev only. */
function pruneC0(job) {
  if (!computePathTreeHash(job.copyPath).ok) return stubOut(job, 'kept', 'unreadable')
  fs.writeFileSync(path.join(job.opDir, 'deleting'), 'c0')
  const rootDev = fs.lstatSync(job.copyPath).dev
  let skipped = 0
  const del = (p) => {
    const st = fs.lstatSync(p)
    if (st.dev !== rootDev) {
      skipped += 1
      return
    }
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(p)) del(path.join(p, n))
      try {
        fs.rmdirSync(p)
      } catch {
        /* a skipped mount below keeps it */
      }
    } else fs.unlinkSync(p)
  }
  del(job.copyPath)
  try {
    fs.unlinkSync(path.join(job.opDir, 'deleting'))
  } catch {
    /* */
  }
  return stubOut(job, skipped > 0 ? 'stopped' : 'removed', skipped > 0 ? 'mount-skipped' : null)
}

export const WALKER_STUBS = {
  'prune-in-place': pruneInPlace,
  'prune-follow': pruneFollow,
  'prune-c0': pruneC0,
}

export * from './w5-mutants.source.mjs'
export * from './w5-mutants.rows.mjs'
