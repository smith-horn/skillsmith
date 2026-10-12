// Round-2 cases for harness/a13-c4.selftest.mjs (run through that file):
// record-level decisions (attacks/a13-c4.record.mjs) and the caller-hash race
// catch's relatedness check (attacks/a13-c4.classify.mjs). Owner decision on
// vacuous checks; review R2-7, R2-10 (K1/K3) and R2-11 (K2). Each rule has a
// positive case and a control that differs in one input.

import { decideRecord, SKEW_MIN_MS, SKEW_MAX_MS } from './attacks/a13-c4.record.mjs'
import { recordForRunError, CALLER_HASH_FAILED_PREFIX } from './attacks/a13-c4.classify.mjs'

const BASE = {
  c4Status: 'quarantined',
  traceMatched: true,
  clockOrderOk: true,
  clockSkewCheckMs: 0.1,
  markerObservedAt: 100,
  callerHashStartAt: 100.05,
  unscorable: null,
  routed: { mutationApplied: true, label: 'A13-C4' },
  landings: [{ cls: 'in-model', forceScored: false }],
  scored: { lost: 1, changed: 0, vacuous: false },
}
const dec = (over) => decideRecord({ ...BASE, ...over })
const isHarnessError = (d, why) =>
  d.status === 'harness-error' &&
  d.mutationApplied === true &&
  d.harnessErrors.some((e) => e.startsWith(why))
const clean = (d) => d.status !== 'harness-error' && d.harnessErrors.length === 0

