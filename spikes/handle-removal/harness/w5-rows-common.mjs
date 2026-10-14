// SMI-7123 Wave 5: helpers shared by the w5-rows-*.mjs row modules.
//
// Every run returns one RAW record:
//   {precondition:{hookFired, mutationApplied}, outcome:{status, reason, path, entry, errno},
//    userFiles:{checked, lost, changed}, fsCheck:{ok, failures:string[]}, variant}
// A false precondition makes the run never-ran (the fixture or the timing did
// not happen); a non-empty `failures` makes it failed (W5_CONTRADICTS). Bytes
// lost/changed are counted where the row measures user bytes.
import fs from 'node:fs'
import path from 'node:path'
import {
  run as sh,
  PLATFORM,
  makeImage,
  attachImage,
  detachUnder,
  noImageAttachedUnder,
} from './w5-mounts.mjs'
import { rmFixture } from './w5-test-util.mjs'
import { walkerOpts, readTrace } from './w5-variant.mjs'

export const W5_CONTRADICTS = (rec) => rec.fsCheck?.ok === false

export function raw({
  hookFired = true,
  mutationApplied = true,
  item = {},
  checked = 0,
  lost = 0,
  changed = 0,
  failures = [],
  variant = null,
  extra = {},
}) {
  return {
    precondition: { hookFired, mutationApplied },
    outcome: {
      status: item.status ?? 'kept',
      reason: item.reason ?? null,
      path: item.path ?? null,
      entry: item.entry ?? null,
      errno: item.errno ?? null,
    },
    userFiles: { checked, lost, changed },
    fsCheck: { ok: failures.length === 0, failures },
    variant,
    extra,
  }
}

/** A never-ran record with the reason it could not run here. */
export const neverRan = (variant, why) =>
  raw({ hookFired: false, mutationApplied: false, variant, failures: [], extra: { neverRan: why } })

export const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${err.code}`
  }
}
export const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
export const exists = (p) => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}
export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const yes = () => true

/** A second filesystem under `f.root` (darwin: an hdiutil volume; linux: tmpfs). */
export function otherFs(f) {
  const mp = path.join(f.root, 'otherfs')
  fs.mkdirSync(mp)
  if (PLATFORM === 'darwin') attachImage(makeImage(f.root, {}, f), mp, f)
  else sh('mount', ['-t', 'tmpfs', '-o', 'size=16m', 'none', mp])
  return mp
}

/** Detaches every mount under the fixture and removes it; returns cleanup failures. */
export function finishFixture(f) {
  const fails = []
  const left = detachUnder(fs.realpathSync(f.root), f)
  if (left.length) fails.push(`could not detach ${left.join(',')}`)
  if (!noImageAttachedUnder(f.root)) fails.push('a disk image is still attached')
  if (left.length === 0) rmFixture(f.root)
  return fails
}

/** Counts destructive fs calls made in THIS process while fn runs. */
export function countDestructive(fn) {
  const D = ['unlinkSync', 'rmdirSync', 'rmSync']
  const orig = new Map(D.map((n) => [n, fs[n]]))
  let n = 0
  let out
  for (const k of D)
    fs[k] = function counted(...a) {
      n += 1
      return orig.get(k).apply(this, a)
    }
  try {
    out = fn()
  } finally {
    for (const k of D) fs[k] = orig.get(k)
  }
  return { n, out }
}

/** Counts write-class fs calls made in THIS process while fn runs. */
export function countWrites(fn) {
  const W = [
    'writeFileSync',
    'appendFileSync',
    'mkdirSync',
    'renameSync',
    'unlinkSync',
    'rmdirSync',
    'rmSync',
    'symlinkSync',
    'chmodSync',
    'writeSync',
    'copyFileSync',
    'truncateSync',
    'mkdtempSync',
  ]
  const orig = new Map(W.map((n) => [n, fs[n]]))
  let n = 0
  let out
  for (const k of W)
    fs[k] = function counted(...a) {
      n += 1
      return orig.get(k).apply(this, a)
    }
  try {
    out = fn()
  } finally {
    for (const k of W) fs[k] = orig.get(k)
  }
  return { n, out }
}

/**
 * One prune of every copy under f.parent. `impl` = {prune, stub?, walkerPath?}
 * from loadImpl. Returns {r, item, t (trace or null)}.
 */
export function prunePass(
  impl,
  f,
  { hooks = [], extraFds = [], allowChanged = false, confirmItem = yes, confirmBatch = yes } = {}
) {
  const traceFile = path.join(f.root, `trace-${Math.random().toString(16).slice(2)}.json`)
  const walker =
    impl.stub || impl.walkerPath || hooks.length || extraFds.length
      ? walkerOpts({ stub: impl.stub, walkerPath: impl.walkerPath, hooks, traceFile, extraFds })
      : {}
  let r
  try {
    r = impl.prune({
      roots: [f.parent],
      apply: true,
      allowChanged,
      isTTY: true,
      confirmBatch,
      confirmItem,
      walker,
    })
  } catch (err) {
    r = {
      items: [{ status: 'stopped', reason: 'impl-threw', detail: String(err.message) }],
      plan: {},
      exitCode: 4,
    }
  }
  return { r, item: r.items[0] ?? {}, t: readTrace(traceFile) }
}

export const fired = (t, kind) => (t?.fired ?? []).some((x) => x.kind === kind && !x.hookError)

/** Finds a regular file by inode anywhere under root. */
export function findIno(root, ino) {
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const n of names) {
    const p = path.join(root, n)
    const st = fs.lstatSync(p)
    if (st.isFile() && st.ino === ino) return p
    if (st.isDirectory()) {
      const r = findIno(p, ino)
      if (r) return r
    }
  }
  return null
}

/**
 * "Every mount-source path unchanged or named in misplaced[]": each source file
 * must read its original bytes at its original path, or sit (same bytes) under
 * a path the result named in `misplaced`.
 */
export function sourcesAccounted(sources, misplaced) {
  const fails = []
  const named = (misplaced ?? []).map((m) => m.path)
  for (const [p, bytes] of Object.entries(sources)) {
    if (read(p) === bytes) continue
    const hit = named.some((m) => {
      const candidates = [m, path.join(m, path.basename(p))]
      return candidates.some((c) => read(c) === bytes)
    })
    if (!hit) fails.push(`mount source ${p} neither unchanged nor named in misplaced[]`)
  }
  return fails
}
