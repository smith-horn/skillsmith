// Selftest for A13-C4's decision logic (attacks/a13-c4.classify.mjs). Plain
// node, synthetic inputs only, no racer and no filesystem:
//   node harness/a13-c4.selftest.mjs
// Prints one PASS/FAIL line per case and exits non-zero on any failure.
// Every behaviour is pinned by a positive case and a negative control that
// differs from it in exactly one input, so a branch that is dead or inverted
// fails one side or the other.

import {
  classifyLanding,
  windowEnds,
  deriveHashEvidence,
  buildLandings,
  routeRun,
  lossPrecededBy,
  recordForRunError,
  CALLER_HASH_FAILED_PREFIX,
  CALLER_HASH_RACE_REASON,
} from './attacks/a13-c4.classify.mjs'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`)
  }
}

// One synthetic call, all on one clock (ms). The rename call runs 21..22.
const C4_TIMES = {
  callerHashAt: 10,
  recheckAt: 20,
  renameAt: 21,
  renameReturnedAt: 22,
  callEndAt: 25,
}
const NAIVE_TIMES = {
  callerHashAt: 10,
  recheckAt: null,
  renameAt: 21,
  renameReturnedAt: 22,
  callEndAt: 25,
}

function cls(candidate, times, s, l) {
  const { inModelEnd, moveEnd } = windowEnds(candidate, times)
  return classifyLanding({ s, l, callerHashAt: times.callerHashAt, inModelEnd, moveEnd })
}

// --- windowEnds -----------------------------------------------------------
{
  const c4 = windowEnds('C4', C4_TIMES)
  check(
    'windowEnds C4: inModelEnd = recheckAt, moveEnd = renameReturnedAt',
    c4.inModelEnd === 20 && c4.moveEnd === 22,
    c4
  )
  const nv = windowEnds('C4-naive', NAIVE_TIMES)
  check(
    'windowEnds naive: inModelEnd = renameAt (no re-check)',
    nv.inModelEnd === 21 && nv.moveEnd === 22,
    nv
  )
  const kept = windowEnds('C4', {
    callerHashAt: 10,
    recheckAt: null,
    renameAt: null,
    renameReturnedAt: null,
    callEndAt: 15,
  })
  check(
    'windowEnds C4 kept-by-hash: both ends fall back to callEndAt',
    kept.inModelEnd === 15 && kept.moveEnd === 15,
    kept
  )
}

// --- classifyLanding: every class, every boundary, both arms -------------
for (const [arm, T] of [
  ['C4', C4_TIMES],
  ['C4-naive', NAIVE_TIMES],
]) {
  // pre-caller-hash vs the callerHashAt boundary (closed at the start).
  let c = cls(arm, T, 5, 9.999)
  check(`${arm} pre-caller-hash: l just before callerHashAt`, c.cls === 'pre-caller-hash', c)
  c = cls(arm, T, 5, 10)
  check(
    `${arm} control: l == callerHashAt is in-model, straddling`,
    c.cls === 'in-model' && c.straddles === true,
    c
  )
  c = cls(arm, T, 12, 13)
  check(
    `${arm} in-model: interval wholly inside, not straddling`,
    c.cls === 'in-model' && c.straddles === false,
    c
  )

  // post-rename vs the moveEnd boundary (the return is inside decision 5's window).
  c = cls(arm, T, 22.001, 30)
  check(`${arm} post-rename: s just after renameEndAt`, c.cls === 'post-rename', c)
  c = cls(arm, T, 22, 30)
  check(
    `${arm} control: s == renameEndAt is out-of-model, straddling`,
    c.cls === 'out-of-model' && c.straddles === true,
    c
  )

  // unknown when any input is missing; control with it present.
  c = cls(arm, T, 12, null)
  check(`${arm} unknown: landedAt missing`, c.cls === 'unknown', c)
}

// inModelEnd boundary (half-open), per arm: the arms differ by exactly this.
{
  let c = cls('C4', C4_TIMES, 20, 20.5)
  check(
    'C4 out-of-model: s == recheckAt (half-open in-model window)',
    c.cls === 'out-of-model' && c.straddles === false,
    c
  )
  c = cls('C4', C4_TIMES, 19.999, 20.5)
  check(
    'C4 control: s just before recheckAt is in-model, straddling',
    c.cls === 'in-model' && c.straddles === true,
    c
  )
  c = cls('C4-naive', NAIVE_TIMES, 20, 20.5)
  check(
    'naive in-model: the same s=recheck-instant is in-model (no re-check exists)',
    c.cls === 'in-model',
    c
  )
  c = cls('C4-naive', NAIVE_TIMES, 21, 21.5)
  check(
    'naive out-of-model: s == renameAt (rename syscall is out of model)',
    c.cls === 'out-of-model',
    c
  )
  c = cls('C4-naive', NAIVE_TIMES, 20.999, 21.5)
  check('naive control: s just before renameAt is in-model', c.cls === 'in-model', c)
}

// --- routeRun ---------------------------------------------------------------
{
  const L = (cls, landedAt = 1) => ({ cls, landedAt })
  let r = routeRun([])
  check(
    'route: no landing -> A13-C4, mutationApplied false',
    r.label === 'A13-C4' && r.mutationApplied === false,
    r
  )
  r = routeRun([L('in-model')])
  check(
    'route: in-model only -> A13-C4, mutationApplied true',
    r.label === 'A13-C4' && r.mutationApplied === true,
    r
  )
  r = routeRun([L('out-of-model')])
  check(
    'route: OOM only -> A13-C4-OOM, mutationApplied true',
    r.label === 'A13-C4-OOM' && r.mutationApplied === true,
    r
  )
  r = routeRun([L('out-of-model'), L('in-model')])
  check(
    'route: mixed -> A13-C4 (in-model evidence is kept)',
    r.label === 'A13-C4' && r.mutationApplied === true,
    r
  )
  r = routeRun([L('pre-caller-hash'), L('post-rename')])
  check(
    'route: only irrelevant landings -> A13-C4, mutationApplied false',
    r.label === 'A13-C4' && r.mutationApplied === false,
    r
  )
  r = routeRun([L('out-of-model'), L('pre-caller-hash')])
  check('route control: OOM plus an irrelevant one stays A13-C4-OOM', r.label === 'A13-C4-OOM', r)
  r = routeRun([L('unknown')])
  check(
    'route: unknown routes to the scored cell',
    r.label === 'A13-C4' && r.mutationApplied === true,
    r
  )

  const rel = [L('in-model', 5), L('out-of-model', 9)]
  check(
    'lossPrecededBy: latest-ending relevant landing',
    lossPrecededBy(rel, true) === 'out-of-model'
  )
  check('lossPrecededBy control: null when nothing was lost', lossPrecededBy(rel, false) === null)
}

// --- hash override ----------------------------------------------------------
{
  const racer = { applied: 'a8', mutationStartedAt: 9, landedAt: 11 } // timestamp says in-model
  const ends = windowEnds('C4', C4_TIMES)
  const land = (proven) =>
    buildLandings({
      racer,
      callerHashAt: C4_TIMES.callerHashAt,
      ...ends,
      provenPreCallerHash: proven,
    })

  // Fires: caller saw the mutation (G != P) and the moved tree is still G.
  const fire = deriveHashEvidence({
    candidate: 'C4',
    pristineHash: 'P',
    guardHash: 'G',
    postMoveHash: 'G',
  })
  check(
    'hash evidence: proven when caller saw mutation and moved tree == caller hash',
    fire.provenPreCallerHash === true && fire.window === 'before-caller-hash',
    fire
  )
  const fired = land(fire.provenPreCallerHash)[0]
  check(
    'hash override FIRES: timestamp in-model reclassified pre-caller-hash by hash',
    fired.cls === 'pre-caller-hash' &&
      fired.evidence === 'hash' &&
      fired.timestampCls === 'in-model',
    fired
  )
  check(
    'hash override routes the run out of the denominator',
    routeRun([fired]).mutationApplied === false
  )

  // Does NOT fire: the moved tree differs from the caller's hash.
  const differ = deriveHashEvidence({
    candidate: 'C4',
    pristineHash: 'P',
    guardHash: 'G',
    postMoveHash: 'X',
  })
  check(
    'hash evidence control: moved tree differs -> not proven, change bounded after C4 read',
    differ.provenPreCallerHash === false &&
      differ.window === 'after-C4-read-of-entry..rename-returned',
    differ
  )
  const notFired = land(differ.provenPreCallerHash)[0]
  check(
    'hash override does NOT fire when moved tree differs: stays in-model by timestamp',
    notFired.cls === 'in-model' && notFired.evidence === 'timestamp',
    notFired
  )

  const unseen = deriveHashEvidence({
    candidate: 'C4',
    pristineHash: 'P',
    guardHash: 'P',
    postMoveHash: 'P',
  })
  check(
    'hash evidence control: caller saw pristine -> not proven',
    unseen.provenPreCallerHash === false,
    unseen
  )
  const kept = deriveHashEvidence({
    candidate: 'C4',
    pristineHash: 'P',
    guardHash: 'G',
    postMoveHash: null,
  })
  check(
    'hash evidence control: nothing moved (null) -> not proven, no window',
    kept.provenPreCallerHash === false && kept.window === null,
    kept
  )
  const nv = deriveHashEvidence({
    candidate: 'C4-naive',
    pristineHash: 'P',
    guardHash: 'G',
    postMoveHash: 'X',
  })
  check(
    'hash evidence naive: window names the caller, not C4',
    nv.window === 'after-caller-read-of-entry..rename-returned',
    nv
  )

  check(
    'buildLandings: racer that applied nothing has no landing',
    buildLandings({
      racer: { applied: null },
      callerHashAt: 10,
      ...ends,
      provenPreCallerHash: true,
    }).length === 0
  )
}

// --- caller-hash-race record ------------------------------------------------
{
  const base = {
    candidate: 'C4',
    markerObservedAt: 1,
    durationMs: 2,
    quarantineLeft: { dirs: null },
  }
  const hashErr = new Error(`${CALLER_HASH_FAILED_PREFIX} on the fixture: {"ok":false}`)
  const applied = { applied: 'a5', mutationStartedAt: 3, landedAt: 4 }

  // A throw here must surface as FAIL lines, not crash the selftest, so a
  // mutation that makes this path rethrow is reported at the check it breaks.
  let rec
  try {
    rec = recordForRunError({ ...base, err: hashErr, racer: applied })
  } catch (thrown) {
    rec = { outcome: {}, precondition: {}, extra: {}, thrown: String(thrown && thrown.message) }
  }
  check(
    'caller-hash race: returned a record instead of throwing',
    rec.thrown === undefined,
    rec.thrown
  )
  check(
    'caller-hash race: status harness-error with the named reason',
    rec.outcome.status === 'harness-error' && rec.outcome.reason === CALLER_HASH_RACE_REASON,
    rec.outcome
  )
  check(
    'caller-hash race: mutationApplied false (R6 drops it), hookFired/traceMatched false',
    rec.precondition.mutationApplied === false &&
      rec.precondition.hookFired === false &&
      rec.precondition.traceMatched === false &&
      rec.precondition.controlExpected === true,
    rec.precondition
  )
  check(
    'caller-hash race: precondition carries exactly the four keys',
    JSON.stringify(Object.keys(rec.precondition).sort()) ===
      JSON.stringify(['controlExpected', 'hookFired', 'mutationApplied', 'traceMatched']),
    Object.keys(rec.precondition)
  )
  check(
    'caller-hash race: label A13-C4, variant fixed, raw racer fact kept',
    rec.extra.label === 'A13-C4' &&
      rec.extra.variant === 'racer/by-timestamp' &&
      rec.extra.racerApplied === 'a5',
    rec.extra
  )

  const throws = (fn) => {
    try {
      fn()
      return null
    } catch (e) {
      return e
    }
  }
  let e = throws(() =>
    recordForRunError({ ...base, err: hashErr, racer: { applied: null, error: 'ENOENT' } })
  )
  check(
    'caller-hash failure WITHOUT racer activity still throws (the same error)',
    e === hashErr,
    e && e.message
  )
  const other = new Error(
    'runC4Candidate: fs.lstatSync is already interposed on entry; refusing to run'
  )
  e = throws(() => recordForRunError({ ...base, err: other, racer: applied }))
  check(
    'control: a different runC4Candidate error rethrows even with racer activity',
    e === other,
    e && e.message
  )
  e = throws(() => recordForRunError({ ...base, err: 'x', racer: applied }))
  check('control: a non-Error throw rethrows', e === 'x', e)
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
