/**
 * Row-outcome-label coherence check for `smi5879-merge-shards.ts`. Split
 * into its own module per CLAUDE.md's <500-line-per-file convention —
 * `.merge-rules.ts` was at 499/500 lines once this check was added, too
 * tight a margin to leave in place.
 * @module scripts/indexer/smi5879-merge-shards.outcome-coherence
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 3. N-way checkpoint/report merge tool (new script)")
 *
 * WHY THIS CHECK EXISTS
 * ----------------------
 * Wave 2 adversarial review, round 1: none of `.merge-rules.ts`'s checks —
 * id disjointness, population set-equality, per-cohort/author/name
 * agreement — verify that a row's `outcome` LABEL is actually consistent
 * with its own `prePortQuarantine`/`postPortQuarantine` fields. A row with
 * a genuine population id (so it passes every check in `.merge-rules.ts`
 * and `.population.ts`) but a wrong `outcome` — e.g. `unchanged_clean` on a
 * row whose quarantine booleans say `unchanged_quarantined` — would make
 * G-1's review set `R` (`computeR`, `smi5879-gate-check.helpers.ts`,
 * filters on `outcome === 'newly_quarantined' | 'newly_cleared'`) silently
 * omit or include the wrong rows, while every coverage/count number this
 * tool checks still balances perfectly, because `counts` is recomputed
 * from the SAME (already-wrong) `outcome` field the label itself carries.
 *
 * Round 2 (confirmation round on round 1's fix) found a gap IN that fix: it
 * only checked the four verdict-delta outcomes, so a genuinely
 * `newly_quarantined` row mislabeled `unfetchable` (or `unevaluable`/
 * `content_drifted`) while STILL carrying `prePortQuarantine=false,
 * postPortQuarantine=true` would skip this check entirely (those three
 * outcomes are not in `VERDICT_DELTA_OUTCOMES`) AND skip G-5's
 * `checkDeltaBound` (which only looks at `SCORED_OUTCOMES`) AND be excluded
 * from G-1's review set — with coverage/counts still balancing, because
 * `unfetchable`/`unevaluable`/`content_drifted` are non-blocking, "we
 * couldn't fully evaluate this row" buckets, not verdicts. Confirmed against
 * `processRow` (`smi5879-simulate-full.helpers.ts`): every one of that
 * function's `unfetchable`/`unevaluable`/`content_drifted` return sites
 * constructs its result as `{ ...base, outcome: '...', reason: '...' }` —
 * NONE of them ever attach `prePortQuarantine`/`postPortQuarantine` (or the
 * risk-score fields) at all. Only `SCORED_OUTCOMES`
 * (`smi5879-gate-check.helpers.ts` — `bundle_absent` plus the four
 * verdict-delta outcomes) legitimately carry those fields. `assertRowOutcomeFieldPresence`
 * below closes this: a row outside `SCORED_OUTCOMES` carrying quarantine
 * fields at all is now itself a hard-fail, which catches the round-2 attack
 * regardless of which non-scored outcome the mislabeling used.
 */

import type { SimRowOutcome, SimRowResult } from './smi5879-simulate-full.types.ts'
import { SCORED_OUTCOMES } from './smi5879-gate-check.helpers.ts'
import { MAX_IDS_IN_ERROR } from './smi5879-merge-shards.merge-rules.ts'

/**
 * The four "verdict-delta" outcomes — the only ones `classifyVerdictDelta`
 * (`smi5879-simulate-full.helpers.ts`) ever produces. `bundle_absent` also
 * carries `prePortQuarantine`/`postPortQuarantine` but is NOT one of these —
 * it is checked separately by {@link assertBundleAbsentCoherence} below.
 *
 * SMI-6436: prior to that fix, `processRow` checked `isBundleAbsent` BEFORE
 * computing the verdict delta, so a `bundle_absent` row's outcome label was
 * unconditionally overridden regardless of whether the delta was a real
 * change — this comment used to say checking `bundle_absent` here "would
 * flag a correct row as a false positive" on that basis. That is no longer
 * true: post-fix, `processRow` only emits `bundle_absent` when the delta is
 * `unchanged_clean`/`unchanged_quarantined`, so a `bundle_absent` row's own
 * `prePortQuarantine`/`postPortQuarantine` must always agree — a real
 * invariant, not a false-positive risk.
 */
