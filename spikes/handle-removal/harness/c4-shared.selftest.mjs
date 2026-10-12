// Self-test for attacks/c4-shared.mjs (SMI-6715 milestone 1). Plain node script:
// prints PASS/FAIL lines and exits non-zero on any failure. Host node, darwin.
//
// c4-shared.mjs transforms evidence for every C4 verdict, so this proves both
// directions: real runs MATCH (positive), and mutated traces do NOT (negative).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture, renameAsideAndReplace } from './attacks/_shared.mjs'
import {
  runC4Candidate,
  locateDisplaced,
  matchC4Trace,
  C4_CANDIDATES,
  C4_WINDOWS,
  FIRE,
} from './attacks/c4-shared.mjs'

const harnessRoot = resolveHarnessRoot()
const PRISTINE = { lstatSync: fs.lstatSync, renameSync: fs.renameSync, readdirSync: fs.readdirSync }
let allOk = true
function check(label, cond, detail = '') {
  if (!cond) allOk = false
  console.log(
    `[c4-shared self-test] ${label}: ${cond ? 'PASS' : 'FAIL'}${detail ? ` (${detail})` : ''}`
  )
}
const restored = () =>
  fs.lstatSync === PRISTINE.lstatSync &&
  fs.renameSync === PRISTINE.renameSync &&
  fs.readdirSync === PRISTINE.readdirSync
const names = (trace) => trace.map((e) => e.fn).join(',')

/** Runs one arm on a fresh swap fixture; onFire gets (fixture, fx, opId). */
function runOn(candidate, window, makeOnFire) {
  const fx = makeFixtureRoot({ harnessRoot })
  // The caller cleans up after inspecting a successful run; a run that throws
  // must not leak its fixture, so clean up here and rethrow.
  try {
    const f = buildSwapFixture(fx.root)
    const opId = `st-${fx.runId}`
    const ctx = {}
    const out = runC4Candidate({
      candidate,
      parentAbs: fx.root,
      name: 'tree',
      window,
      opId,
      onFire: makeOnFire(f, fx, opId, ctx),
    })
    return { out, ctx, fx, f, opId }
  } catch (err) {
    fx.cleanup()
    throw err
  }
}

// Probe of on-disk state at the moment onFire runs.
const stateProbe = (f, fx, opId, ctx) => () => {
  ctx.trashExists = fs.existsSync(path.join(fx.root, '.skillsmith-trash'))
  ctx.opDirExists = fs.existsSync(path.join(fx.root, '.skillsmith-trash', opId))
  ctx.originExists = fs.existsSync(path.join(fx.root, 'tree'))
}

// 1. Every arm x window on an unattacked tree: quarantined, matched, fired,
//    restored, and FIRE at the declared ordinal, checked by timestamps and state.
for (const candidate of C4_CANDIDATES) {
  for (const window of C4_WINDOWS) {
    const { out, ctx, fx } = runOn(candidate, window, stateProbe)
    const tag = `${candidate}/${window}`
    const t = out.trace
    const fi = t.findIndex((e) => e.fn === FIRE)
    const mapped = candidate === 'C4-naive' && window !== 'pre-call' ? 'at-rename' : window
    check(
      `${tag} unattacked -> quarantined, traceMatched, hookFired`,
      out.result.status === 'quarantined' && out.traceMatched === true && out.hookFired === true,
      `status=${out.result.status} trace=${names(t)}`
    )
    check(
      `${tag} firedAt reports the effective window`,
      out.firedAt === mapped,
      `firedAt=${out.firedAt}`
    )
    check(`${tag} wrappers restored`, restored())
    // Timestamps: FIRE sits between the call before it (returned) and the call after it.
    const before = fi > 0 ? t[fi - 1] : null
    const after = t[fi + 1]
    const tsOk =
      fi !== -1 &&
      (before === null || before.endAt <= t[fi].at) &&
      after !== undefined &&
      t[fi].endAt <= after.at &&
      (mapped === 'pre-call' ? t[fi].at < out.times.callStartAt : t[fi].at >= out.times.callStartAt)
    check(`${tag} FIRE timestamp between neighbours`, tsOk, `fireIdx=${fi}`)
    // State at fire time, per window.
    let stateOk
    if (candidate === 'C4' && window === 'pre-call') {
      stateOk = ctx.originExists && !ctx.trashExists && out.times.recheckAt > t[fi].endAt
    } else if (candidate === 'C4' && window === 'after-bind') {
      // identity bound (1 lstat before FIRE), hash not begun: no readdir yet, no trash yet.
      stateOk =
        fi === 1 &&
        t[0].fn === 'lstatSync' &&
        !t.slice(0, fi).some((e) => e.fn === 'readdirSync') &&
        !ctx.trashExists
    } else if (candidate === 'C4' && window === 'post-hash') {
      // hash done and op dir created, re-check NOT yet run.
      stateOk = ctx.opDirExists && ctx.originExists && out.times.recheckAt >= t[fi].endAt
    } else if (candidate === 'C4' && window === 'at-rename') {
      // re-check already happened, rename not yet.
      stateOk =
        ctx.opDirExists &&
        ctx.originExists &&
        out.times.recheckAt < t[fi].at &&
        out.times.renameAt >= t[fi].endAt
    } else if (mapped === 'pre-call') {
      stateOk = ctx.originExists && !ctx.trashExists && fi === 0
    } else {
      // C4-naive at-rename (mapped): no bind/hash/re-check exists; op dir made; rename next.
      stateOk = fi === 0 && ctx.opDirExists && ctx.originExists && out.times.recheckAt === null
    }
    check(`${tag} state inside onFire matches the window`, stateOk === true, JSON.stringify(ctx))
    fx.cleanup()
  }
}

