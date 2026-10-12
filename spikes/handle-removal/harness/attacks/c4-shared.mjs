// SMI-6715 milestone 1: shared driver for every C4 attack module.
//
// Runs one arm of C4 (`quarantineTree` from quarantine.mjs) with a mutation
// injected at a named window, by INTERPOSING on the shared `node:fs` default
// export (owner decision 3: quarantine.mjs is not modified; precedent is
// `injectFsErrnoOnce` in ./_shared.mjs). quarantine.mjs does
// `import fs from 'node:fs'` and calls `fs.lstatSync(...)` etc. at call time,
// so reassigning a property on that object is visible to it.
//
// THIS IS EVIDENCE-TRANSFORMING CODE. Every C4 verdict passes through it, so it
// is built to fail closed: a trace it cannot match yields traceMatched:false
// (and therefore hookFired:false), never a pass.
//
// MEASURED SEQUENCES (scratchpad measure-c4-sequence.mjs, darwin, node
// v22.22.2, 3 runs per arm, buildSwapFixture, every own `*Sync` function on
// the fs default export wrapped -- 43 of them -- so an unexpected touch of
// originPath would have appeared):
//   C4       (guardHash passed): lstatSync, lstatSync, readdirSync, lstatSync, renameSync
//   C4-naive (no guardHash):     renameSync
// The C4 lstats are, in order: bindIdentity (bind), pathTreeRecord's root
// visit (hash), bindIdentity (pre-rename re-check). Nothing else touches
// originPath; treeBytes() and the sidecar touch destPath, not originPath.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { quarantineTree, computePathTreeHash } from '../../quarantine.mjs'
import { assertPathSegment } from '../../result-shape.mjs'

export const C4_CANDIDATES = Object.freeze(['C4', 'C4-naive'])
export const C4_WINDOWS = Object.freeze(['pre-call', 'after-bind', 'post-hash', 'at-rename'])

/** The marker this module inserts into the trace at the moment onFire runs. */
export const FIRE = 'FIRE'

/** Declared originPath call sequence for an UNATTACKED run, per arm (measured, above). */
const EXPECTED_CALLS = Object.freeze({
  C4: Object.freeze(['lstatSync', 'lstatSync', 'readdirSync', 'lstatSync', 'renameSync']),
  'C4-naive': Object.freeze(['renameSync']),
})

/**
 * Number of traced calls that precede the FIRE marker, per arm and EFFECTIVE
 * window. C4-naive has no bind, hash or re-check, so 'after-bind' and
 * 'post-hash' map to 'at-rename' (see effectiveWindow) and never appear here.
 */
const FIRE_INDEX = Object.freeze({
  C4: Object.freeze({ 'pre-call': 0, 'after-bind': 1, 'post-hash': 3, 'at-rename': 4 }),
  'C4-naive': Object.freeze({ 'pre-call': 0, 'at-rename': 0 }),
})

/** Ordinal (1-based) of lstatSync(originPath) that is C4's pre-rename re-check. */
const C4_RECHECK_LSTAT_ORDINAL = 3

/**
 * Every own function-valued `*Sync` property of the fs default export, captured
 * at module load. All of them are wrapped during a run so an unexpected touch of
 * originPath through ANY of them lands in the trace and breaks the match. Only
 * lstatSync and renameSync carry fire logic.
 */
const TRACED_FNS = Object.freeze(
  Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function')
)
const PRISTINE = new Map(TRACED_FNS.map((n) => [n, fs[n]]))

const now = () => performance.timeOrigin + performance.now()

/** C4-naive has no bind/hash/re-check; those windows land at the rename. */
function effectiveWindow(candidate, window) {
  if (candidate === 'C4-naive' && (window === 'after-bind' || window === 'post-hash')) {
    return 'at-rename'
  }
  return window
}

/** The full expected trace (fn names) including the FIRE marker. */
export function expectedTrace(candidate, window) {
  const eff = effectiveWindow(candidate, window)
  const calls = EXPECTED_CALLS[candidate]
  const idx = FIRE_INDEX[candidate]?.[eff]
  if (!calls || idx === undefined) {
    throw new TypeError(`expectedTrace: no sequence for ${candidate}/${window}`)
  }
  return [...calls.slice(0, idx), FIRE, ...calls.slice(idx)]
}

