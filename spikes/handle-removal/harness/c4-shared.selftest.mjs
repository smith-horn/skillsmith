// Self-test for attacks/c4-shared.mjs (SMI-6715 milestone 1). Plain node script:
// prints PASS/FAIL lines and exits non-zero on any failure. Host node, darwin.
//
// c4-shared.mjs transforms evidence for every C4 verdict, so this proves both
// directions: real runs MATCH (positive), and mutated traces do NOT (negative).
// Synthetic matcher red tests live in c4-trace-match.selftest.mjs and
// locateDisplaced's in c4-displaced.selftest.mjs.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture, renameAsideAndReplace } from './attacks/_shared.mjs'
import { runC4Candidate, C4_CANDIDATES, C4_WINDOWS, FIRE } from './attacks/c4-shared.mjs'

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
// Root skeleton plus counts of descendant / destination events.
const names = (trace) => {
  const root = trace.filter((e) => e.fn === FIRE || (e.scope === 'origin' && !e.nested))
  const n = (s) => trace.filter((e) => e.scope === s || e.scope2 === s).length
  return `${root.map((e) => e.fn).join(',')} +desc:${n('desc')} +dest:${n('dest')}`
}

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

// 9. R2-5a / R2-5c: a restore that cannot write one property must still restore
//    every other wrapper, and must report the body error as `cause`.
//    The victim is made non-writable from inside onFire; the test itself puts
//    the descriptor and every *Sync function back in `finally` and checks it.
{
  const VICTIM = 'appendFileSync'
  const syncNames = Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function')
  const originals = new Map(syncNames.map((n) => [n, fs[n]]))
  const victimDesc = Object.getOwnPropertyDescriptor(fs, VICTIM)
  const putBack = () => {
    Object.defineProperty(fs, VICTIM, victimDesc)
    for (const n of syncNames) if (fs[n] !== originals.get(n)) fs[n] = originals.get(n)
  }
  const othersRestored = () => syncNames.filter((n) => n !== VICTIM && fs[n] !== originals.get(n))
  for (const [label, bodyFails] of [
    ['body also failed', true],
    ['body succeeded', false],
  ]) {
    let thrown = null
    let leftOthers = null
    let victimWrapped = null
    try {
      runOn('C4', 'pre-call', () => () => {
        // Precondition: the victim really is one of the interposed wrappers.
        victimWrapped = fs[VICTIM] !== originals.get(VICTIM)
        // bodyFails: replace with a foreign function, so the pre-call
        // "still ours" check throws inside the body. Otherwise keep the
        // installed wrapper, so the body completes and only the restore fails.
        const value = bodyFails ? function foreign() {} : fs[VICTIM]
        Object.defineProperty(fs, VICTIM, {
          value,
          writable: false,
          configurable: true,
          enumerable: true,
        })
      })
    } catch (err) {
      thrown = err
    } finally {
      leftOthers = othersRestored()
      putBack()
    }
    check(
      `R2-5a (${label}): precondition - the victim was interposed when onFire ran`,
      victimWrapped === true
    )
    check(
      `R2-5a (${label}): restore error names the victim, not a raw TypeError`,
      thrown instanceof Error &&
        thrown.message.startsWith('runC4Candidate: fs restore FAILED') &&
        thrown.message.includes(VICTIM),
      thrown ? `${thrown.name}: ${thrown.message.slice(0, 80)}` : 'no throw'
    )
    check(
      `R2-5a (${label}): every other wrapper was still restored`,
      leftOthers.length === 0,
      `left installed: ${leftOthers.length}`
    )
    check(
      `R2-5a (${label}): restoreErrors records the victim's own TypeError`,
      Array.isArray(thrown?.restoreErrors) &&
        thrown.restoreErrors.length === 1 &&
        thrown.restoreErrors[0].fn === VICTIM &&
        thrown.restoreErrors[0].name === 'TypeError'
    )
    if (bodyFails) {
      check(
        'R2-5c: cause is the body error when body and restore both fail',
        thrown?.cause instanceof Error &&
          thrown.cause.message.includes('fs interposition was replaced before the call'),
        thrown?.cause ? thrown.cause.message.slice(0, 80) : 'no cause'
      )
    } else {
      check(
        'R2-5c control: no body failure -> cause undefined',
        thrown !== null && thrown.cause === undefined
      )
    }
    check(
      `R2-5a (${label}): the test put fs back`,
      othersRestored().length === 0 &&
        fs[VICTIM] === originals.get(VICTIM) &&
        Object.getOwnPropertyDescriptor(fs, VICTIM).writable === true
    )
  }
}

// 10. G3-7: a caller-hash failure carries its own timing (same clock as times.*),
//     so a consumer can still place it. Forced for real: an unreadable file in
//     the tree makes computePathTreeHash fail before quarantineTree is called.
{
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const f = buildSwapFixture(fx.root)
    fs.chmodSync(path.join(f.targetAbs, 'orig-f1'), 0)
    const before = performance.timeOrigin + performance.now()
    let thrown = null
    try {
      runC4Candidate({
        candidate: 'C4',
        parentAbs: fx.root,
        name: 'tree',
        window: 'pre-call',
        onFire() {},
      })
    } catch (err) {
      thrown = err
    }
    const after = performance.timeOrigin + performance.now()
    const s = thrown?.callerHashStartAt
    const e = thrown?.callerHashAt
    check(
      'G3-7: caller-hash failure throws with callerHashStartAt <= callerHashAt, both inside the call',
      thrown instanceof Error &&
        thrown.message.includes('caller hash failed') &&
        Number.isFinite(s) &&
        Number.isFinite(e) &&
        before <= s &&
        s <= e &&
        e <= after,
      thrown ? `${thrown.message.slice(0, 50)} start=${s} end=${e}` : 'no throw'
    )
    check('G3-7: wrappers untouched by a caller-hash failure', restored())
  } finally {
    fx.cleanup()
  }
}

if (!allOk) {
  console.error('[c4-shared self-test] FAIL')
  process.exit(1)
}
console.log('[c4-shared self-test] all cases passed')
process.exit(0)
