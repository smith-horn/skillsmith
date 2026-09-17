// SMI-6676: the plan §9 cell-verdict rule's missing half, made executable.
//
// The plan says a cell is PASS "only when ran == target, never-ran == 0 and
// failed == 0, AND the attack's control cell on the same filesystem recorded
// failed >= 1", and "if the control didn't fail, the fixture is invalid: the
// cell is NEVER-RAN (control)". `aggregateCell()` has always implemented the
// second half -- it takes a `controlFailed` option -- but until this module
// existed, nothing supplied it: run-a3-a13-attacks.mjs and run-n1-vr.mjs
// omitted it entirely (so `options.controlFailed === undefined`, which is not
// `=== false`, so the NEVER-RAN (control) branch could never be reached), and
// run-vr-attacks.mjs hardcoded `controlFailed: true`. results/SUMMARY.md's
// generator had its own verdict() that ignored control altogether. The
// harness could therefore never have reported an uncontrolled cell, so
// "exactly one uncontrolled cell" was a claim its own instrument was
// incapable of contradicting.
//
// This module holds one machine-readable row per attack, transcribed from the
// plan's §5.1 "Control expected to fail" column, and resolves it against the
// cells actually present. It never guesses: an attack whose plan-named
// control is a script or a cited earlier experiment rather than a cell in the
// JSONL resolves to `external`, which is reported as unverifiable-here rather
// than quietly counted as satisfied.

/**
 * @typedef {{attack:string, variant:string|null, candidate:string, fs:string,
 *            failed:number}} CellRow
 */

/** Everything before the first '/' in a compound variant tag ('inner/none' -> 'inner'). */
function headVariant(v) {
  return v == null ? null : String(v).split('/')[0]
}

/**
 * One row per attack label as it appears in the DATA (not the plan's own ID,
 * which the runners split -- e.g. plan A9 is recorded as A9-C0 and A9-VR).
 *
 * `control` is one of:
 *   {kind:'in-data', candidate, matchVariant:'exact'|'head'|'none', cite}
 *   {kind:'external', cite}   -- a real control that exists, but not as a cell
 *   {kind:'none', cite}       -- the plan says no control is required
 * `isControlCandidate(candidate)` marks cells that ARE controls, which carry
 * no control requirement of their own.
 */
