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
 * carries `prePortQuarantine`/`postPortQuarantine` but is NOT one of these:
 * its outcome label is deliberately overridden past whatever those booleans
 * would classify to (`processRow`'s `isBundleAbsent` branch), so checking it
 * here would flag a correct row as a false positive.
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
 * Round-2 fix: assert `prePortQuarantine`/`postPortQuarantine` are present
 * if and only if `outcome` is in `SCORED_OUTCOMES`. Closes the class of
 * attack independent of which non-scored outcome is used — a row cannot
 * carry quarantine fields while claiming to be `unfetchable`/`unevaluable`/
 * `content_drifted` (fields present where the real producer never puts
 * them), and cannot omit them while claiming a scored outcome (already
 * covered for the verdict-delta subset by {@link assertRowOutcomeCoherence}
 * below, extended here to `bundle_absent` too).
 */
export function assertRowOutcomeFieldPresence(rows: readonly SimRowResult[]): void {
  const violations: string[] = []
  for (const row of rows) {
    const isScored = (SCORED_OUTCOMES as readonly SimRowOutcome[]).includes(row.outcome)
    const hasFields = row.prePortQuarantine !== undefined || row.postPortQuarantine !== undefined
    if (isScored && !hasFields) {
      violations.push(
        `${row.id} (outcome=${row.outcome} is a scored outcome, but has neither field)`
      )
    } else if (!isScored && hasFields) {
      violations.push(
        `${row.id} (outcome=${row.outcome} is NOT a scored outcome, but carries ` +
          `prePortQuarantine=${row.prePortQuarantine}/postPortQuarantine=${row.postPortQuarantine} — ` +
          'the real simulator never attaches these fields to this outcome)'
      )
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `SMI-6015: ${violations.length} row(s) have quarantine-field presence inconsistent with their ` +
        `outcome: ${violations.slice(0, MAX_IDS_IN_ERROR).join('; ')}` +
        `${violations.length > MAX_IDS_IN_ERROR ? ', ...' : ''}. A row outside SCORED_OUTCOMES that ` +
        'still carries these fields could otherwise masquerade as a non-blocking, non-reviewed ' +
        "outcome while smuggling a real quarantine verdict's fields past G-1's review set and G-5's " +
        'delta-bound check. Refusing to merge.'
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
        'Refusing to merge a shard report containing an internally-inconsistent row.'
    )
  }
}
