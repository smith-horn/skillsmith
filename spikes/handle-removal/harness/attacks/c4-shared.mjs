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
// WHAT IS TRACED: every call, through any of the fs default export's own
// `*Sync` functions, whose path is the tree root, inside the root, or inside
// this run's trash destination (<parent>/.skillsmith-trash/<opId>/...), made by
// C4 while quarantineTree runs. Calls made inside onFire are not traced. What a
// MATCH then verifies -- the root skeleton plus phase invariants, and what it
// does not verify -- is stated in ./c4-trace-match.mjs's header.
//
// Split for the file-length limit: the matcher lives in ./c4-trace-match.mjs
// and displacement classification in ./c4-displaced.mjs; both are re-exported
// here so callers keep importing from this module.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { quarantineTree, computePathTreeHash } from '../../quarantine.mjs'
import { assertPathSegment } from '../../result-shape.mjs'
import {
  FIRE,
  C4_RECHECK_LSTAT_ORDINAL,
  effectiveWindow,
  makeScoper,
  matchC4Trace,
} from './c4-trace-match.mjs'

export { FIRE, expectedTrace, matchC4Trace } from './c4-trace-match.mjs'
export { locateDisplaced } from './c4-displaced.mjs'

export const C4_CANDIDATES = Object.freeze(['C4', 'C4-naive'])
export const C4_WINDOWS = Object.freeze(['pre-call', 'after-bind', 'post-hash', 'at-rename'])

/**
 * Every own function-valued `*Sync` property of the fs default export, captured
 * at module load. All of them are wrapped during a run so an unexpected touch of
 * the root, its subtree or the destination through ANY of them lands in the
 * trace. Only root lstatSync and renameSync carry fire logic.
 */
const TRACED_FNS = Object.freeze(
  Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function')
)
const PRISTINE = new Map(TRACED_FNS.map((n) => [n, fs[n]]))

const now = () => performance.timeOrigin + performance.now()

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
 * Trace entries: {fn, path, scope, scope2, nested, at, endAt, threw} plus
 * `dest` on renameSync and `flags` on openSync; FIRE entries carry `window`.
 * `nested` marks a call made while another traced call was in progress (the
 * openSync inside readFileSync).
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
  const destDir = path.resolve(parentAbs, '.skillsmith-trash', opId)
  const scopesOf = makeScoper(originPath, destDir)

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
  let depth = 0

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
      if (!recording || firing) return orig.apply(this, callArgs)
      const { scope, scope2 } = scopesOf(n, callArgs)
      if (scope === null && scope2 === null) return orig.apply(this, callArgs)
      const nested = depth > 0
      const root = scope === 'origin' && !nested
      let ordinal = 0
      if (root && n === 'lstatSync') {
        ordinal = ++lstatOrdinal
        if (candidate === 'C4' && ordinal === C4_RECHECK_LSTAT_ORDINAL) {
          if (eff === 'post-hash') fire()
          times.recheckAt = now()
        }
      } else if (root && n === 'renameSync' && eff === 'at-rename') {
        fire()
      }
      const entry = {
        fn: n,
        path: typeof callArgs[0] === 'string' ? path.resolve(callArgs[0]) : String(callArgs[0]),
        scope,
        scope2,
        nested,
        at: now(),
        endAt: null,
        threw: null,
      }
      if (n === 'openSync') entry.flags = callArgs[1]
      const rootRename = root && n === 'renameSync'
      if (rootRename) {
        entry.dest =
          typeof callArgs[1] === 'string' ? path.resolve(callArgs[1]) : String(callArgs[1])
        if (times.renameAt === null) times.renameAt = entry.at
      }
      trace.push(entry)
      let out
      depth += 1
      try {
        out = orig.apply(this, callArgs)
      } catch (err) {
        entry.threw = err?.code ?? String(err)
        throw err
      } finally {
        depth -= 1
        entry.endAt = now()
        if (rootRename && times.renameEndAt === null) times.renameEndAt = entry.endAt
      }
      if (
        root &&
        n === 'lstatSync' &&
        ordinal === 1 &&
        eff === 'after-bind' &&
        candidate === 'C4'
      ) {
        fire()
      }
      return out
    }
    wrappers.set(n, wrapper)
  }

  let result
  let interpositionIntact = false
  let bodyFailed = false
  let bodyError
  let leaked = []
  const restoreErrors = []
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
    // R2-5a: each assignment guarded on its own. A non-writable property makes
    // the assignment THROW (strict mode); unguarded, that one throw escaped as a
    // raw TypeError, replaced the body error, and left every later wrapper
    // installed (42 of 43, measured). Keep restoring the rest regardless.
    for (const n of TRACED_FNS) {
      try {
        fs[n] = PRISTINE.get(n)
      } catch (err) {
        restoreErrors.push({ fn: n, error: err })
      }
    }
    leaked = TRACED_FNS.filter((n) => fs[n] !== PRISTINE.get(n))
  }
  // Loud by design: a leaked wrapper poisons every later run in this process.
  // Thrown AFTER the finally, not inside it: a throw inside `finally` replaces
  // an error already in flight, so a body failure plus a failed restore used to
  // report only the restore and lose the cause of the run's failure.
  if (leaked.length > 0 || restoreErrors.length > 0) {
    const failedFns = [...new Set([...leaked, ...restoreErrors.map((r) => r.fn)])]
    const err = new Error(`runC4Candidate: fs restore FAILED for ${failedFns.join(', ')}`, {
      cause: bodyFailed ? bodyError : undefined,
    })
    err.restoreErrors = restoreErrors.map(({ fn, error }) => ({
      fn,
      name: error?.name ?? typeof error,
      message: String(error?.message ?? error),
    }))
    throw err
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