export const CONTROL_SPEC = {
  A1: {
    control: {
      kind: 'external',
      cite: "plan §5.1 A1: 'C0 without the rmdir probe (empty-first walk); GNU rm same-fs bind' -- neither exists as a cell; the GNU rm run is results/raw/gnurm-control-overlayfs.txt",
    },
  },
  A2: {
    control: { kind: 'in-data', candidate: 'c0', matchVariant: 'none', cite: 'plan §5.1 A2' },
  },
  A3: {
    control: {
      kind: 'in-data',
      candidate: 'baseline',
      matchVariant: 'none',
      cite: "plan §5.1 A3: 'C0 without UD24'",
    },
    isControlCandidate: (c) => c === 'baseline',
  },
  A4: {
    control: {
      kind: 'in-data',
      candidate: 'baseline',
      matchVariant: 'none',
      cite: "plan §5.1 A4: 'C0 without UD24'",
    },
    isControlCandidate: (c) => c === 'baseline',
  },
  A5: {
    control: {
      kind: 'in-data',
      candidate: 'ud24Only',
      matchVariant: 'none',
      cite: "plan §5.1 A5: 'C0 without the gate'",
    },
    isControlCandidate: (c) => c === 'ud24Only',
  },
  'A5-VR': {
    control: {
      kind: 'in-data',
      candidate: 'ud24Only',
      matchVariant: 'none',
      cite: "plan §5.1 A5: 'C0 without the gate'",
      fromAttack: 'A5',
    },
  },
  A6: {
    control: {
      kind: 'in-data',
      candidate: 'ud24Only',
      matchVariant: 'head',
      cite: "plan §5.1 A6: 'C0 with the gate at walk start'",
    },
    isControlCandidate: (c) => c === 'ud24Only' || c === 'ud25WalkStart',
  },
  'A6-VR': {
    control: {
      kind: 'in-data',
      candidate: 'ud24Only',
      matchVariant: 'head',
      cite: 'plan §5.1 A6',
      fromAttack: 'A6',
    },
  },
  A7: {
    control: {
      kind: 'in-data',
      candidate: 'V0',
      matchVariant: 'exact',
      cite: "plan §5.1 A7: 'V0 (expected to delete the substitute)'",
    },
    isControlCandidate: (c) => c === 'V0',
  },
  A8: {
    control: {
      kind: 'external',
      cite: "plan §5.1 A8: 'macOS /bin/rm -r (F2 B: 3/3 deleted)' -- feasibility/c3/check2-mac.sh, macOS-only, and it has no case matching subcase (b) at all",
    },
  },
  'A9-C0': {
    isControlCandidate: () => true,
    control: { kind: 'none', cite: "plan §5.1 A9: A9-C0 IS the control ('C0 under stub (a)')" },
  },
  'A9-VR': {
    control: {
      kind: 'in-data',
      candidate: 'C0',
      matchVariant: 'head',
      cite: "plan §5.1 A9: 'C0 under stub (a)'",
      fromAttack: 'A9-C0',
    },
  },
  'A10-C0': {
    control: {
      kind: 'external',
      cite: "plan §5.1 A10: 'C3 (no guard)' -- C3 was never built in this spike",
    },
  },
  'A10-VR': {
    control: {
      kind: 'external',
      cite: "plan §5.1 A10: 'C3 (no guard)' -- C3 was never built in this spike",
    },
  },
  A11: { control: { kind: 'none', cite: "plan §5.1 A11: 'none (property check)'" } },
  A12: {
    control: {
      kind: 'in-data',
      candidate: 'control-continues-past-errors',
      matchVariant: 'exact',
      cite: "plan §5.1 A12: 'a walk that continues past errors; GNU rm (F1)'",
    },
    isControlCandidate: (c) => c === 'control-continues-past-errors',
  },
  A13: {
    control: {
      kind: 'in-data',
      candidate: 'baseline',
      matchVariant: 'none',
      cite: "plan §5.1 A13: 'C0 without UD24'",
      fromAttack: 'A3',
    },
  },
  'A13-TIMING': {
    control: {
      kind: 'in-data',
      candidate: 'baseline',
      matchVariant: 'none',
      cite: "plan §5.1 A13: 'C0 without UD24'",
      fromAttack: 'A3',
    },
  },
  // The two rows below are METHODOLOGY EXPERIMENTS, not attacks on a candidate.
  // They exist to measure the INSTRUMENT -- whether the guarded and unguarded
  // arms were run under comparable timing, and whether the quarantine scanner
  // detects stranding -- so §5.1's control clause does not apply to them and
  // `unspecified` would misreport that as a gap.
  //
  // They are declared here so they carry an honest label, NOT so they can be
  // read as criterion-1 evidence. A13-WARMARM alone is larger than the entire
  // rest of the corpus, so any tally that sums it together with attack cells is
  // meaningless -- the memo's own "sums across cells are not sound" rule, with a
  // sharper edge.
  'A13-VALIDATE': {
    control: {
      kind: 'none',
      cite: 'methodology experiment (quarantineLeft instrument validation), not a §5.1 attack cell',
    },
  },
  'A13-WARMARM': {
    control: {
      kind: 'none',
      cite: 'methodology experiment (arm-C warming confound), not a §5.1 attack cell',
    },
  },
  N1: { control: { kind: 'external', cite: "plan §5.1 N1: 'gate B (E48) for C0 only'" } },
  'N1-VR': {
    control: {
      kind: 'none',
      cite: 'plan §5.1 N1 names a control for C0 only; none is defined for VR',
    },
  },
}

/**
 * Resolves one cell's control status against every cell in the run.
 *
 * @param {CellRow} row
 * @param {CellRow[]} allRows
 * @returns {{state:'is-control'|'satisfied'|'did-not-fail'|'absent'|'external'|'none'|'unspecified',
 *            detail:string}}
 */
export function resolveControl(row, allRows) {
  const spec = CONTROL_SPEC[row.attack]
  if (!spec) {
    return {
      state: 'unspecified',
      detail: `no control row for attack ${row.attack} in CONTROL_SPEC`,
    }
  }
  if (spec.isControlCandidate && spec.isControlCandidate(row.candidate)) {
    return { state: 'is-control', detail: 'this cell is itself the control' }
  }
  const c = spec.control
  if (c.kind === 'none') return { state: 'none', detail: c.cite }
  if (c.kind === 'external') return { state: 'external', detail: c.cite }

  const wantAttack = c.fromAttack ?? row.attack
  const matches = allRows.filter((r) => {
    if (r.attack !== wantAttack) return false
    if (r.fs !== row.fs) return false
    if (r.candidate !== c.candidate) return false
    if (c.matchVariant === 'exact') return r.variant === row.variant
    if (c.matchVariant === 'head') return headVariant(r.variant) === headVariant(row.variant)
    return true
  })
  if (matches.length === 0) {
    return {
      state: 'absent',
      detail: `${c.cite} -- no ${wantAttack}/${c.candidate} cell exists on ${row.fs}`,
    }
  }
  const failed = matches.reduce((n, r) => n + r.failed, 0)
  return failed >= 1
    ? { state: 'satisfied', detail: `${wantAttack}/${c.candidate} on ${row.fs} failed ${failed}` }
    : {
        state: 'did-not-fail',
        detail: `${c.cite} -- ${wantAttack}/${c.candidate} on ${row.fs} recorded 0 failures`,
      }
}

