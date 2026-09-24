/**
 * @fileoverview The update eligibility gate's pure classifier (SMI-6532, A2
 *   step 4 — `classifyUpdateTarget`).
 * @module @skillsmith/core/services/update-target-gate
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 * @see update-target-gate.rules.ts — the rule table this module walks
 * @see update-target-gate.types.ts — `UpdateTargetPlan`, the third seam
 *
 * `classifyUpdateTarget(evidence, probe, plan)` is PURE — it makes no I/O
 * call of any kind. `evidence` (`ManifestEvidence`) and `probe`
 * (`ProbeOutcome`) are both already-resolved data by the time they reach this
 * function; `probeUpdateTarget` (`update-target.probe.ts`) does ALL the
 * filesystem work, and whatever builds `ManifestEvidence` (today,
 * `temporaryManifestEvidenceResolver`; later, SMI-6345's real resolver) does
 * ALL the manifest-reading work, both BEFORE this function is ever called.
 *
 * THIS SIGNATURE IS A CORRECTION, NOT THE ORIGINAL PLAN TEXT. §4.1 originally
 * said "`classifyUpdateTarget` takes the resolver as a parameter" — corrected
 * 2026-09-23 (see that section's own note): a resolver returns a `Promise`,
 * so calling one is I/O, and T-G3 fails this function if it makes ANY call on
 * a recording fs mock. The resolver seam sits ONE LEVEL UP, in whatever
 * builds `ManifestEvidence` before calling this function — this module
 * imports no resolver, no probe implementation, and performs no `await`
 * anywhere in its own code.
 *
 * WHY EVERY RULE RE-NARROWS `probe` INSTEAD OF NARROWING ONCE. TypeScript's
 * control-flow narrowing does not persist across separate closures stored in
 * an array — narrowing `probe` to `ProbeOk` in one `match` function tells
 * TypeScript nothing about the NEXT array entry's `match` function, since
 * they are different functions called independently by the loop below, not
 * sequential statements in one function body. `asProbeOk` (`update-target-
 * gate.rules.ts`) is therefore called inside every rule from row 5 onward
 * that needs `ProbeOk`'s fields, each one independently. This is not merely a
 * type-system limitation to work around: it is also the SAFER shape. If a
 * future edit reordered a row-3 rule to no longer run first, or if the driver
 * below were ever changed to skip ahead, a rule that trusted an outer
 * narrowing would silently read fields off a non-`ok` `ProbeOutcome` (all of
 * which are optional/absent on the other three variants) rather than
 * correctly declining to match.
 */

import { CLASSIFICATION_RULES, type RuleContext } from './update-target-gate.rules.js'
import type { ManifestEvidence } from './update-target.evidence.js'
import type { ProbeOutcome } from './update-target.probe.js'
import type { UpdateTargetClassification, UpdateTargetPlan } from './update-target-gate.types.js'

export type {
  PlannedWrite,
  UpdateFetchOutcome,
  UpdateTargetClassification,
  UpdateTargetPlan,
  UpdateWriteMode,
} from './update-target-gate.types.js'
export {
  CLASSIFICATION_RULES,
  ROW_ORDER,
  type ClassificationRule,
  type RuleContext,
} from './update-target-gate.rules.js'

/**
 * Classify one update target against §4.3's rule table. First match wins.
 *
 * `eligible` is reachable ONLY by exhausting {@link CLASSIFICATION_RULES} and
 * landing on its unconditional row-16 entry (task brief requirement #3) —
 * this function contributes no default argument, no early return, and no
 * `??` fallback of its own that could produce it. If the loop below somehow
 * finishes without a match — which {@link CLASSIFICATION_RULES}'s own
 * unconditional last entry makes impossible today, and which this module's
 * own tests assert by checking the row set and table length directly rather
 * than trusting that invariant to hold silently — that is treated as a bug
 * in the rule table, not papered over with a permissive default: THE CENTRAL
 * HAZARD this whole gate exists to remove is exactly a permissive value
 * standing in for an unresolved state, and a silently-chosen fallback reason
 * here would be that same shape one level up.
 */
export function classifyUpdateTarget(
  evidence: ManifestEvidence,
  probe: ProbeOutcome,
  plan: UpdateTargetPlan
): UpdateTargetClassification {
  const ctx: RuleContext = { evidence, probe, plan }
  for (const rule of CLASSIFICATION_RULES) {
    const hit = rule.match(ctx)
    if (hit !== null) return hit
  }
  throw new Error(
    'classifyUpdateTarget: no rule in CLASSIFICATION_RULES matched — row 16 must be an ' +
      'unconditional catch-all; this indicates the rule table itself is broken, not that ' +
      'this target has no reason'
  )
}