/**
 * TRACE MATCHING: DECLARED PREFIX + OUTCOME-CONSISTENT TERMINATION.
 *
 * A mutation can legitimately end C4 early (a swap makes the hash mismatch ->
 * `kept` after readdir; a deleted root makes the re-check lstat throw ->
 * `stopped`). Enumerating every (arm, outcome) sequence by hand would be a list
 * that silently goes stale. Instead every C4 exit is a `return` from a single
 * straight-line function, so the observed trace must be a PREFIX of the one
 * declared full sequence (FIRE included), and the place it stops must agree
 * with the result:
 *
 *   1. names is a prefix of expectedTrace(candidate, window), non-empty;
 *   2. it contains FIRE and does not END with FIRE (every window has at least
 *      one traced call after it in quarantine.mjs's code: pre-call -> bind or
 *      rename, after-bind -> hash root lstat, post-hash -> re-check, at-rename
 *      -> rename);
 *   3. a call that threw may only be the LAST entry (every throw on originPath
 *      in quarantine.mjs is caught and returned immediately);
 *   4. status 'quarantined' <=> the full sequence ran and the final rename
 *      returned, and that rename's destination is result.path;
 *      'kept'/'stopped' <=> the trace stopped early or the final call threw;
 *      any other status fails;
 *   5. timestamps are non-decreasing, FIRE for 'pre-call' precedes callStartAt
 *      and every other FIRE follows it;
 *   6. the interposed functions were still ours at the end of the call;
 *   7. FIRE's position agrees with what the window means, read from the trace
 *      alone (after-bind: right after the first lstat; post-hash: after the
 *      readdir and right before the last lstat; at-rename: right before the
 *      rename), so the placement constants cannot drift together unnoticed.
 *
 * Calls made BY onFire are deliberately not traced (they are the mutation, not
 * C4); a stray originPath touch from C4 itself, through any wrapped *Sync, is.
 *
 * Anything that is not provably one of these shapes returns false.
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
  let full
  try {
    full = expectedTrace(candidate, window)
  } catch {
    return false
  }
  const names = trace.map((e) => e.fn)
  if (names.length > full.length) return false
  for (let i = 0; i < names.length; i++) if (names[i] !== full[i]) return false
  const fireAt = names.indexOf(FIRE)
  if (fireAt === -1 || names[names.length - 1] === FIRE) return false
  for (let i = 0; i < trace.length - 1; i++) if (trace[i].threw !== null) return false
  for (let i = 1; i < trace.length; i++) if (!(trace[i].at >= trace[i - 1].at)) return false
  const fireTime = trace[fireAt].at
  const eff = effectiveWindow(candidate, window)
  if (eff === 'pre-call') {
    if (!(fireTime < callStartAt)) return false
  } else if (!(fireTime >= callStartAt)) return false

  // POSITION INVARIANT, stated from what each window MEANS rather than from
  // FIRE_INDEX / C4_RECHECK_LSTAT_ORDINAL (Ci-b). Those two constants place
  // the fire and declare where it should be; if both drifted by one together,
  // the prefix rule above would agree with the misplaced fire, and a post-hash
  // row would silently become an after-bind row (C4 flips FAIL -> PASS). These
  // checks read only the observed trace, so a coordinated drift fails here.
  const next = names[fireAt + 1]
  if (eff === 'pre-call') {
    if (fireAt !== 0) return false
  } else if (eff === 'after-bind') {
    // after the FIRST lstat (the bind) returned, before the hash root lstat.
    if (fireAt !== 1 || names[0] !== 'lstatSync' || next !== 'lstatSync') return false
  } else if (eff === 'post-hash') {
    // after the hash's readdir, immediately before the LAST lstat (the re-check).
    const readdirAt = names.indexOf('readdirSync')
    if (readdirAt === -1 || readdirAt > fireAt || next !== 'lstatSync') return false
    if (names.slice(fireAt + 2).includes('lstatSync')) return false
  } else if (eff === 'at-rename') {
    if (next !== 'renameSync') return false
  } else {
    return false
  }

  const last = trace[trace.length - 1]
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

function validateRunArgs(args) {
  if (args === null || typeof args !== 'object') {
    throw new TypeError('runC4Candidate: expected an options object')
  }
  // One read of each property, then only the locals are used.
  const { candidate, parentAbs, name, window, onFire, opId } = args
  if (typeof candidate !== 'string' || !C4_CANDIDATES.includes(candidate)) {
    throw new TypeError(
      `runC4Candidate: candidate must be one of ${C4_CANDIDATES.join(', ')} (a primitive string)`
    )
  }
  if (typeof window !== 'string' || !C4_WINDOWS.includes(window)) {
    throw new TypeError(
      `runC4Candidate: window must be one of ${C4_WINDOWS.join(', ')} (a primitive string)`
    )
  }
  if (typeof onFire !== 'function') {
    throw new TypeError('runC4Candidate: onFire must be a function')
  }
  if (typeof parentAbs !== 'string' || !path.isAbsolute(parentAbs)) {
    throw new TypeError(
      `runC4Candidate: parentAbs must be an absolute path string, got ${String(parentAbs)}`
    )
  }
  assertPathSegment('name', name)
  let resolvedOpId = opId
  if (resolvedOpId === undefined) resolvedOpId = `c4-${crypto.randomBytes(6).toString('hex')}`
  assertPathSegment('opId', resolvedOpId)
  return { candidate, parentAbs, name, window, onFire, opId: resolvedOpId }
}

function errorSummary(err) {
  if (err instanceof Error) return { name: err.name, message: err.message, code: err.code ?? null }
  return { name: typeof err, message: String(err), code: null }
}

/**
 * Runs one arm once. See the brief's "Shared API". Throws only on programmer
 * error (bad arguments, a caller hash that cannot be computed on the fixture,
 * fs already interposed on entry, or a wrapper that did not restore) and on an
 * exception escaping quarantineTree itself; a mismatched trace is reported as
 * traceMatched:false / hookFired:false, never thrown.
 *
 * Extra fields beyond the brief: `onFireInvoked` (raw: onFire was CALLED, even
 * if the trace later failed to match -- a mutation may have landed regardless),
 * `mutationError` (null, or {name, message, code} when onFire threw; the run
 * still completes and still restores), `times.callerHashStartAt` and
 * `times.renameEndAt` (the A13 out-of-model window ends when rename RETURNS).
 */