/**
 * The `controlFailed` value `aggregateCell()` expects, from a resolved state.
 * `undefined` means "no control requirement applies"; `false` means
 * "a control was required and did not demonstrate the loss".
 *
 * `external` deliberately maps to `undefined`, not `true`: the plan's control
 * for those rows is real but lives outside the JSONL, so this harness can
 * neither confirm nor refute it, and saying `true` would launder an unchecked
 * citation into a machine-verified fact. Those cells are reported separately
 * (see generate-summary.mjs's Control column) rather than silently passed.
 */
export function controlFailedFlag(state) {
  if (state === 'satisfied') return true
  if (state === 'did-not-fail' || state === 'absent') return false
  return undefined
}

/** Short tag for a report column. */
export function controlTag(state) {
  return {
    'is-control': 'is-control',
    satisfied: 'ok',
    'did-not-fail': 'DID-NOT-FAIL',
    absent: 'ABSENT',
    external: 'external-unverified',
    none: 'none-by-design',
    unspecified: 'UNSPECIFIED',
  }[state]
}

/**
 * ATTACKS THAT ARE PROBABILISTIC BY SPECIFICATION (owner decision, R6,
 * 2026-09-16).
 *
 * §10 criterion 1 required every A13 cell to PASS; §9 defined PASS as requiring
 * `never-ran == 0`; §5.1 specified A13 as a probabilistic racer. Those three
 * could not hold together -- A13 could not reach PASS against ANY candidate,
 * including a perfect one, because a racer that sometimes fails to land makes
 * `never-ran > 0` by construction. The scored guarded cell demonstrated it:
 * V2 + guardHash on overlayfs recorded 0 failures in 117 landed races and still
 * scored NEVER-RAN, purely because the racer did not land in the other 183.
 *
 * The owner chose: score a probabilistic attack on the LANDED SUBSET. A run
 * where the racer did not land leaves the denominator rather than counting
 * against the cell.
 *
 * THE FLOOR EXISTS SO THAT CANNOT BE GAMED. Without it a cell that landed twice
 * and lost nothing would PASS, which is worse than the rule it replaces. 100 is
 * not arbitrary: by the rule of three, observing 0 failures in n trials puts the
 * 95% upper confidence bound on the failure rate at about 3/n, so 100 landed
 * races bound it at ~3%. At 30 the bound is ~10%, which is too weak to certify a
 * data-loss property. A cell that lands fewer than the floor is reported
 * NEVER-RAN (underpowered) -- honest about having too few real races rather than
 * passing on a handful.
 */
/**
 * THE EXCLUSIONS ARE DELIBERATE -- do not "fix" them by adding the rest of the
 * A13 family. `A13-VALIDATE` and `A13-WARMARM` are racers by the same mechanism
 * (100% of their 54,456 never-ran records are `mutationApplied === false`,
 * identical to A13), so the omission looks like an oversight and is not: R6's
 * owner decided 2026-09-17 to leave them out, because they are METHODOLOGY
 * EXPERIMENTS -- warming arms and per-entry-timing validation -- and not the
 * §5.1 attack cells criterion 1 scores. Their FAIL verdicts are honest: those
 * arms really did lose user bytes, and R6 was never meant to relabel them.
 *
 * Adding them would move arm-B/arm-B0 to PASS and arm-P (0 landed) to
 * NEVER-RAN (underpowered), changing published verdicts in the memo that gates
 * the UAT. harness/test-verdict-rule.mjs case 6f pins this set's exact
 * contents, so an edit here fails a test rather than silently rescoring a
 * family.
 */
export const PROBABILISTIC_ATTACKS = new Set(['A13', 'A13-VR', 'A13-TIMING'])
export const LANDED_FLOOR = 100

