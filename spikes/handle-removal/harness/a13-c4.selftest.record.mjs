// Round-2 cases for harness/a13-c4.selftest.mjs (run through that file):
// record-level decisions (attacks/a13-c4.record.mjs) and the caller-hash race
// catch's relatedness check (attacks/a13-c4.classify.mjs). Owner decision on
// vacuous checks; review R2-7, R2-10 (K1/K3) and R2-11 (K2). Each rule has a
// positive case and a control that differs in one input.

import {
  decideRecord,
  clockOrderOk,
  callerHashWindowFrom,
  treeChangedAfterCallerHash,
  SKEW_MIN_MS,
  SKEW_MAX_MS,
} from './attacks/a13-c4.record.mjs'
import {
  recordForRunError,
  landingFromRacer,
  windowEnds,
  routeRun,
  CALLER_HASH_FAILED_PREFIX,
} from './attacks/a13-c4.classify.mjs'

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
    const early = { ...racer, steps: [{ ...racer.steps[0], startAt: 1, endAt: 2 }] }
    const earlyErr = hashErr()
    r = attempt({
      ...base,
      racer: early,
      err: earlyErr,
      callerHashWindow: { startAt: 4, endAt: 7 },
    })
    check(
      'rt3: racer step ENDED before the caller hash started (1..2 vs 4..7) rethrows (R2-7 lower bound)',
      r.thrown === earlyErr,
      r.rec && r.rec.outcome
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

  // --- governance round 3 -----------------------------------------------------
  {
    // G3-2: a FAILED vacuous check is a loss, never excluded from the floor.
    let d = dec({ scored: { lost: 0, changed: 1, vacuous: true } })
    check(
      'G3-2: vacuous check that failed (changed 1) is NOT excluded from the floor',
      d.excludedReason === null && d.mutationApplied === true,
      d
    )
    d = dec({ scored: { lost: 0, changed: 0, vacuous: true } })
    check(
      "G3-2 control: vacuous check that held is excluded ('vacuous-check')",
      d.excludedReason === 'vacuous-check',
      d
    )

    // G3-8: a missing converted stamp fails the clock-order check.
    check(
      'G3-8: missing callEndAt fails clockOrderOk',
      clockOrderOk({ callEndAt: null, callReturnedAtH: 10 }) === false
    )
    check(
      'G3-8: non-numeric callEndAt fails clockOrderOk',
      clockOrderOk({ callEndAt: undefined, callReturnedAtH: 10 }) === false
    )
    check(
      'G3-8 control: callEndAt before the return passes',
      clockOrderOk({
        callerHashStartAt: 1,
        callAttemptAtH: 1,
        callEndAt: 9,
        callReturnedAtH: 10,
        ...{},
      }) === true
    )
    check(
      'G3-8 control: callEndAt after the return fails',
      clockOrderOk({ callEndAt: 10.02, callReturnedAtH: 10 }) === false
    )
    d = dec({ clockOrderOk: clockOrderOk({ callEndAt: null, callReturnedAtH: 10 }) })
    check(
      'G3-8: a missing stamp makes the run a counted harness-error',
      isHarnessError(d, 'clock-order'),
      d
    )

    // G3-7: c4-shared's own stamps on the error are taken, converted to hrtime.
    const err = Object.assign(new Error('x'), {
      callerHashStartAt: 1.7e12 + 5,
      callerHashAt: 1.7e12 + 6,
    })
    const w = callerHashWindowFrom(err, { offset: -1.7e12 + 100, callAttemptAtH: 1, catchAtH: 999 })
    check(
      "G3-7: error carrying c4-shared stamps -> window from them, source 'c4-shared', converted",
      w.source === 'c4-shared' && w.startAt === 105 && w.endAt === 106,
      w
    )
    const b = callerHashWindowFrom(new Error('x'), { offset: 0, callAttemptAtH: 1, catchAtH: 999 })
    check(
      "G3-7 control: plain error -> this process's call bracket",
      b.source === 'call-bracket' && b.startAt === 1 && b.endAt === 999,
      b
    )
    const half = Object.assign(new Error('x'), { callerHashStartAt: 1.7e12 + 5 })
    check(
      'G3-7 control: only one stamp present -> call bracket, not a half window',
      callerHashWindowFrom(half, { offset: 0, callAttemptAtH: 1, catchAtH: 999 }).source ===
        'call-bracket'
    )
  }

  // --- landings during the caller's own hash (found at --dirs 200) ----------
  {
    // The caller hash runs 6..10 (it takes ~10 ms at 200 dirs).
    const T = {
      callerHashStartAt: 6,
      callerHashAt: 10,
      recheckAt: 20,
      renameAt: 21,
      renameReturnedAt: 22,
      callEndAt: 25,
    }
    const E = windowEnds('C4', T)
    const F = '/fx/tree/target/orig-f1'
    const racer = (s0, e0, s1, e1) => ({
      mutation: 'a7',
      steps: [
        { op: 'unlink', path: F, startAt: s0, endAt: e0 },
        { op: 'write', path: F, startAt: s1, endAt: e1, content: 'u' },
      ],
      failedStep: null,
    })
    const L = (r, proven = false, differs = false) =>
      landingFromRacer({
        racer: r,
        callerHashStartAt: T.callerHashStartAt,
        callerHashAt: T.callerHashAt,
        ...E,
        provenPreCallerHash: proven,
        movedTreeDiffersFromCallerHash: differs,
      })[0]
    let l = L(racer(7, 7.1, 7.2, 7.3))
    check(
      'mutation landed DURING the caller hash, no hash proof -> in-model (landed-during-caller-hash), scored',
      l?.cls === 'in-model' &&
        l?.evidence === 'landed-during-caller-hash' &&
        routeRun(l ? [l] : []).mutationApplied === true,
      l
    )
    l = L(racer(4, 4.1, 4.2, 5.9))
    check(
      'control: mutation complete before the caller hash STARTED -> pre-caller-hash',
      l?.cls === 'pre-caller-hash' && routeRun(l ? [l] : []).mutationApplied === false,
      l
    )
    l = L(racer(7, 7.1, 7.2, 7.3), true)
    check(
      'control: landed during the caller hash WITH hash proof -> pre-caller-hash (hash)',
      l?.cls === 'pre-caller-hash' && l?.evidence === 'hash',
      l
    )
    l = L({ ...racer(4, 4.1, 4.2, 5.9) })
    const lMissing = landingFromRacer({
      racer: racer(4, 4.1, 4.2, 5.9),
      callerHashAt: 10,
      ...E,
      provenPreCallerHash: false,
      movedTreeDiffersFromCallerHash: false,
    })[0]
    check(
      'missing callerHashStartAt -> cannot prove pre-caller-hash, scored (fail-closed)',
      lMissing?.cls === 'in-model',
      lMissing
    )

    // C4's own outcome is clock-independent evidence the tree changed after the caller hashed.
    const t = (o) =>
      treeChangedAfterCallerHash({ destPath: null, movedTreeMatchesCallerHash: false, ...o })
    check(
      "C4 'kept' (its hash or identity check saw a change) -> changed after the caller hash",
      t({ c4Status: 'kept', c4Reason: 'identity-changed' }) === true
    )
    check(
      "C4 'stopped' by its own hash read (guard-unreadable) -> changed after the caller hash",
      t({ c4Status: 'stopped', c4Reason: 'guard-unreadable' }) === true
    )
    check(
      "control: 'stopped' at the rename (quarantine-failed) is not hash evidence",
      t({ c4Status: 'stopped', c4Reason: 'quarantine-failed' }) === false
    )
    check(
      'control: moved tree matching the caller hash -> not changed',
      t({ c4Status: 'quarantined', destPath: '/d', movedTreeMatchesCallerHash: true }) === false
    )
    check(
      'moved tree differing from the caller hash -> changed',
      t({ c4Status: 'quarantined', destPath: '/d', movedTreeMatchesCallerHash: false }) === true
    )
  }

  // --- rt3: SHIFTED converted stamps (not just missing ones) ----------------
  {
    const ok = (o) =>
      clockOrderOk({
        callerHashStartAt: 1,
        callAttemptAtH: 1,
        callEndAt: 9,
        callReturnedAtH: 10,
        ...o,
      })
    check(
      'rt3: callEndAt 0.02 ms AFTER callReturnedAtH (stamps shifted late) fails',
      ok({ callEndAt: 10.02 }) === false
    )
    check(
      'rt3 control: callEndAt exactly at the 0.01 ms tolerance passes',
      ok({ callEndAt: 10.01 }) === true
    )
    check(
      'rt3: callerHashStartAt 0.02 ms BEFORE callAttemptAtH (stamps shifted early) fails',
      ok({ callerHashStartAt: 0.98 }) === false
    )
    check(
      'rt3 control: callerHashStartAt exactly at the 0.01 ms tolerance passes',
      ok({ callerHashStartAt: 0.99 }) === true
    )
    check('rt3: missing callAttemptAtH fails (fail-closed)', ok({ callAttemptAtH: null }) === false)
    let d = dec({ clockOrderOk: ok({ callEndAt: 10.02 }) })
    check(
      'rt3: a late-shifted stamp makes the run a counted harness-error',
      isHarnessError(d, 'clock-order'),
      d
    )
    d = dec({ clockOrderOk: ok({ callerHashStartAt: 0.98 }) })
    check(
      'rt3: an early-shifted stamp makes the run a counted harness-error',
      isHarnessError(d, 'clock-order'),
      d
    )
  }
}