export function runC4Candidate(args) {
  const { candidate, parentAbs, name, window, onFire, opId } = validateRunArgs(args)
  const eff = effectiveWindow(candidate, window)
  const originPath = path.resolve(path.join(parentAbs, name))
  const isOrigin = (p) => typeof p === 'string' && path.resolve(p) === originPath

  // The caller hash: same moment for both arms, so timing up to the call is
  // identical; passed to quarantineTree only for C4.
  const callerHashStartAt = now()
  const h = computePathTreeHash(originPath)
  const callerHashAt = now()
  if (!h.ok || typeof h.treeHash !== 'string' || h.treeHash.length === 0) {
    throw new Error(`runC4Candidate: caller hash failed on the fixture: ${JSON.stringify(h)}`)
  }
  const guardHash = h.treeHash

  const trace = []
  const times = {
    callerHashStartAt,
    callerHashAt,
    callStartAt: null,
    recheckAt: null,
    renameAt: null,
    renameEndAt: null,
    callEndAt: null,
  }
  let recording = false
  let firing = false
  let fired = false
  let firedAt = null
  let mutationError = null
  let lstatOrdinal = 0

  const fire = () => {
    if (fired) return
    fired = true
    firedAt = eff
    firing = true
    const entry = { fn: FIRE, path: originPath, window: eff, at: now(), endAt: null, threw: null }
    trace.push(entry)
    try {
      onFire()
    } catch (err) {
      mutationError = errorSummary(err)
    } finally {
      entry.endAt = now()
      firing = false
    }
  }

  for (const n of TRACED_FNS) {
    if (fs[n] !== PRISTINE.get(n)) {
      throw new Error(`runC4Candidate: fs.${n} is already interposed on entry; refusing to run`)
    }
  }
  const wrappers = new Map()
  for (const n of TRACED_FNS) {
    const orig = PRISTINE.get(n)
    const wrapper = function c4Traced(...callArgs) {
      if (!recording || firing || !isOrigin(callArgs[0])) return orig.apply(this, callArgs)
      let ordinal = 0
      if (n === 'lstatSync') {
        ordinal = ++lstatOrdinal
        if (candidate === 'C4' && ordinal === C4_RECHECK_LSTAT_ORDINAL) {
          if (eff === 'post-hash') fire()
          times.recheckAt = now()
        }
      } else if (n === 'renameSync' && eff === 'at-rename') {
        fire()
      }
      const entry = { fn: n, path: originPath, at: now(), endAt: null, threw: null }
      if (n === 'renameSync') {
        entry.dest =
          typeof callArgs[1] === 'string' ? path.resolve(callArgs[1]) : String(callArgs[1])
        if (times.renameAt === null) times.renameAt = entry.at
      }
      trace.push(entry)
      let out
      try {
        out = orig.apply(this, callArgs)
      } catch (err) {
        entry.threw = err?.code ?? String(err)
        throw err
      } finally {
        entry.endAt = now()
        if (n === 'renameSync' && times.renameEndAt === null) times.renameEndAt = entry.endAt
      }
      if (n === 'lstatSync' && ordinal === 1 && eff === 'after-bind' && candidate === 'C4') fire()
      return out
    }
    wrappers.set(n, wrapper)
  }

  let result
  let interpositionIntact = false
  let bodyFailed = false
  let bodyError
  let leaked = []
  try {
    for (const [n, w] of wrappers) fs[n] = w
    if (eff === 'pre-call') fire()
    const stillOurs = () => TRACED_FNS.every((n) => fs[n] === wrappers.get(n))
    if (!stillOurs()) {
      throw new Error('runC4Candidate: fs interposition was replaced before the call (by onFire?)')
    }
    recording = true
    times.callStartAt = now()
    try {
      result = quarantineTree(parentAbs, name, candidate === 'C4' ? { guardHash, opId } : { opId })
    } finally {
      times.callEndAt = now()
      recording = false
    }
    interpositionIntact = stillOurs()
  } catch (err) {
    // A flag, not `bodyError !== null`: `throw null` must not read as success.
    bodyFailed = true
    bodyError = err
  } finally {
    for (const n of TRACED_FNS) fs[n] = PRISTINE.get(n)
    leaked = TRACED_FNS.filter((n) => fs[n] !== PRISTINE.get(n))
  }
  // Loud by design: a leaked wrapper poisons every later run in this process.
  // Thrown AFTER the finally, not inside it: a throw inside `finally` replaces
  // an error already in flight, so a body failure plus a failed restore used to
  // report only the restore and lose the cause of the run's failure.
  if (leaked.length > 0) {
    throw new Error(`runC4Candidate: fs restore FAILED for ${leaked.join(', ')}`, {
      cause: bodyFailed ? bodyError : undefined,
    })
  }
  if (bodyFailed) throw bodyError

  const traceMatched =
    matchC4Trace({
      candidate,
      window,
      trace,
      result,
      callStartAt: times.callStartAt,
      interpositionIntact,
    }) === true

  return {
    result,
    guardHash,
    hookFired: fired === true && traceMatched,
    firedAt: fired ? firedAt : null,
    traceMatched,
    trace,
    times,
    onFireInvoked: fired === true,
    mutationError,
    opId,
  }
}