export function runRecordCases(check) {
  // --- baseline ---------------------------------------------------------------
  {
    const d = dec({})
    check(
      'record baseline: C4 status kept, mutationApplied from routing, nothing excluded',
      clean(d) &&
        d.status === 'quarantined' &&
        d.mutationApplied === true &&
        d.excludedReason === null,
      d
    )
  }

  // --- owner decision: vacuous runs excluded from the floor, still visible ----
  {
    const vac = { scored: { lost: 0, changed: 0, vacuous: true } }
    let d = dec(vac)
    check(
      "vacuous landed run: outcome.excludedReason 'vacuous-check', mutationApplied stays true",
      clean(d) && d.excludedReason === 'vacuous-check' && d.mutationApplied === true,
      d
    )
    d = dec({ scored: { lost: 0, changed: 0, vacuous: false } })
    check('control: non-vacuous landed run is not excluded', d.excludedReason === null, d)
    d = dec({ ...vac, routed: { mutationApplied: false, label: 'A13-C4' }, landings: [] })
    check('control: a non-landing is not marked vacuous-excluded', d.excludedReason === null, d)
  }

  // --- R2-10: racer clock skew (K3) -------------------------------------------
  {
    let d = dec({ clockSkewCheckMs: -49.9 })
    check(
      'skew -49.9 ms (racer clock +50 ms) -> harness-error, counted (mutationApplied true)',
      isHarnessError(d, 'clock-skew'),
      d
    )
    d = dec({ clockSkewCheckMs: SKEW_MIN_MS })
    check(`control: skew exactly ${SKEW_MIN_MS} ms is accepted`, clean(d), d)
    d = dec({ clockSkewCheckMs: SKEW_MIN_MS - 0.001 })
    check(
      'skew just below the lower tolerance -> harness-error',
      isHarnessError(d, 'clock-skew'),
      d
    )
    d = dec({ clockSkewCheckMs: SKEW_MAX_MS })
    check(`control: skew exactly ${SKEW_MAX_MS} ms is accepted`, clean(d), d)
    d = dec({ clockSkewCheckMs: SKEW_MAX_MS + 0.001 })
    check(
      'skew just above the upper tolerance -> harness-error',
      isHarnessError(d, 'clock-skew'),
      d
    )
    d = dec({ clockSkewCheckMs: null })
    check('skew unmeasured -> harness-error', isHarnessError(d, 'clock-skew'), d)
  }

  // --- R2-10: converted stamps early (K1) -------------------------------------
  {
    let d = dec({ callerHashStartAt: 99.9 })
    check(
      'converted callerHashStartAt before markerObservedAt -> harness-error, counted',
      isHarnessError(d, 'caller-hash-before-marker'),
      d
    )
    d = dec({ callerHashStartAt: 100 })
    check('control: callerHashStartAt == markerObservedAt is accepted', clean(d), d)
    d = dec({ callerHashStartAt: null })
    check(
      'callerHashStartAt unmeasured -> harness-error',
      isHarnessError(d, 'caller-hash-before-marker'),
      d
    )
  }

  // --- R2-10: post-rename landing with a loss is impossible -------------------
  {
    const pr = {
      routed: { mutationApplied: false, label: 'A13-C4' },
      landings: [{ cls: 'post-rename', forceScored: false }],
    }
    let d = dec({ ...pr, scored: { lost: 1, changed: 0, vacuous: false } })
    check(
      'post-rename landing with lost > 0 -> harness-error, counted',
      isHarnessError(d, 'impossible-post-rename-loss'),
      d
    )
    d = dec({ ...pr, scored: { lost: 0, changed: 1, vacuous: false } })
    check(
      'post-rename landing with changed > 0 -> harness-error, counted',
      isHarnessError(d, 'impossible-post-rename-loss'),
      d
    )
    d = dec({ ...pr, scored: { lost: 0, changed: 0, vacuous: false } })
    check(
      'control: post-rename landing with nothing lost stays a non-landing',
      clean(d) && d.mutationApplied === false,
      d
    )
  }

  // --- R2-11: every forced harness-error is counted ---------------------------
  {
    const none = {
      routed: { mutationApplied: false, label: 'A13-C4' },
      landings: [],
      scored: { lost: 0, changed: 0, vacuous: false },
    }
    let d = dec({ ...none, traceMatched: false })
    check(
      'trace mismatch on a no-landing run -> harness-error with mutationApplied true',
      isHarnessError(d, 'trace-mismatch'),
      d
    )
    d = dec({ ...none, clockOrderOk: false })
    check(
      'clock-order violation on a no-landing run -> harness-error with mutationApplied true',
      isHarnessError(d, 'clock-order'),
      d
    )
    d = dec(none)
    check(
      'control: a clean no-landing run keeps mutationApplied false (R6 non-landing)',
      clean(d) && d.mutationApplied === false,
      d
    )
  }

  // --- R2-7: the caller-hash race catch must be related -----------------------
  {
    const racer = {
      mutation: 'a5',
      steps: [{ op: 'unlink', path: '/fx/tree/target/orig-f1', startAt: 5, endAt: 6 }],
      failedStep: null,
      complete: true,
    }
    const base = {
      candidate: 'C4',
      markerObservedAt: 1,
      durationMs: 2,
      quarantineLeft: { dirs: null },
      scored: { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 },
      racer,
    }
    const hashErr = () => new Error(`${CALLER_HASH_FAILED_PREFIX} on the fixture: {"ok":false}`)
    const attempt = (args) => {
      try {
        return { rec: recordForRunError(args), thrown: null }
      } catch (e) {
        return { rec: null, thrown: e }
      }
    }
    let r = attempt({ ...base, err: hashErr(), callerHashWindow: { startAt: 4, endAt: 7 } })
    check(
      'caller-hash race: related (first step inside the caller-hash window) -> record',
      r.rec !== null,
      r.thrown && String(r.thrown.message)
    )
    r = attempt({ ...base, err: hashErr(), callerHashWindow: { startAt: 6, endAt: 7 } })
    check(
      'control: first step touching the window start (closed overlap) -> record',
      r.rec !== null,
      r.thrown && String(r.thrown.message)
    )
    const late = { ...racer, steps: [{ ...racer.steps[0], startAt: 5004, endAt: 5005 }] }
    const unrelatedErr = hashErr()
    r = attempt({
      ...base,
      racer: late,
      err: unrelatedErr,
      callerHashWindow: { startAt: 4, endAt: 7 },
    })
    check(
      'caller-hash failure with the racer landing 5 s later rethrows (unrelated)',
      r.thrown === unrelatedErr,
      r.rec && r.rec.outcome
    )
    const fake = { toString: () => `${CALLER_HASH_FAILED_PREFIX} forged` }
    r = attempt({ ...base, err: fake, callerHashWindow: { startAt: 4, endAt: 7 } })
    check(
      'non-Error whose toString carries the prefix rethrows',
      r.thrown === fake,
      r.rec && r.rec.outcome
    )
    const noWindow = hashErr()
    r = attempt({ ...base, err: noWindow })
    check(
      'caller-hash failure without a measured window rethrows (fail-closed)',
      r.thrown === noWindow,
      r.rec && r.rec.outcome
    )
  }
}