/** Whether §9's `never-ran == 0` clause applies to this attack. */
export function isProbabilistic(attack) {
  return PROBABILISTIC_ATTACKS.has(attack)
}

/**
 * The §9 verdict, with R6's landed-subset rule applied.
 *
 * @param {{attack:string, passed:number, failed:number, neverRan:number,
 *          otherNeverRan?:number}} row - `otherNeverRan` counts never-ran runs
 *   NOT explained by the racer failing to land. It defaults to `neverRan`, the
 *   conservative direction: a caller that has not measured the split cannot
 *   claim R6's benefit. See the note on its guard clause below.
 * @param {boolean|undefined} controlFailed - as controlFailedFlag() returns
 * @param {'external'|'unspecified'|string} [controlState]
 */
export function verdictFor(row, controlFailed, controlState) {
  // A ROW WITH NO COUNTS MUST NOT CERTIFY ANYTHING. Without this, `verdictFor({
  // attack: 'A13' }, true)` returned PASS: `undefined + undefined` is NaN, and
  // every comparison against NaN is false, so BOTH the failure clause and the
  // floor were skipped and control fell through to PASS. String counts were
  // worse than they look -- '0' + '5' is the string '05', which the floor then
  // compared lexically. Throwing is the only safe answer; a verdict function
  // that guesses at missing evidence is the defect this whole file exists for.
  for (const k of ['passed', 'failed', 'neverRan']) {
    if (!Number.isInteger(row[k])) {
      throw new TypeError(`verdictFor: ${k} must be an integer, got ${String(row[k])}`)
    }
  }

  // FAILURES BEAT EVERYTHING, AND THIS CLAUSE GOES FIRST.
  //
  // One observed loss proves the defect; no sample size is required to conclude
  // "this destroyed user data". Nothing below may pre-empt it -- not the floor,
  // and not the never-ran clause.
  //
  // This function has now had that wrong TWICE, in the same release, in two
  // different ways, and both times the comment saying failures come first sat
  // directly below a clause that beat them:
  //
  //   1. the floor ran first, so A13/default/V0/overlayfs -- 39 real failures in
  //      89 landed races -- reported NEVER-RAN (underpowered).
  //   2. the non-probabilistic never-ran clause ran first, so ANY deterministic
  //      attack with failures AND never-runs reported NEVER-RAN. That shipped:
  //      14 cells in results/SUMMARY.md carried 3,076 records of measured user
  //      -file loss under a NEVER-RAN label, and the label flipped on nothing
  //      but set membership -- the same counts scored FAIL as 'A13' and
  //      NEVER-RAN as 'A13-WARMARM'.
  //
  // Both are the same class the spike keeps finding: a confident label standing
  // in for an unmeasured quantity. Hoisting can only move a cell toward a more
  // alarming label, never away from one, so it cannot overstate confidence
  // anywhere. The counts print beside every verdict, so nothing is lost.
  if (row.failed > 0) return 'FAIL'

  const probabilistic = isProbabilistic(row.attack)
  const landed = row.passed + row.failed
  const otherNeverRan = row.otherNeverRan ?? row.neverRan

  if (!probabilistic && row.neverRan > 0) return 'NEVER-RAN'
  // R6 DROPS NON-LANDINGS FROM THE DENOMINATOR, NOT EVERY FALSE PRECONDITION.
  // The rule the owner settled is "a run where the RACER DID NOT LAND leaves the
  // denominator". Ignoring `neverRan` wholesale would also swallow harness
  // errors and every other unmet precondition, which §9 must never do. Measured
  // across all 4,435 never-ran records in A13 and A13-TIMING: 100% are
  // `precondition.mutationApplied === false`, so today the two are the same set
  // -- but "the same today" is not a rule, and the default above makes an
  // unmeasured split fail safe rather than silently lenient.
  if (otherNeverRan > 0) return 'NEVER-RAN'
  if (probabilistic && landed < LANDED_FLOOR) return 'NEVER-RAN (underpowered)'
  if (controlFailed === false) return 'NEVER-RAN (control)'
  // resolveControl() invents 'unspecified' precisely so a missing CONTROL_SPEC
  // row is never counted as satisfied -- this file's own header says it never
  // guesses. Falling through to a bare PASS here made it indistinguishable from
  // a control-verified one. A13-VR is one run away from that: it is in
  // PROBABILISTIC_ATTACKS and has no CONTROL_SPEC row.
  if (controlState === 'unspecified') return 'NEVER-RAN (control unspecified)'
  if (controlState === 'external') return 'PASS (control unverified)'
  return 'PASS'
}
