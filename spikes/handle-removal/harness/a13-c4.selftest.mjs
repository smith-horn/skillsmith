// Selftest for A13-C4's decision logic (attacks/a13-c4.classify.mjs and
// attacks/a13-c4.score.mjs). Plain
// node, synthetic inputs only, no racer and no filesystem:
//   node harness/a13-c4.selftest.mjs
// Prints one PASS/FAIL line per case and exits non-zero on any failure.
// Every behaviour is pinned by a positive case and a negative control that
// differs from it in exactly one input, so a branch that is dead or inverted
// fails one side or the other.

import {
  classifyLanding,
  windowEnds,
  routeRun,
  lossPrecededBy,
} from './attacks/a13-c4.classify.mjs'
// Partial-run landings and scoring (review R1-F1/F3), the hash override and
// the caller-hash-race record live in a sibling file to keep both under 500
// lines; they report through this file's check().
import { runLandingCases } from './a13-c4.selftest.landings.mjs'
// Round-2 record-level rules and the caller-hash catch's relatedness check.
import { runRecordCases } from './a13-c4.selftest.record.mjs'
// Final governance: the caller-hash-race record through the real tally, F3.
import { runGovCases } from './a13-c4.selftest.gov.mjs'
// Trace compaction: synthetic, plus one live runOnce per arm.
import { runTraceCases } from './a13-c4.selftest.trace.mjs'

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

runLandingCases(check)
runRecordCases(check)
runGovCases(check)
await runTraceCases(check)

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
