// C4 additions to the control spec (SMI-6715), split out of control-spec.mjs to
// keep that file under the length limit. Imports nothing from it, so there is no
// cycle. control-spec.mjs spreads C4_CONTROL_ROWS into CONTROL_SPEC at the
// position the rows used to occupy; test-verdict-rule.mjs pins the result.

/** One controlled C4 row: control = C4-naive, same attack, exact variant. */
function c4Controlled(attack) {
  return {
    [attack]: {
      control: {
        kind: 'in-data',
        candidate: 'C4-naive',
        matchVariant: 'exact',
        cite: `SMI-6715: ${attack} against C4-naive (guard ablated) is the control`,
      },
      isControlCandidate: (c) => c === 'C4-naive',
    },
  }
}

/**
 * The control for a C4 cell is the SAME attack against C4-naive
 * (quarantineTree with the guard ablated), same variant.
 */
export const C4_CONTROL_ROWS = {
  ...c4Controlled('A3-C4'),
  ...c4Controlled('A4-C4'),
  ...c4Controlled('A7-C4'),
  ...c4Controlled('A8-C4'),
  ...c4Controlled('A10-C4'),
  ...c4Controlled('A1-C4'),
  ...c4Controlled('A2-C4'),
  ...c4Controlled('A13-C4'),
  // SMI-6715 Step 1b part 2: the racer released at C4's own hash end. Expected
  // verdict after the repair: PASS (<n> held) on every filesystem -- post-hash
  // landings are caught after the move and held under the strict predicate --
  // with the C4-naive control losing data (design §9).
  ...c4Controlled('A13-C4-POSTHASH'),
  'A8a-C4': {
    control: {
      kind: 'none',
      cite: 'property check: rename(2) moves a symlink, it cannot unlink or follow one, so both arms pass by construction; outside bytes must stay intact',
    },
  },
  'A10b-C4': {
    control: {
      kind: 'none',
      cite: 'property check: rename(2) moves the name, never the shared inode, so both arms pass by construction; the outside hard-linked file must stay intact',
    },
  },
  'A13-C4-OOM': {
    control: {
      kind: 'none',
      cite: 'record-only: racer landings in the out-of-model window (re-check entered .. rename returned), ADR-166 D-0',
    },
  },
  // SMI-6715 Step 1b part 2: the no-attack baseline. Expected verdict: PASS
  // (quarantined 30/30) on every filesystem; any held or kept run is a false
  // positive and FAILs it (result-schema.c4.mjs C4_BASELINE_ATTACKS).
  'B0-C4': {
    control: {
      kind: 'none',
      cite: 'no-attack baseline (design §9): measures the false held/kept rate of the C4 repair; there is no loss to demonstrate',
    },
  },
}

/**
 * Cells that are RECORDED, not scored (SMI-6715 G1, ADR-166 D-0). A13-C4-OOM
 * holds the runs whose racer landings fell only in the out-of-model window
 * (pre-rename re-check entered .. renameSync returned); ADR-166 D-0 puts that
 * window outside what C4 claims, so no verdict is scored for it -- neither a
 * PASS that would read as safety evidence nor a FAIL that would read as a
 * falsifier. verdictFor() renders `RECORD-ONLY`, with the loss count when there
 * is one, so the numbers stay visible. Deliberately NOT in PROBABILISTIC_ATTACKS.
 */
export const RECORD_ONLY_ATTACKS = new Set(['A13-C4-OOM'])

/**
 * The verdict for a record-only cell: never a PASS or FAIL, but the numbers stay
 * visible. `lost` is named when failed > 0 and `never-ran` when neverRan > 0
 * (G2-2: a cell made entirely of harness errors must not read as bare
 * RECORD-ONLY). Bare only when both are zero.
 */
export function recordOnlyVerdict(row) {
  const parts = []
  if (row.failed > 0) parts.push(row.failed + ' lost')
  if (row.neverRan > 0) parts.push(row.neverRan + ' never-ran')
  return parts.length > 0 ? 'RECORD-ONLY (' + parts.join(', ') + ')' : 'RECORD-ONLY'
}

/**
 * The key a verdict is tallied under. A RECORD-ONLY verdict carries a count
 * parenthetical that would otherwise make every distinct count its own tally
 * row; strip it for those verdicts only, so every other verdict string
 * (including `PASS (control unverified)`) is its own key, unchanged.
 */
export function verdictTallyKey(verdict) {
  if (verdict.startsWith('RECORD-ONLY')) return 'RECORD-ONLY'
  // SMI-6715 Step 1b part 2: `PASS (<n> held)` and `PASS (control unverified,
  // <n> held)` drop the count for the tally only; the cell verdict keeps it.
  return verdict.replace(/(\(|, )\d+ held\)$/, '$1held)')
}
