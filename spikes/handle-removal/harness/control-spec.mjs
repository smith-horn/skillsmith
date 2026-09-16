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