// 2. A mutation path the matcher must accept as a legitimate early exit.
{
  const { out, fx } = runOn(
    'C4',
    'after-bind',
    (f) => () => renameAsideAndReplace(f.targetAbs, { 'orig-f1': 'replacement-after-bind' })
  )
  check(
    'C4 after-bind swap -> kept, traceMatched (early exit is a declared prefix)',
    out.result.status === 'kept' && out.traceMatched === true && out.hookFired === true,
    `${out.result.status}/${out.result.reason} trace=${names(out.trace)}`
  )
  fx.cleanup()
}

// 3. onFire throws: recorded, run completes, wrappers restored.
{
  const { out, fx } = runOn('C4', 'post-hash', () => () => {
    throw new Error('selftest-boom')
  })
  check(
    'onFire throw -> mutationError recorded, hookFired true, wrappers restored',
    out.mutationError?.message === 'selftest-boom' && out.hookFired === true && restored(),
    JSON.stringify(out.mutationError)
  )
  fx.cleanup()
}

// 4. locateDisplaced positive and negative controls.
{
  const { out, fx } = runOn('C4', 'post-hash', (f, fx2, opId, ctx) => () => {
    ctx.files = { 'orig-f1': `displaced-${fx2.runId}` }
    renameAsideAndReplace(f.targetAbs, ctx.files)
  })
  // post-hash swap is decision 4's in-model FAIL row: the replacement is moved into trash.
  const loc = locateDisplaced(fx.root, { 'orig-f1': `displaced-${fx.runId}` })
  check(
    'locateDisplaced positive: file moved into trash counts displaced',
    out.result.status === 'quarantined' &&
      loc.displaced === 1 &&
      loc.deleted === 0 &&
      loc.displacedPaths.length === 1,
    JSON.stringify(loc)
  )
  fx.cleanup()
}
{
  const fx = makeFixtureRoot({ harnessRoot })
  fs.mkdirSync(path.join(fx.root, '.skillsmith-trash', 'op-x'), { recursive: true })
  const victim = path.join(fx.root, 'user-file')
  fs.writeFileSync(victim, 'deleted-content')
  fs.rmSync(victim)
  const loc = locateDisplaced(fx.root, { 'user-file': 'deleted-content' })
  check(
    'locateDisplaced negative: deleted file counts deleted',
    loc.displaced === 0 && loc.deleted === 1,
    JSON.stringify(loc)
  )
  fx.cleanup()
}

