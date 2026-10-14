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

// ---------------------------------------------------------------------------
// SOURCE MUTANTS of prune.walk.mjs / prune.mjs (applied by w5-variant.mjs).
// ---------------------------------------------------------------------------

const W = 'prune.walk.mjs'
const SIDECAR_BYTES_CMP = {
  find: 'if (rs.ino !== sidecar.ino || !rs.bytes.equals(sidecar.bytes)) {',
  replace:
    'if (rs.ino !== sidecar.ino || BigInt(rs.bytes.length) !== BigInt(sidecar.bytes.length)) {',
}
const SIDECAR_UNLINK_BY_INO = {
  find: "    if (sc) deleteLeaf('sidecar.json', SIDECAR_KEY, sc, sIdentity)",
  replace:
    "    if (sc) { const s0 = fs.lstatSync('sidecar.json', { bigint: true }); " +
    "if (s0.ino !== sc.ino || s0.size !== sc.size) throw stop('changed-during-delete', 'sidecar'); " +
    "fs.unlinkSync('sidecar.json'); deleted += 1 }",
}
const MISPLACE_RESULT = {
  find: '      misplaced: [{ path: abs, originalRel, cause }],',
  replace: '      misplaced: null,',
}
const MISPLACE_REVERT = {
  find: "  const misplaced = (r, originalRel, curWant) => {\n    let cause = 'cwd-covered'",
  replace:
    "  const misplaced = (r, originalRel, curWant) => {\n    if (originalRel !== SIDECAR_KEY) { try { fs.renameSync(r, originalRel.split('/').pop()) } catch { /* */ } }\n    let cause = 'cwd-covered'",
}

export const WALKER_MUTANTS = {
  'sidecar-same-inode-rewrite': {
    name: 'sidecar-same-inode-rewrite',
    file: W,
    edits: [SIDECAR_BYTES_CMP, SIDECAR_UNLINK_BY_INO],
  },
  'mkdir-eexist-ok': {
    name: 'mkdir-eexist-ok',
    file: W,
    edits: [
      {
        find: "    } catch (err) {\n      return out({ status: 'kept', reason: 'staging-unusable', detail: `mkdir ${S}: ${err.code}` })",
        replace:
          "    } catch (err) {\n      if (err.code !== 'EEXIST') return out({ status: 'kept', reason: 'staging-unusable', detail: `mkdir ${S}: ${err.code}` })",
      },
      { find: ': (sd.mode & 0o077n) !== 0n ? `mode', replace: ': false ? `mode' },
    ],
  },
  'stage-fallback-rm': {
    name: 'stage-fallback-rm',
    file: W,
    edits: [
      {
        find: "      try {\n        fs.unlinkSync(path.join(S, 'intent.json'))\n        fs.rmdirSync(S)",
        replace:
          "      fs.rmSync(job.copyPath, { recursive: true, force: true })\n      try {\n        fs.unlinkSync(path.join(S, 'intent.json'))\n        fs.rmdirSync(S)",
      },
    ],
  },
  'walk-no-meta-check': {
    name: 'walk-no-meta-check',
    file: W,
    edits: [
      {
        find: "  w && w.type !== 'dir' && w.dev === s.dev && w.ino === s.ino && w.type === typeOf(s) &&\n  w.mode === s.mode && w.size === s.size && w.mtimeNs === s.mtimeNs",
        replace:
          "  w && w.type !== 'dir' && w.dev === s.dev && w.ino === s.ino && w.type === typeOf(s)",
      },
      {
        find: 'const sameLeafPre = (w, s) => sameLeafPost(w, s) && w.ctimeNs === s.ctimeNs',
        replace: 'const sameLeafPre = (w, s) => sameLeafPost(w, s)',
      },
    ],
  },
  'walk-delete-unknown': {
    name: 'walk-delete-unknown',
    file: W,
    edits: [
      {
        find: "      if (!want) throw stop('entry-added-during-delete', `${crel} was not in the verified inventory`)",
        replace: '      if (!want) { fs.rmSync(n, { recursive: true, force: true }); continue }',
      },
    ],
  },
  'misplace-silent': {
    name: 'misplace-silent',
    file: W,
    edits: [
      {
        find: 'throw misplaced(r, crel, curWant)',
        replace: "throw stop('changed-during-delete', crel)",
        all: true,
      },
    ],
  },
  'misplace-revert': { name: 'misplace-revert', file: W, edits: [MISPLACE_REVERT] },
}

/** M1-M8 (design §7): mutations for behaviour that cannot be red first. */
export const MUTATIONS = {
  M1: {
    name: 'M1',
    file: W,
    test: 'T14',
    edits: [
      {
        find: '      process.chdir(r)\n      segs.push(r)\n      cwdIs(want, crel)\n',
        replace: '      process.chdir(r)\n      segs.push(r)\n',
      },
    ],
  },
  M2: {
    name: 'M2',
    file: W,
    test: 'T13-by-name',
    edits: [
      {
        find: '    try {\n      fs.unlinkSync(r)\n    } catch (err) {',
        replace: '    try {\n      fs.unlinkSync(n)\n    } catch (err) {',
      },
    ],
  },
  M3: {
    name: 'M3',
    file: W,
    test: 'clean-run',
    edits: [
      {
        find: 'if (!sameLeafPost(want, fs.lstatSync(r, { bigint: true }))) throw misplaced',
        replace: 'if (!sameLeafPre(want, fs.lstatSync(r, { bigint: true }))) throw misplaced',
      },
    ],
  },
  M4: {
    name: 'M4',
    file: 'prune.mjs',
    test: 'guard',
    edits: [
      {
        find: "import { encodeJob } from './prune.job.mjs'",
        replace:
          "import { encodeJob } from './prune.job.mjs'\nimport { stageVerifyDelete as inProc } from './prune.walk.mjs'",
      },
      {
        find: '  const args = [...(walker.execArgv ?? []), walker.path ?? DEFAULT_WALKER]',
        replace:
          "  if (!walker.path) { process.env.SKILLSMITH_PRUNE_WALKER = '1'; return JSON.parse(JSON.stringify(inProc(job), (k, v) => (typeof v === 'bigint' ? String(v) : v))) }\n  const args = [...(walker.execArgv ?? []), walker.path ?? DEFAULT_WALKER]",
      },
    ],
  },
  M5: {
    name: 'M5',
    file: W,
    test: 'P1-pre-verify (linux bind)',
    edits: [
      {
        find: "  const mi = mountFinding(leafPath)\n  if (mi !== null) return no('mount-in-staging', mi)\n",
        replace: '',
      },
    ],
  },
  M6: { name: 'M6', file: W, test: 'T10', edits: [SIDECAR_BYTES_CMP] },
  M7: { name: 'M7', file: W, test: 'T15', edits: [MISPLACE_RESULT] },
  M8: { name: 'M8', file: W, test: 'P9-trace', edits: [MISPLACE_REVERT] },
}

export * from './w5-mutants.rows.mjs'
