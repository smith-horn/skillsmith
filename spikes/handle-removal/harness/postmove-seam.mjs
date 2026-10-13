// SMI-6715 Step 1b (C4 repair, design §8): a local seam for the post-move tests.
//
// runC4Candidate (attacks/c4-shared.mjs) fires only at root lstat #3 or at the
// root rename. Several §8 tests need a hook AFTER the root rename returns --
// the first destination-scoped call, which on the repaired code is S9's lstat
// of destPath -- so this module interposes on the same `node:fs` default
// export object, the same way, and adds that hook. It also records every call
// whose path (or second path) is the origin, inside it, or inside this run's
// trash op directory, so a test can assert what happened at the origin after
// the rename.
//
// Hooks run UNRECORDED (their own fs calls are not in the trace), exactly like
// runC4Candidate's onFire.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SYNC_FNS = Object.freeze(
  Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function')
)
const PRISTINE = new Map(SYNC_FNS.map((n) => [n, fs[n]]))
const TWO_PATH = new Set(['renameSync', 'linkSync', 'copyFileSync', 'cpSync'])

const asPath = (p) =>
  typeof p === 'string'
    ? p
    : Buffer.isBuffer(p)
      ? p.toString('utf8')
      : p instanceof URL
        ? p.pathname
        : null

const inside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Synchronous sleep without a busy loop. */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Spins (sleeping) until `pred()` is true or `timeoutMs` elapses. Returns pred()'s last value. */
export function waitUntil(pred, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) return false
    sleepMs(5)
  }
  return true
}

/**
 * parent/tree/{target/orig-f1 (0644), top.txt, link -> orig-link-target}.
 * Returns the paths. `root` is the throwaway directory to remove afterwards.
 */
export function buildFixture(prefix = 's6715-pm-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const parent = path.join(root, 'parent')
  const origin = path.join(parent, 'tree')
  populate(origin)
  return { root, parent, origin, name: 'tree', target: path.join(origin, 'target') }
}

/**
 * Builds the fixture tree's content at `dir`. Calling it twice yields two
 * hash-IDENTICAL trees (fs.cpSync does not: it rewrites a relative symlink to
 * an absolute one, measured).
 */
export function populate(dir) {
  fs.mkdirSync(path.join(dir, 'target'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'target', 'orig-f1'), 'original-content-f1')
  fs.chmodSync(path.join(dir, 'target', 'orig-f1'), 0o644)
  fs.writeFileSync(path.join(dir, 'top.txt'), 'top-bytes')
  fs.symlinkSync('orig-link-target', path.join(dir, 'link'))
}

/** Best-effort recursive removal that first restores permissions a test removed. */
export function cleanup(root) {
  const fix = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    try {
      fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600)
    } catch {
      /* best effort */
    }
    if (st.isDirectory()) {
      let names = []
      try {
        names = fs.readdirSync(p)
      } catch {
        /* best effort */
      }
      for (const n of names) fix(path.join(p, n))
    }
  }
  fix(root)
  fs.rmSync(root, { recursive: true, force: true })
}

/**
 * Runs `quarantine(parentAbs, name, options)` with fs interposed.
 *
 * - onRecheck(): at the 3rd root lstat of originPath (C4's pre-rename re-check),
 *   before it executes -- the same moment as runC4Candidate's 'post-hash'.
 * - onRename(): at the root renameSync, before it executes ('at-rename').
 * - onAfterRename({destPath}): once, before the first call scoped to the op
 *   directory after the root rename RETURNED.
 * - onCall({fn, p0, scope, renameReturned, destPath}): before EVERY scoped call
 *   (after the hooks above), unrecorded; for tests that time on a specific call.
 *
 * Returns {result, trace, renameIdx, fired:{recheck, rename, afterRename}, hookErrors}.
 * Trace entries: {fn, p0, p1, scope, scope2}; scope is 'origin'|'desc'|'dest'|null.
 */
export function runWithHooks({
  quarantine,
  parentAbs,
  name,
  options,
  onRecheck,
  onRename,
  onAfterRename,
  onCall,
}) {
  const originPath = path.resolve(parentAbs, name)
  if (typeof options?.opId !== 'string')
    throw new TypeError('runWithHooks: options.opId is required')
  const opDir = path.resolve(parentAbs, '.skillsmith-trash', options.opId)
  const scopeOf = (p) => {
    const s = asPath(p)
    if (s === null) return null
    const abs = path.resolve(s)
    if (abs === originPath) return 'origin'
    if (inside(abs, originPath)) return 'desc'
    if (inside(abs, opDir)) return 'dest'
    return null
  }
  const trace = []
  const fired = { recheck: false, rename: false, afterRename: false }
  const hookErrors = []
  let recording = false
  let inHook = false
  let rootLstats = 0
  let renameReturned = false
  let destPath = null
  const runHook = (key, fn, arg) => {
    if (fired[key] || typeof fn !== 'function') return
    fired[key] = true
    inHook = true
    try {
      fn(arg)
    } catch (err) {
      hookErrors.push({ key, message: String(err?.message ?? err) })
    } finally {
      inHook = false
    }
  }
  for (const n of SYNC_FNS) {
    if (fs[n] !== PRISTINE.get(n)) throw new Error(`runWithHooks: fs.${n} already interposed`)
  }
  for (const n of SYNC_FNS) {
    const orig = PRISTINE.get(n)
    fs[n] = function seam(...args) {
      if (!recording || inHook) return orig.apply(this, args)
      const scope = scopeOf(args[0])
      const scope2 = TWO_PATH.has(n) ? scopeOf(args[1]) : null
      if (scope === null && scope2 === null) return orig.apply(this, args)
      if (n === 'lstatSync' && scope === 'origin' && ++rootLstats === 3)
        runHook('recheck', onRecheck)
      const rootRename = n === 'renameSync' && scope === 'origin'
      if (rootRename) runHook('rename', onRename)
      if (renameReturned && (scope === 'dest' || scope2 === 'dest')) {
        runHook('afterRename', onAfterRename, { destPath })
      }
      if (typeof onCall === 'function') {
        inHook = true
        try {
          onCall({ fn: n, p0: asPath(args[0]), scope, renameReturned, destPath })
        } catch (err) {
          hookErrors.push({ key: 'onCall', message: String(err?.message ?? err) })
        } finally {
          inHook = false
        }
      }
      trace.push({
        fn: n,
        p0: asPath(args[0]) === null ? null : path.resolve(asPath(args[0])),
        p1: TWO_PATH.has(n) && asPath(args[1]) !== null ? path.resolve(asPath(args[1])) : null,
        scope,
        scope2,
      })
      const out = orig.apply(this, args)
      if (rootRename && !renameReturned) {
        renameReturned = true
        destPath = path.resolve(asPath(args[1]))
      }
      return out
    }
  }
  let result
  try {
    recording = true
    result = quarantine(parentAbs, name, options)
  } finally {
    recording = false
    for (const n of SYNC_FNS) fs[n] = PRISTINE.get(n)
  }
  const renameIdx = trace.findIndex((e) => e.fn === 'renameSync' && e.scope === 'origin')
  return { result, trace, renameIdx, fired, hookErrors, originPath, opDir }
}

/** Reads and parses a JSON file, or returns a string naming why it could not. */
export function readJson(p) {
  if (typeof p !== 'string') return `NO-PATH:${String(p)}`
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    return `UNREADABLE:${err.code ?? err.message}`
  }
}

/** Reads a file as UTF-8, or returns `UNREADABLE:<code>`. */
export function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${err.code ?? err.message}`
  }
}
