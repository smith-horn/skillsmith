// SMI-6715: trace constants, scope classification and the trace matcher for
// C4 runs. Split out of c4-shared.mjs (file-length limit); c4-shared re-exports
// FIRE, expectedTrace and matchC4Trace, so callers import from there.
//
// WHAT A MATCH VERIFIES -- exactly this, no more (R1-F7, GPT-5.6-Sol round 1):
//
//  ROOT SKELETON. Top-level calls whose path IS the tree root, in order, against
//  one declared sequence per arm (measured: scratchpad measure-c4-sequence.mjs,
//  darwin, node v22.22.2):
//    C4       lstat (bind), lstat + readdir (hash root), lstat (re-check), rename
//    C4-naive rename
//
//  PHASES, for everything else C4 does to the root SUBTREE or the trash
//  DESTINATION (paths strictly inside <parent>/.skillsmith-trash/<opId>; the op
//  directory itself and the trash root are validated by quarantine.mjs before
//  the rename and are not constrained here). Descendant calls are NOT matched
//  as a sequence -- their order depends on the fixture -- only as phases:
//    (a) no descendant or destination call before the bind lstat;
//    (b) descendant calls are hash READS (lstat, readdir, readlink, readFile,
//        read-only open) and occur only between the root readdir and the
//        re-check lstat;
//    (c) after the re-check, the only root-or-descendant call is the rename;
//    (d) destination calls occur only after a rename that returned.
//  (a) and (b)'s upper bound are enforced THROUGH (b)'s lower bound, (c) and
//  (d) rather than by lines of their own; see matchPhases.
//  C4-naive has no bind, hash or re-check: its only root-side call is the rename.
//
//  BOUNDARY (R2-8 / X7b). Tracing is interposition on the `node:fs` DEFAULT
//  export object, so it only sees calls that look a method up on that object at
//  call time. "Every call C4 makes" therefore means every call made through
//  that object. It holds only while quarantine.mjs and every module it imports
//  relatively (today hash.mjs and result-shape.mjs) import fs as a default
//  export only, with no named or namespace fs import, no fs/promises, no
//  require/createRequire/dynamic import of fs, and no captured fs method or
//  alias. ./c4-fs-boundary.mjs checks exactly that by parsing those files, and
//  c4-fs-boundary.selftest.mjs fails if it stops holding.
//
//  It does NOT verify the hash's per-entry traversal order, calls on paths
//  outside the root and destination, or anything the mutation itself does
//  (calls made inside onFire are deliberately untraced).

import path from 'node:path'

export const FIRE = 'FIRE'

/** Declared ROOT call sequence for an unattacked run, per arm (measured, above). */
const EXPECTED_CALLS = Object.freeze({
  C4: Object.freeze(['lstatSync', 'lstatSync', 'readdirSync', 'lstatSync', 'renameSync']),
  'C4-naive': Object.freeze(['renameSync']),
})

/** Root calls preceding FIRE, per arm and EFFECTIVE window. */
const FIRE_INDEX = Object.freeze({
  C4: Object.freeze({ 'pre-call': 0, 'after-bind': 1, 'post-hash': 3, 'at-rename': 4 }),
  'C4-naive': Object.freeze({ 'pre-call': 0, 'at-rename': 0 }),
})

/** Ordinal (1-based) of the root lstat that is C4's pre-rename re-check. */
export const C4_RECHECK_LSTAT_ORDINAL = 3

/** Functions whose SECOND argument is also a path this module scopes. */
const TWO_PATH_FNS = new Set(['renameSync', 'linkSync', 'copyFileSync', 'cpSync'])
/** symlinkSync(target, path): the first argument is link text, not a path acted on. */
const LINK_PATH_SECOND = new Set(['symlinkSync'])
const DESC_READS = new Set(['lstatSync', 'readdirSync', 'readlinkSync', 'readFileSync'])
const SCOPES = new Set(['origin', 'desc', 'dest'])

/** C4-naive has no bind/hash/re-check; those windows land at the rename. */
export function effectiveWindow(candidate, window) {
  if (candidate === 'C4-naive' && (window === 'after-bind' || window === 'post-hash')) {
    return 'at-rename'
  }
  return window
}