const VERDICT_DELTA_OUTCOMES: readonly SimRowOutcome[] = [
  'newly_quarantined',
  'newly_cleared',
  'unchanged_clean',
  'unchanged_quarantined',
]

/**
 * `classifyVerdictDelta`'s own four-branch logic is deliberately
 * REIMPLEMENTED here rather than imported (same rationale as
 * `.merge-rules.ts`'s `recomputeCounts`: a verifier calling the producer's
 * own function cannot detect a fault IN that function) — and reimplementing
 * avoids pulling `smi5879-simulate-full.helpers.ts`'s network/fetch/
 * rate-limit dependency graph into a tool that must stay a pure local
 * aggregation step. `SCORED_OUTCOMES` below is imported, not reimplemented,
 * for the opposite reason: it is not producer arithmetic to be independently
 * re-derived, it is the closed classification G-5's own `checkDeltaBound`
 * already depends on — reusing it means this check and G-5 can never drift
 * apart on which outcomes are "scored."
 */
function expectedVerdictDeltaOutcome(
  prePortQuarantine: boolean,
  postPortQuarantine: boolean
): SimRowOutcome {
  if (!prePortQuarantine && postPortQuarantine) return 'newly_quarantined'
  if (prePortQuarantine && !postPortQuarantine) return 'newly_cleared'
  if (!prePortQuarantine && !postPortQuarantine) return 'unchanged_clean'
  return 'unchanged_quarantined'
}

/**
 * The four fields `processRow` (`smi5879-simulate-full.helpers.ts`) ONLY
 * ever sets as one unit — both of its scored construction sites (the
 * `bundle_absent` branch and the final `classifyVerdictDelta` branch) set
 * all four in the SAME object literal, from the SAME `preVerdict`/
 * `postVerdict` pair, never independently. Round-4 confirmation review:
 * the round-3 fix checked only the quarantine pair — a row could have a
 * fully-coherent quarantine pair but a partially-present (or wrongly
 * present/absent) risk-score pair, a shape the real producer can never
 * emit, unchecked by round 3.
 */
const SCORED_FIELD_PAIRS = [
  ['prePortQuarantine', 'postPortQuarantine'],
  ['prePortRiskScore', 'postPortRiskScore'],
] as const

/**
 * Round-2 fix: assert `prePortQuarantine`/`postPortQuarantine` (round 4:
 * and `prePortRiskScore`/`postPortRiskScore`) are present if and only if
 * `outcome` is in `SCORED_OUTCOMES`. Closes the class of attack independent
 * of which non-scored outcome is used — a row cannot carry these fields
 * while claiming to be `unfetchable`/`unevaluable`/`content_drifted`
 * (fields present where the real producer never puts them), and cannot
 * omit them while claiming a scored outcome (already covered for the
 * verdict-delta subset by {@link assertRowOutcomeCoherence} below,
 * extended here to `bundle_absent` too).
 *
 * Round-3 confirmation review found a gap IN the original (quarantine-only)
 * fix: its `hasFields` test used OR, so a row with EXACTLY ONE of a pair's
 * two fields present (the other omitted) was treated as "has fields" and
 * passed — `assertRowOutcomeCoherence` below rescues this shape for the
 * four verdict-delta outcomes (its own missing-field check uses OR the
 * other way, catching "at least one absent"), but it deliberately does NOT
 * cover `bundle_absent`, so a `bundle_absent` row with only one field
 * present slipped through both checks entirely. Every field pair in
 * {@link SCORED_FIELD_PAIRS} is now checked "both present together, or
 * both absent together" as its own outcome-independent violation, before
 * the scored/unscored comparison even runs — round 4 generalized this from
 * the quarantine pair alone to every pair the real producer sets as a unit.
 */
