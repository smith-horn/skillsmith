// Cases for harness/a13-c4.selftest.mjs (split out to keep each file under
// the 500-line limit; run through that file, not directly). Synthetic inputs
// only: the step racer's report, the window times, and fake filesystem
// probes. Covers review R1-F1 (partial runs are landings, scored from
// observed effects) and R1-F3 (classification from the destructive step's
// own interval), the hash override, and the caller-hash-race record. Each
// behaviour has a positive case and a control differing in one input.

import {
  windowEnds,
  deriveHashEvidence,
  landingFromRacer,
  routeRun,
  landingCounts,
  recordForRunError,
  CALLER_HASH_FAILED_PREFIX,
  CALLER_HASH_RACE_REASON,
} from './attacks/a13-c4.classify.mjs'
import { expectationsFromSteps, scoreExpectations } from './attacks/a13-c4.score.mjs'

const T = '/fx/tree'
const TARGET = `${T}/target`
const FILE = `${TARGET}/orig-f1`
const ASIDE = `${TARGET}.aside-ab12`
const ORIG = 'original-content-f1'
const USER = 'racer-a5-user-bytes'

// C4 window: callerHashAt 10, recheck 20, rename call 21..22.
const C4_TIMES = {
  callerHashAt: 10,
  recheckAt: 20,
  renameAt: 21,
  renameReturnedAt: 22,
  callEndAt: 25,
}
const ENDS = windowEnds('C4', C4_TIMES)

const st = (op, path, startAt, endAt, more = {}) => ({ op, path, startAt, endAt, ...more })
const failed = (op, path, at) => ({ op, path, startAt: at, endAt: at + 0.1, error: 'ENOENT' })
const racerOf = (mutation, steps, failedStep = null) => ({
  mutation,
  steps,
  failedStep,
  complete: failedStep === null && steps.length > 0,
})
const land = (racer, proven = false, differs = false) =>
  landingFromRacer({
    racer,
    callerHashAt: C4_TIMES.callerHashAt,
    ...ENDS,
    provenPreCallerHash: proven,
    movedTreeDiffersFromCallerHash: differs,
  })

/** A fake probe over a {rel: {kind, content?, linkText?}} map. */
const probeOf = (entries) => (rel) => entries[rel] ?? null
const score = (steps, origin, dest) =>
  scoreExpectations({
    expectations: expectationsFromSteps(steps, T),
    probeOrigin: probeOf(origin),
    probeDest: dest === null ? null : probeOf(dest),
  })
const throws = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

// The two partial shapes the review named, as the racer reports them.
const A5_RM_THEN_MKDIR_ENOENT = racerOf(
  'a5',
  [st('unlink', FILE, 12, 12.1), st('rmdir', TARGET, 12.2, 12.3)],
  failed('mkdir', TARGET, 23)
)
const A3_ASIDE_THEN_MKDIR_ENOENT = racerOf(
  'a3',
  [st('rename', TARGET, 12, 12.5, { dest: ASIDE, moved: { 'orig-f1': ORIG } })],
  failed('mkdir', TARGET, 23)
)