// 5. Shape attacks on runC4Candidate's own inputs: each must be a TypeError.
{
  const fx = makeFixtureRoot({ harnessRoot })
  buildSwapFixture(fx.root)
  const good = {
    candidate: 'C4',
    parentAbs: fx.root,
    name: 'tree',
    window: 'pre-call',
    onFire() {},
  }
  for (const [label, patch] of [
    ['candidate as String object', { candidate: new String('C4') }],
    ['window not in C4_WINDOWS', { window: 'mid-hash' }],
    ['window as String object', { window: new String('pre-call') }],
    ['onFire not a function', { onFire: 'nope' }],
    ['parentAbs relative', { parentAbs: 'relative/dir' }],
    ['opId not a single segment', { opId: '../escape' }],
  ]) {
    let thrown = null
    try {
      runC4Candidate({ ...good, ...patch })
    } catch (err) {
      thrown = err
    }
    check(
      `shape: ${label} -> TypeError`,
      thrown instanceof TypeError,
      thrown ? thrown.message.slice(0, 70) : 'no throw'
    )
  }
  check('shape attacks left wrappers restored', restored())
  fx.cleanup()
}

// 6. Red tests for matchC4Trace. Each mutated trace carries ONE defect; the
//    unmutated baseline must match first, so a false below is caused by the defect.
{
  const { out, fx } = runOn('C4', 'at-rename', () => () => {})
  const base = {
    candidate: 'C4',
    window: 'at-rename',
    result: out.result,
    callStartAt: out.times.callStartAt,
    interpositionIntact: true,
  }
  const clone = () => out.trace.map((e) => ({ ...e }))
  check(
    'matcher baseline (real at-rename trace) matches',
    matchC4Trace({ ...base, trace: clone() }) === true,
    names(out.trace)
  )

  const noFire = clone().filter((e) => e.fn !== FIRE)
  check(
    'red: FIRE marker dropped -> false',
    matchC4Trace({ ...base, trace: noFire }) === false,
    names(noFire)
  )

  const extra = clone()
  extra.splice(1, 0, { ...extra[0] })
  check(
    'red: extra lstat inserted -> false',
    matchC4Trace({ ...base, trace: extra }) === false,
    names(extra)
  )

  const reordered = clone()
  ;[reordered[1], reordered[2]] = [reordered[2], reordered[1]]
  for (let i = 0; i < reordered.length; i++) reordered[i].at = out.trace[i].at // keep timestamps monotone
  check(
    'red: readdir/lstat reordered -> false',
    matchC4Trace({ ...base, trace: reordered }) === false,
    names(reordered)
  )

  const midThrow = clone()
  midThrow[0].threw = 'ENOENT'
  check(
    'red: non-final call threw -> false',
    matchC4Trace({ ...base, trace: midThrow }) === false,
    'trace[0].threw=ENOENT'
  )
  fx.cleanup()
}
{
  // FIRE-absence in isolation: a stopped trace that is a valid prefix but never fired.
  const prefixNoFire = [{ fn: 'lstatSync', at: 10, endAt: 11, threw: 'ENOENT' }]
  const args = {
    candidate: 'C4',
    window: 'after-bind',
    result: { status: 'stopped' },
    callStartAt: 1,
    interpositionIntact: true,
  }
  const withFire = [
    { fn: 'lstatSync', at: 10, endAt: 11, threw: null },
    { fn: FIRE, at: 12, endAt: 13, threw: null },
    { fn: 'lstatSync', at: 14, endAt: 15, threw: 'ENOENT' },
  ]
  check(
    'matcher control: stopped prefix WITH FIRE matches',
    matchC4Trace({ ...args, trace: withFire }) === true
  )
  check(
    'red: stopped prefix with no FIRE -> false',
    matchC4Trace({ ...args, trace: prefixNoFire }) === false
  )
}