export function assertRowOutcomeFieldPresence(rows: readonly SimRowResult[]): void {
  const violations: string[] = []
  for (const row of rows) {
    const isScored = (SCORED_OUTCOMES as readonly SimRowOutcome[]).includes(row.outcome)
    for (const [preField, postField] of SCORED_FIELD_PAIRS) {
      const preDefined = row[preField] !== undefined
      const postDefined = row[postField] !== undefined
      if (preDefined !== postDefined) {
        violations.push(
          `${row.id} (outcome=${row.outcome} has exactly one of ${preField}/${postField} present ` +
            '— the real simulator always sets both together, never independently)'
        )
        continue
      }
      const hasBoth = preDefined && postDefined
      if (isScored && !hasBoth) {
        violations.push(
          `${row.id} (outcome=${row.outcome} is a scored outcome, but has neither ${preField} nor ` +
            `${postField})`
        )
      } else if (!isScored && hasBoth) {
        violations.push(
          `${row.id} (outcome=${row.outcome} is NOT a scored outcome, but carries ` +
            `${preField}=${row[preField]}/${postField}=${row[postField]} — the real simulator never ` +
            'attaches these fields to this outcome)'
        )
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `SMI-6015: ${violations.length} row(s) have scored-field presence inconsistent with their ` +
        `outcome: ${violations.slice(0, MAX_IDS_IN_ERROR).join('; ')}` +
        `${violations.length > MAX_IDS_IN_ERROR ? ', ...' : ''}. A row outside SCORED_OUTCOMES that ` +
        'still carries these fields could otherwise masquerade as a non-blocking, non-reviewed ' +
        "outcome while smuggling a real quarantine verdict's fields past G-1's review set and G-5's " +
        'delta-bound check; a row with only one field present is malformed regardless of outcome. ' +
        'Refusing to accept a report containing an internally-inconsistent row.'
    )
  }
}

/**
 * Assert every merged row whose `outcome` is a verdict-delta outcome
 * actually agrees with its own `prePortQuarantine`/`postPortQuarantine`
 * fields. Applied to the merged rows (after `mergeRows`, before population
 * verification) — a cheap, purely local structural check, same tier as
 * `.merge-rules.ts`'s numeric-sanity check.
 */
export function assertRowOutcomeCoherence(rows: readonly SimRowResult[]): void {
  const mismatches: string[] = []
  for (const row of rows) {
    if (!VERDICT_DELTA_OUTCOMES.includes(row.outcome)) continue
    if (row.prePortQuarantine === undefined || row.postPortQuarantine === undefined) {
      mismatches.push(
        `${row.id} (outcome=${row.outcome} but prePortQuarantine/postPortQuarantine is missing)`
      )
      continue
    }
    const expected = expectedVerdictDeltaOutcome(row.prePortQuarantine, row.postPortQuarantine)
    if (expected !== row.outcome) {
      mismatches.push(
        `${row.id} (outcome=${row.outcome}, but prePortQuarantine=${row.prePortQuarantine}/` +
          `postPortQuarantine=${row.postPortQuarantine} implies ${expected})`
      )
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `SMI-6015: ${mismatches.length} row(s) have an outcome label that disagrees with their own ` +
        `prePortQuarantine/postPortQuarantine fields: ${mismatches.slice(0, MAX_IDS_IN_ERROR).join('; ')}` +
        `${mismatches.length > MAX_IDS_IN_ERROR ? ', ...' : ''}. G-1's review set and G-3's counts ` +
        'are derived directly from the outcome label — a row whose label disagrees with its own ' +
        'quarantine fields would corrupt both without any coverage/count arithmetic ever detecting it. ' +
        'Refusing to accept a report containing an internally-inconsistent row.'
    )
  }
}

/**
 * SMI-6436: assert every merged `bundle_absent` row's own quarantine
 * booleans actually agree with a non-change — `prePortQuarantine ===
 * postPortQuarantine`. Post-fix, `processRow` only ever emits
 * `bundle_absent` when `classifyVerdictDelta` already resolved to
 * `unchanged_clean`/`unchanged_quarantined`; a `bundle_absent` row whose
 * booleans disagree would mean a real verdict flip got mislabeled and
 * silently dropped from G-1's review set and G-3's `newly_quarantined`/
 * `newly_cleared` counts — exactly the bug class SMI-6436 fixed. Mirrors
 * {@link assertRowOutcomeCoherence}'s shape but for the one outcome that
 * function deliberately excludes.
 */
export function assertBundleAbsentCoherence(rows: readonly SimRowResult[]): void {
  const mismatches: string[] = []
  for (const row of rows) {
    if (row.outcome !== 'bundle_absent') continue
    if (row.prePortQuarantine === undefined || row.postPortQuarantine === undefined) {
      mismatches.push(
        `${row.id} (outcome=bundle_absent but prePortQuarantine/postPortQuarantine is missing)`
      )
      continue
    }
    if (row.prePortQuarantine !== row.postPortQuarantine) {
      mismatches.push(
        `${row.id} (outcome=bundle_absent, but prePortQuarantine=${row.prePortQuarantine}/` +
          `postPortQuarantine=${row.postPortQuarantine} is a real verdict change, not a non-change)`
      )
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `SMI-6436: ${mismatches.length} row(s) are labeled bundle_absent but their own ` +
        `prePortQuarantine/postPortQuarantine fields show a real verdict change: ` +
        `${mismatches.slice(0, MAX_IDS_IN_ERROR).join('; ')}` +
        `${mismatches.length > MAX_IDS_IN_ERROR ? ', ...' : ''}. bundle_absent must only be used for a ` +
        'non-change (unchanged_clean/unchanged_quarantined) — a row like this would hide a real ' +
        "newly_quarantined/newly_cleared delta from G-1's review set and G-3's counts. Refusing to " +
        'accept a report containing an internally-inconsistent row.'
    )
  }
}

/**
 * Convenience composite of all three asserts above, in the required order
 * (field-presence first — the other two assume presence already holds).
 * `runMergeShards`/`bindSimulatorReportToPopulation` keep the three calls
 * explicit (their own call-site comments explain why); SMI-6481's four new
 * call sites (`smi5879-simulate-full.checkpoint-coherence.ts`/`.report.ts`/
 * `.mainpass.ts`/`.sweep.ts`) want one terse call instead.
 */
export function assertRowsInternallyCoherent(rows: readonly SimRowResult[]): void {
  assertRowOutcomeFieldPresence(rows)
  assertRowOutcomeCoherence(rows)
  assertBundleAbsentCoherence(rows)
}

/**
 * SMI-6481: every row id that fails ANY of the three checks above — for a
 * caller that needs to enumerate every offending row (e.g. so an operator
 * can remove exactly those rows from a checkpoint's `row_results`), not just
 * the first {@link MAX_IDS_IN_ERROR} named in a thrown message. Deliberately
 * checks each row via the SAME three real functions above (one-row-at-a-time,
 * catching each's throw) rather than re-deriving the "is this row bad"
 * predicate independently — every one of these three checks is already
 * per-row (no cross-row state), so this is exactly equivalent to the bulk
 * check with zero risk of the two ever drifting apart. Only meant to be
 * called in a failure path (after {@link assertRowsInternallyCoherent} has
 * already thrown) — never on the hot path, so the extra per-row overhead is
 * a non-issue.
 */
export function findIncoherentRowIds(rows: readonly SimRowResult[]): string[] {
  const bad: string[] = []
  for (const row of rows) {
    try {
      assertRowOutcomeFieldPresence([row])
      assertRowOutcomeCoherence([row])
      assertBundleAbsentCoherence([row])
    } catch {
      bad.push(row.id)
    }
  }
  return bad
}