export function runLandingCases(check) {
  // --- R1-F1: a partial run is a landing ------------------------------------
  {
    const [l] = land(A5_RM_THEN_MKDIR_ENOENT)
    check(
      'partial a5 (rm landed, mkdir ENOENT) is a landing, scored',
      l?.partial === true && routeRun(l ? [l] : []).mutationApplied === true,
      l
    )
    const none = land(racerOf('a5', [], failed('unlink', FILE, 12)))
    check(
      'control: no completed step (first step ENOENT) -> no landing, R6 non-landing',
      none.length === 0 && routeRun(none).mutationApplied === false,
      none
    )
    const [a] = land(A3_ASIDE_THEN_MKDIR_ENOENT)
    check(
      'partial a3 (rename-aside landed, mkdir ENOENT) is a landing, scored',
      a?.partial === true &&
        a?.destructiveOp === 'rename' &&
        routeRun(a ? [a] : []).mutationApplied === true,
      a
    )
    const early = racerOf(
      'a3',
      [st('rename', TARGET, 8, 9, { dest: ASIDE, moved: { 'orig-f1': ORIG } })],
      failed('mkdir', TARGET, 23)
    )
    const [f] = land(early)
    check(
      'partial whose destructive step timestamps pre-caller-hash is still scored (forceScored)',
      f?.cls === 'pre-caller-hash' &&
        f?.forceScored === true &&
        routeRun(f ? [f] : []).mutationApplied === true &&
        routeRun(f ? [f] : []).label === 'A13-C4',
      f
    )
    const [c] = land(
      racerOf(
        'a3',
        early.steps.concat([
          st('mkdir', TARGET, 9.1, 9.2),
          st('write', `${TARGET}/orig-f1`, 9.3, 9.4, { content: USER }),
        ])
      )
    )
    check(
      'control: the same timing on a COMPLETE run is irrelevant (R6 non-landing)',
      c?.cls === 'pre-caller-hash' &&
        c?.forceScored === false &&
        routeRun(c ? [c] : []).mutationApplied === false,
      c
    )
    const [p] = land(A3_ASIDE_THEN_MKDIR_ENOENT, true)
    check(
      'hash override is NOT applied to a partial run',
      p?.evidence === 'timestamp' && p?.cls === 'in-model',
      p
    )
    check(
      'unknown racer report (steps null) throws, never "no landing"',
      throws(() => land({ mutation: 'a3', steps: null, failedStep: null })) instanceof TypeError
    )
  }

  // --- R1-F3: the destructive step's own interval -----------------------------
  {
    const steps = [st('unlink', FILE, 19.5, 19.9), st('rmdir', TARGET, 20.5, 21)]
    const [l] = land(
      racerOf('a8', steps.concat([st('symlink', TARGET, 21.1, 21.2, { linkText: '/tmp' })]))
    )
    check(
      'classified from the first step alone: whole-mutation straddle is not a destructive straddle',
      l?.cls === 'in-model' && l?.straddlesInModelEnd === false && l?.straddles === false,
      l
    )
    const [s] = land(
      racerOf('a8', [st('unlink', FILE, 19.5, 20.5), st('rmdir', TARGET, 20.6, 20.7)])
    )
    check(
      'control: destructive step itself crosses recheckAt -> straddlesInModelEnd, still scored',
      s.straddlesInModelEnd === true &&
        s.cls === 'in-model' &&
        routeRun(s ? [s] : []).label === 'A13-C4',
      s
    )
    check(
      'landingCounts carries the straddle count',
      landingCounts([l, s].filter(Boolean)).straddlesInModelEnd === 1
    )
    const [o] = land(racerOf('a8', [st('unlink', FILE, 20.2, 20.4)]))
    check(
      'destructive step wholly after recheckAt -> out-of-model -> A13-C4-OOM',
      routeRun(o ? [o] : []).label === 'A13-C4-OOM',
      o
    )
  }

  // --- pre-caller-hash needs the WHOLE mutation (found by smoke) -------------
  {
    const a7 = (writeEnd) =>
      racerOf('a7', [st('unlink', FILE, 8, 9), st('write', FILE, 9.5, writeEnd, { content: USER })])
    const [w] = land(a7(10.5))
    check(
      'a7 unlink before callerHashAt, write after -> in-model (last-step-after-caller-hash), scored',
      w?.cls === 'in-model' &&
        w?.evidence === 'last-step-after-caller-hash' &&
        routeRun(w ? [w] : []).mutationApplied === true,
      w
    )
    const [wc] = land(a7(9.9))
    check(
      'control: every step before callerHashAt -> pre-caller-hash, R6 non-landing',
      wc?.cls === 'pre-caller-hash' &&
        wc?.evidence === 'timestamp' &&
        routeRun(wc ? [wc] : []).mutationApplied === false,
      wc
    )
    const [h] = land(a7(9.9), false, true)
    check(
      'all steps timestamp before callerHashAt but moved tree differs -> in-model by hash, scored',
      h?.cls === 'in-model' &&
        h?.evidence === 'hash-moved-tree-differs' &&
        routeRun(h ? [h] : []).mutationApplied === true,
      h
    )
  }

  // --- R1-F1: scoring from observed effects -----------------------------------
  {
    let s = score(A5_RM_THEN_MKDIR_ENOENT.steps, {}, null)
    check(
      'score partial a5 rm-only: checked 1 (vacuous absent), lost 0, displaced 0, deleted 0',
      s.checked === 1 && s.vacuous === true && s.lost === 0 && s.displaced === 0 && s.deleted === 0,
      s
    )
    s = score(A5_RM_THEN_MKDIR_ENOENT.steps, { target: { kind: 'dir' } }, null)
    check('control: something back at the deleted path -> changed', s.changed === 1, s)

    const mk = A5_RM_THEN_MKDIR_ENOENT.steps.concat([st('mkdir', TARGET, 12.4, 12.5)])
    s = score(mk, {}, { target: { kind: 'dir' } })
    check(
      'score partial a5 rm+mkdir, write ENOENT: user dir in trash -> displaced 1',
      s.checked === 1 && s.lost === 1 && s.displaced === 1 && s.deleted === 0,
      s
    )
    s = score(mk, {}, null)
    check(
      'control: same dir nowhere -> deleted 1',
      s.lost === 1 && s.deleted === 1 && s.displaced === 0,
      s
    )

    const asideRel = 'target.aside-ab12/orig-f1'
    s = score(A3_ASIDE_THEN_MKDIR_ENOENT.steps, {}, { [asideRel]: { kind: 'file', content: ORIG } })
    check(
      'score partial a3 rename-aside: renamed-aside original in trash -> displaced 1',
      s.checked === 1 && s.lost === 1 && s.displaced === 1 && s.deleted === 0,
      s
    )
    s = score(
      A3_ASIDE_THEN_MKDIR_ENOENT.steps,
      {},
      { [asideRel]: { kind: 'file', content: 'other' } }
    )
    check(
      'control: same path in trash with other content -> deleted (exact content required)',
      s.deleted === 1 && s.displaced === 0,
      s
    )
    s = score(
      A3_ASIDE_THEN_MKDIR_ENOENT.steps,
      { [asideRel]: { kind: 'file', content: ORIG } },
      null
    )
    check(
      'control: aside intact at its original location -> nothing lost',
      s.lost === 0 && s.changed === 0 && s.checked === 1,
      s
    )

    const full = A3_ASIDE_THEN_MKDIR_ENOENT.steps.concat([
      st('mkdir', TARGET, 12.6, 12.7),
      st('write', FILE, 12.8, 12.9, { content: USER }),
    ])
    s = score(
      full,
      {},
      {
        [asideRel]: { kind: 'file', content: ORIG },
        'target/orig-f1': { kind: 'file', content: USER },
      }
    )
    check(
      'complete a3 moved: two user files (dir implied), both displaced',
      s.checked === 2 && s.displaced === 2,
      s
    )

    const a8 = [
      st('unlink', FILE, 1, 2),
      st('rmdir', TARGET, 3, 4),
      st('symlink', TARGET, 5, 6, { linkText: '/tmp' }),
    ]
    s = score(a8, {}, { target: { kind: 'symlink', linkText: '/tmp' } })
    check('complete a8: symlink in trash -> displaced', s.checked === 1 && s.displaced === 1, s)
    s = score(a8, {}, { target: { kind: 'symlink', linkText: '/etc' } })
    check('control: symlink with other link text -> deleted', s.deleted === 1, s)

    check(
      'rename step without its moved pre-state throws (unscorable)',
      throws(() => expectationsFromSteps([st('rename', TARGET, 1, 2, { dest: ASIDE })], T)) !== null
    )
    check(
      'step path outside the tree throws (unscorable)',
      throws(() => expectationsFromSteps([st('unlink', '/elsewhere/x', 1, 2)], T)) !== null
    )
    check(
      'unknown step op throws (unscorable)',
      throws(() => expectationsFromSteps([st('chmod', FILE, 1, 2)], T)) !== null
    )
  }

  // --- hash override --------------------------------------------------------
  {
    const racer = racerOf('a8', [
      st('unlink', FILE, 9, 11),
      st('rmdir', TARGET, 11.1, 11.2),
      st('symlink', TARGET, 11.3, 11.4, { linkText: '/tmp' }),
    ])
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
    const [fired] = land(racer, fire.provenPreCallerHash)
    check(
      'hash override FIRES: timestamp in-model reclassified pre-caller-hash by hash',
      fired?.cls === 'pre-caller-hash' &&
        fired?.evidence === 'hash' &&
        fired?.timestampCls === 'in-model',
      fired
    )
    check(
      'hash override routes the run out of the denominator',
      routeRun(fired ? [fired] : []).mutationApplied === false
    )
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
    const [notFired] = land(racer, differ.provenPreCallerHash)
    check(
      'hash override does NOT fire when moved tree differs: stays in-model by timestamp',
      notFired?.cls === 'in-model' && notFired?.evidence === 'timestamp',
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
  }

  // --- caller-hash-race record ------------------------------------------------
  {
    const base = {
      candidate: 'C4',
      markerObservedAt: 1,
      durationMs: 2,
      quarantineLeft: { dirs: null },
      // Covers the active racer's first step (3..4); R2-7 relatedness.
      callerHashWindow: { startAt: 2, endAt: 5 },
    }
    const hashErr = new Error(`${CALLER_HASH_FAILED_PREFIX} on the fixture: {"ok":false}`)
    const active = racerOf('a5', [st('unlink', FILE, 3, 4)], failed('rmdir', TARGET, 5))
    const clean = { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 }
    // A throw must surface as FAIL lines, not crash the selftest.
    const tryRec = (args) => {
      try {
        return recordForRunError(args)
      } catch (thrown) {
        return {
          outcome: {},
          precondition: {},
          extra: {},
          thrown: String(thrown && thrown.message),
        }
      }
    }
    const rec = tryRec({ ...base, err: hashErr, racer: active, scored: clean })
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
      'caller-hash race: label A13-C4, variant fixed, racer steps kept',
      rec.extra.label === 'A13-C4' &&
        rec.extra.variant === 'racer/by-timestamp' &&
        rec.extra.racerSteps === active.steps,
      rec.extra.label
    )
    const lossy = tryRec({
      ...base,
      err: hashErr,
      racer: active,
      scored: { ...clean, lost: 1, deleted: 1 },
    })
    check(
      'caller-hash race with an observed loss is NOT exempt: mutationApplied true',
      lossy.precondition.mutationApplied === true && /unexplained-loss/.test(lossy.outcome.reason),
      lossy.outcome
    )
    const unsc = tryRec({ ...base, err: hashErr, racer: active, scored: null })
    check(
      'caller-hash race that could not be scored is NOT exempt',
      unsc.precondition.mutationApplied === true,
      unsc.precondition
    )

    let e = throws(() =>
      recordForRunError({
        ...base,
        err: hashErr,
        racer: racerOf('a5', [], failed('unlink', FILE, 3)),
        scored: clean,
      })
    )
    check(
      'caller-hash failure WITHOUT racer activity still throws (the same error)',
      e === hashErr,
      e && e.message
    )
    e = throws(() =>
      recordForRunError({ ...base, err: hashErr, racer: { steps: null }, scored: clean })
    )
    check('control: unknown racer report also rethrows', e === hashErr, e && e.message)
    const other = new Error(
      'runC4Candidate: fs.lstatSync is already interposed on entry; refusing to run'
    )
    e = throws(() => recordForRunError({ ...base, err: other, racer: active, scored: clean }))
    check(
      'control: a different runC4Candidate error rethrows even with racer activity',
      e === other,
      e && e.message
    )
    e = throws(() => recordForRunError({ ...base, err: 'x', racer: active, scored: clean }))
    check('control: a non-Error throw rethrows', e === 'x', e)
  }
}