const LOCATE_MAX_ENTRIES = 10000
const LOCATE_MAX_PATHS = 8

/**
 * Classifies user files that are no longer intact at their original path.
 * EVERY entry of `expectedFiles` is classified -- pass only the lost (and
 * changed) subset; an intact file passed here would count as `deleted`.
 * A file counts as displaced when a regular file with exactly that content
 * exists under <fxRoot>/.skillsmith-trash; each trash file satisfies at most
 * one expected entry. Symlinks under the trash are NOT followed: following one
 * (e.g. A8a's moved link to an outside dir) would find outside bytes and
 * misreport them as displaced.
 *
 * @param {string} fxRoot
 * @param {Record<string,string>} expectedFiles - {relName: content}
 * @returns {{displaced:number, deleted:number, displacedPaths:string[]}}
 */
export function locateDisplaced(fxRoot, expectedFiles) {
  if (typeof fxRoot !== 'string' || !path.isAbsolute(fxRoot)) {
    throw new TypeError(
      `locateDisplaced: fxRoot must be an absolute path string, got ${String(fxRoot)}`
    )
  }
  if (expectedFiles === null || typeof expectedFiles !== 'object') {
    throw new TypeError('locateDisplaced: expectedFiles must be an object of {relName: content}')
  }
  const wanted = Object.entries(expectedFiles)
  for (const [rel, content] of wanted) {
    if (typeof content !== 'string') {
      throw new TypeError(`locateDisplaced: content for ${JSON.stringify(rel)} must be a string`)
    }
  }

  const trashRoot = path.join(fxRoot, '.skillsmith-trash')
  const pool = [] // [{rel, content, used}]
  let seen = 0
  const walk = (abs) => {
    let st
    try {
      st = fs.lstatSync(abs)
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    if (++seen > LOCATE_MAX_ENTRIES) {
      throw new Error(`locateDisplaced: more than ${LOCATE_MAX_ENTRIES} entries under ${trashRoot}`)
    }
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n))
    } else if (st.isFile()) {
      pool.push({
        rel: path.relative(fxRoot, abs),
        content: fs.readFileSync(abs, 'utf8'),
        used: false,
      })
    }
  }
  walk(trashRoot)

  let displaced = 0
  let deleted = 0
  const displacedPaths = []
  for (const [, content] of wanted) {
    const hit = pool.find((p) => !p.used && p.content === content)
    if (hit) {
      hit.used = true
      displaced += 1
      if (displacedPaths.length < LOCATE_MAX_PATHS) displacedPaths.push(hit.rel)
    } else {
      deleted += 1
    }
  }
  return { displaced, deleted, displacedPaths }
}