/** The full expected ROOT trace (fn names) including the FIRE marker. */
export function expectedTrace(candidate, window) {
  const eff = effectiveWindow(candidate, window)
  const calls = EXPECTED_CALLS[candidate]
  const idx = FIRE_INDEX[candidate]?.[eff]
  if (!calls || idx === undefined) {
    throw new TypeError(`expectedTrace: no sequence for ${candidate}/${window}`)
  }
  return [...calls.slice(0, idx), FIRE, ...calls.slice(idx)]
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Returns `scopesOf(fnName, args) -> {scope, scope2}` for one run: 'origin'
 * (the root itself), 'desc' (inside the root), 'dest' (inside destDir), or null.
 */
export function makeScoper(originPath, destDir) {
  const one = (p) => {
    if (typeof p !== 'string') return null
    const abs = path.resolve(p)
    if (abs === originPath) return 'origin'
    if (isInside(abs, originPath)) return 'desc'
    if (isInside(abs, destDir)) return 'dest'
    return null
  }
  return (fn, args) => {
    if (LINK_PATH_SECOND.has(fn)) return { scope: one(args[1]), scope2: null }
    return { scope: one(args[0]), scope2: TWO_PATH_FNS.has(fn) ? one(args[1]) : null }
  }
}

const isRootCall = (e, fn) => e.fn === fn && e.scope === 'origin' && e.nested !== true
const isDescRead = (e) =>
  e.scope === 'desc' &&
  e.scope2 === null &&
  (DESC_READS.has(e.fn) ||
    (e.fn === 'openSync' && (e.flags === undefined || e.flags === 'r' || e.flags === 0)))

/** Rules 1-7: the root skeleton. See c4-shared.mjs's history for each rule's origin. */
function matchRootSkeleton(candidate, window, rootTrace, result, callStartAt) {
  let full
  try {
    full = expectedTrace(candidate, window)
  } catch {
    return false
  }
  const names = rootTrace.map((e) => e.fn)
  if (names.length === 0 || names.length > full.length) return false
  for (let i = 0; i < names.length; i++) if (names[i] !== full[i]) return false
  const fireAt = names.indexOf(FIRE)
  if (fireAt === -1 || names[names.length - 1] === FIRE) return false
  const fireTime = rootTrace[fireAt].at
  const eff = effectiveWindow(candidate, window)
  if (eff === 'pre-call') {
    if (!(fireTime < callStartAt)) return false
  } else if (!(fireTime >= callStartAt)) return false

  // POSITION INVARIANT (Ci-b), read from the observed trace only, so FIRE_INDEX
  // and C4_RECHECK_LSTAT_ORDINAL cannot drift together unnoticed.
  const next = names[fireAt + 1]
  if (eff === 'pre-call') {
    if (fireAt !== 0) return false
  } else if (eff === 'after-bind') {
    if (fireAt !== 1 || names[0] !== 'lstatSync' || next !== 'lstatSync') return false
  } else if (eff === 'post-hash') {
    const readdirAt = names.indexOf('readdirSync')
    if (readdirAt === -1 || readdirAt > fireAt || next !== 'lstatSync') return false
    if (names.slice(fireAt + 2).includes('lstatSync')) return false
  } else if (eff === 'at-rename') {
    if (next !== 'renameSync') return false
  } else {
    return false
  }

  const last = rootTrace[rootTrace.length - 1]
  const status = result?.status
  if (status === 'quarantined') {
    if (names.length !== full.length || last.threw !== null) return false
    if (last.fn !== 'renameSync' || typeof result.path !== 'string') return false
    return path.resolve(String(last.dest)) === path.resolve(result.path)
  }
  if (status === 'kept' || status === 'stopped') {
    return names.length < full.length || last.threw !== null
  }
  return false
}

/** Phase invariants (a)-(d) over the whole scoped trace. */
function matchPhases(candidate, trace) {
  const renameIdx = trace.findIndex((e) => isRootCall(e, 'renameSync'))
  const originSide = (e) =>
    e.scope === 'origin' || e.scope === 'desc' || e.scope2 === 'origin' || e.scope2 === 'desc'
  const isDesc = (e) => e.scope === 'desc' || e.scope2 === 'desc'
  const isDest = (e, i) => e.scope === 'dest' || (e.scope2 === 'dest' && i !== renameIdx)

  if (candidate === 'C4') {
    const rootLstats = []
    trace.forEach((e, i) => isRootCall(e, 'lstatSync') && rootLstats.push(i))
    const readdirIdx = trace.findIndex((e) => isRootCall(e, 'readdirSync'))
    const recheckIdx = rootLstats.length >= 3 ? rootLstats[2] : -1
    // (a) has no line of its own on purpose: the skeleton puts the bind before
    // the root readdir, so (b)'s lower bound already excludes a descendant call
    // before the bind, and (d) excludes a destination call before the rename.
    // A separate check was redundant, and no mutation of it could turn a test
    // red. Likewise (b)'s upper bound is (c): after the re-check nothing on the
    // origin side but the rename.
    for (let i = 0; i < trace.length; i++) {
      const e = trace[i]
      if (e.fn === FIRE) continue
      // (b)
      if (isDesc(e) && (!isDescRead(e) || readdirIdx === -1 || i < readdirIdx)) return false
      // (c)
      if (recheckIdx !== -1 && i > recheckIdx && originSide(e) && i !== renameIdx) return false
    }
  } else {
    for (let i = 0; i < trace.length; i++) {
      const e = trace[i]
      if (e.fn !== FIRE && originSide(e) && i !== renameIdx) return false
    }
  }
  // (d)
  for (let i = 0; i < trace.length; i++) {
    if (trace[i].fn === FIRE || !isDest(trace[i], i)) continue
    if (renameIdx === -1 || i < renameIdx || trace[renameIdx].threw !== null) return false
  }
  return true
}

/**
 * True only when the trace is provably one of the shapes in the header:
 * interposition intact, every entry scoped, timestamps non-decreasing, only the
 * last TOP-LEVEL call may have thrown (a call nested inside another, e.g. the
 * openSync inside readFileSync, throws together with it), the root skeleton
 * matches with an outcome-consistent stop, and phases (a)-(d) hold.
 */
export function matchC4Trace({
  candidate,
  window,
  trace,
  result,
  callStartAt,
  interpositionIntact,
}) {
  if (interpositionIntact !== true) return false
  if (!Array.isArray(trace) || trace.length === 0) return false
  for (const e of trace) {
    if (e === null || typeof e !== 'object') return false
    if (e.fn !== FIRE && !SCOPES.has(e.scope) && !SCOPES.has(e.scope2)) return false
  }
  for (let i = 1; i < trace.length; i++) if (!(trace[i].at >= trace[i - 1].at)) return false
  const top = trace.filter((e) => e.nested !== true)
  for (let i = 0; i < top.length - 1; i++) if (top[i].threw !== null) return false
  const rootTrace = trace.filter(
    (e) => e.fn === FIRE || (e.scope === 'origin' && e.nested !== true)
  )
  if (!matchRootSkeleton(candidate, window, rootTrace, result, callStartAt)) return false
  return matchPhases(candidate, trace)
}