// 7. Synthetic-trace red tests for the remaining matcher clauses. Each starts
//    from a REAL trace whose baseline matches, then changes one thing.
{
  const real = (candidate, window) => {
    const { out, fx } = runOn(candidate, window, () => () => {})
    fx.cleanup()
    return out
  }
  const args = (out, candidate, window, extra = {}) => ({
    candidate,
    window,
    trace: out.trace.map((e) => ({ ...e })),
    result: { ...out.result },
    callStartAt: out.times.callStartAt,
    interpositionIntact: true,
    ...extra,
  })

  const q = real('C4', 'at-rename')
  check(
    'synthetic baseline C4/at-rename matches',
    matchC4Trace(args(q, 'C4', 'at-rename')) === true
  )
  // Ciii: quarantined requires the final rename's destination to be result.path.
  check(
    'red Ciii: quarantined but result.path != rename dest -> false',
    matchC4Trace(
      args(q, 'C4', 'at-rename', { result: { ...q.result, path: `${q.result.path}-elsewhere` } })
    ) === false
  )
  // Civ: kept/stopped requires an early stop or a final throw; a full clean trace is not one.
  check(
    'red Civ: full clean trace with status kept -> false',
    matchC4Trace(args(q, 'C4', 'at-rename', { result: { ...q.result, status: 'kept' } })) === false
  )
  check(
    'red Civ: full clean trace with status stopped -> false',
    matchC4Trace(args(q, 'C4', 'at-rename', { result: { ...q.result, status: 'stopped' } })) ===
      false
  )
  // Cv: interposition not intact at end of call.
  check(
    'red Cv: interpositionIntact false -> false',
    matchC4Trace(args(q, 'C4', 'at-rename', { interpositionIntact: false })) === false
  )

  const p = real('C4', 'pre-call')
  check('synthetic baseline C4/pre-call matches', matchC4Trace(args(p, 'C4', 'pre-call')) === true)
  // Cvi: a pre-call FIRE must precede callStartAt.
  {
    const a = args(p, 'C4', 'pre-call')
    a.trace[0].at = a.callStartAt // FIRE at the call start, still <= the first lstat's time
    check(
      'red Cvi: pre-call FIRE not before callStartAt -> false',
      a.trace[1].at >= a.trace[0].at && matchC4Trace(a) === false
    )
  }

  // Ci-b: a post-hash claim whose FIRE actually sits after the bind (where a
  // coordinated FIRE_INDEX/C4_RECHECK_LSTAT_ORDINAL off-by-one would put it).
  {
    const ab = real('C4', 'after-bind')
    check(
      'red Ci-b: after-bind-shaped trace claimed as post-hash -> false',
      matchC4Trace(args(ab, 'C4', 'post-hash')) === false,
      names(ab.trace)
    )
  }
}

// 8. X7 + X9: C4 itself touching originPath through a non-lstat/rename/readdir
//    *Sync must break the match, and hookFired must then be false.
//
//    onFire's own fs calls are deliberately NOT traced (they are the mutation),
//    so the stray call is injected inside C4's own execution instead: through
//    crypto.randomBytes, which quarantine.mjs calls (randSuffix) after the op
//    directory checks and before the re-check, while recording is on. opId is
//    passed, so runC4Candidate's own randomBytes is never reached.
for (const stray of ['statSync', 'existsSync']) {
  const origRandom = crypto.randomBytes
  let injected = false
  let out
  let fxHandle
  try {
    const r = runOn('C4', 'at-rename', (f, fx) => {
      fxHandle = fx
      crypto.randomBytes = (...a) => {
        if (!injected) {
          injected = true
          fs[stray](path.join(fx.root, 'tree'))
        }
        return origRandom.apply(crypto, a)
      }
      return () => {}
    })
    out = r.out
  } finally {
    crypto.randomBytes = origRandom
  }
  check(
    `X7: C4 touches originPath via fs.${stray} during the call -> traceMatched false`,
    injected === true && out.trace.some((e) => e.fn === stray) && out.traceMatched === false,
    names(out.trace)
  )
  check(
    `X9: traceMatched false -> hookFired false (onFire did run)`,
    out.onFireInvoked === true && out.hookFired === false
  )
  check(
    `X7: wrappers and crypto restored after fs.${stray} case`,
    restored() && crypto.randomBytes === origRandom
  )
  fxHandle.cleanup()
}
// Positive control for the design choice above: onFire's own originPath touches are not traced.
{
  const { out, fx } = runOn(
    'C4',
    'post-hash',
    (f, fx2) => () => fs.statSync(path.join(fx2.root, 'tree'))
  )
  check(
    'onFire own fs.statSync(originPath) is not traced, run still matches',
    out.traceMatched === true && !out.trace.some((e) => e.fn === 'statSync')
  )
  fx.cleanup()
}

if (!allOk) {
  console.error('[c4-shared self-test] FAIL')
  process.exit(1)
}
console.log('[c4-shared self-test] all cases passed')
process.exit(0)
