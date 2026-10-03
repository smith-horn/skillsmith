/**
 * Generation binding — design doc §8.5's "Report/input binding" paragraph:
 * "the binding key is `smi5879_run.run_id`... the binding check is (a) all
 * three artifacts carry the same `run_id`, (b) that `run_id` exists in
 * `smi5879_run` with `status = 'sealed'`, and (c) its `population_digest`
 * re-verifies against the live population."
 * @module scripts/indexer/smi5879-gate-check.binding
 *
 * Shared by the top-level evaluator (binds the DECISION generation once,
 * before any numbered gate) and G-2R (`smi5879-gate-check.g2r.ts`, which
 * "additionally binds a pair of run_ids and applies the same three checks to
 * each" — reuses {@link bindGeneration} rather than re-deriving it).
 */

import {
  assertCoverageTotalsMatchPopulation,
  assertMergedRowsMatchPopulation,
} from './smi5879-merge-shards.population.ts'
import {
  assertBundleAbsentCoherence,
  assertRowOutcomeCoherence,
  assertRowOutcomeFieldPresence,
} from './smi5879-merge-shards.outcome-coherence.ts'
import type { Smi5879Purpose } from './smi5879-census.types.ts'
import type {
  GenerationBinding,
  Smi5879GateCheckDbDeps,
  Smi5879SimulateFullReport,
} from './smi5879-gate-check.types.ts'
import type { SimSnapshotRow } from './smi5879-simulate-full.types.ts'

/**
 * Bind ONE generation: exists, `sealed`, correct `purpose`, digest
 * re-verifies. Each failure mode gets its own distinctly-worded `reason` —
 * never a generic "binding failed".
 */
export async function bindGeneration(
  db: Smi5879GateCheckDbDeps,
  runId: string,
  expectedPurpose: Smi5879Purpose
): Promise<GenerationBinding> {
  const summary = await db.getRunSummary(runId)
  if (!summary) {
    return {
      run_id: runId,
      expected_purpose: expectedPurpose,
      summary: null,
      digest_verified: null,
      bound: false,
      reason: `no smi5879_run row found for run_id=${runId}`,
    }
  }
  if (summary.status !== 'sealed') {
    return {
      run_id: runId,
      expected_purpose: expectedPurpose,
      summary,
      digest_verified: null,
      bound: false,
      reason: `generation ${runId} has status="${summary.status}", not "sealed"`,
    }
  }
  if (summary.purpose !== expectedPurpose) {
    return {
      run_id: runId,
      expected_purpose: expectedPurpose,
      summary,
      digest_verified: null,
      bound: false,
      reason:
        `generation ${runId} has purpose="${summary.purpose}", expected "${expectedPurpose}" — ` +
        (summary.purpose === 'rehearsal'
          ? 'a rehearsal generation can never satisfy a gate (design doc §8.3.5.2.1)'
          : 'refusing to gate on the wrong generation'),
    }
  }
  const digest = await db.verifyDigest(runId)
  const digestOk = digest.populationMatches && digest.branchMatches
  if (!digestOk) {
    return {
      run_id: runId,
      expected_purpose: expectedPurpose,
      summary,
      digest_verified: false,
      bound: false,
      reason:
        `generation ${runId} failed digest re-verification ` +
        `(population_matches=${digest.populationMatches}, branch_matches=${digest.branchMatches}) — ` +
        'the generation is corrupt; the correct action is a new generation, not a repair (design doc §8.3.5.2.4)',
    }
  }
  return {
    run_id: runId,
    expected_purpose: expectedPurpose,
    summary,
    digest_verified: true,
    bound: true,
    reason: `generation ${runId} is sealed, purpose="${expectedPurpose}", digests re-verify`,
  }
}

/**
 * SMI-6444 (plan Item 2) — authenticate the SIMULATOR REPORT itself against
 * the sealed, digest-verified population, at gate-check time.
 *
 * {@link bindGeneration} above binds only the live DB generation: it proves
 * the run exists, is sealed, has the right purpose, and that its own digests
 * re-verify. It says NOTHING about the report file gate-check was handed.
 * `assertMergedRowsMatchPopulation` / `assertCoverageTotalsMatchPopulation`
 * and the three outcome-coherence asserts all exist already, but until now
 * ran ONLY inside `runMergeShards` — a separate, earlier invocation against a
 * file that could have been altered (or swapped) in the interval. Gate-check
 * cannot inherit that proof; it has to redo it against its own inputs, which
 * is exactly what this function does.
 *
 * The `decisionBinding.bound && digest_verified === true` refusal makes the
 * required ordering STRUCTURAL rather than documentary: a caller physically
 * cannot use this to "verify" a report against a population whose own
 * generation was never digest-verified first.
 *
 * Result-object idiom (`{bound, reason}`) rather than the throw idiom the
 * reused asserts use, matching this module's other binding checks — the
 * asserts' throws are caught and converted here.
 */
export async function bindSimulatorReportToPopulation(
  db: Pick<Smi5879GateCheckDbDeps, 'loadCohortRows'>,
  decisionBinding: GenerationBinding,
  simReport: Smi5879SimulateFullReport
): Promise<{ bound: true; reason: string } | { bound: false; reason: string }> {
  if (!decisionBinding.bound || decisionBinding.digest_verified !== true) {
    return {
      bound: false,
      reason:
        `refusing to authenticate the simulator report against generation ${decisionBinding.run_id}: ` +
        `its own generation binding is not verified (bound=${decisionBinding.bound}, ` +
        `digest_verified=${String(decisionBinding.digest_verified)}) — comparing a report against a ` +
        'population whose generation was never digest-verified would prove nothing',
    }
  }

  let population: SimSnapshotRow[]
  try {
    population = await db.loadCohortRows(decisionBinding.run_id)
  } catch (err) {
    return {
      bound: false,
      reason:
        `could not load the sealed population for run_id=${decisionBinding.run_id}: ` +
        `${(err as Error).message}`,
    }
  }
  if (population.length === 0) {
    return {
      bound: false,
      reason:
        `the sealed population for run_id=${decisionBinding.run_id} is empty (zero C1-C4 rows) — ` +
        'an empty population trivially "matches" any report, which is the exact vacuous-equality ' +
        "failure mode this check exists to close (mirrors loadVerifiedPopulation's own guard)",
    }
  }

  try {
    assertMergedRowsMatchPopulation(simReport.rows, population)
    assertCoverageTotalsMatchPopulation(simReport.coverage, population)
    // Structural outcome-label coherence — closes the class of relabeling
    // tamper where the score fields were not also stripped/adjusted to match
    // the claimed outcome (SMI-6436/SMI-6442's checks, applied gate-side for
    // the first time here).
    assertRowOutcomeFieldPresence(simReport.rows)
    assertRowOutcomeCoherence(simReport.rows)
    assertBundleAbsentCoherence(simReport.rows)
  } catch (err) {
    return {
      bound: false,
      reason:
        `the simulator report does not authenticate against the sealed population for run_id=` +
        `${decisionBinding.run_id}: ${(err as Error).message}`,
    }
  }

  return {
    bound: true,
    reason:
      `simulator report rows are exactly the ${population.length}-row sealed population for ` +
      `run_id=${decisionBinding.run_id}, coverage totals agree with it, and every row's outcome ` +
      'label is structurally coherent with its own score fields',
  }
}

/**
 * Cross-artifact run_id binding: the census report, the simulator report,
 * and the CLI-supplied decision run_id must all agree — "reject a
 * plausible-looking but mismatched combination... rather than silently
 * gating on it" (§8.5).
 */
export function checkArtifactRunIdBinding(
  decisionRunId: string,
  censusRunId: string,
  simulatorRunId: string
): { bound: boolean; reason: string } {
  if (censusRunId !== decisionRunId || simulatorRunId !== decisionRunId) {
    return {
      bound: false,
      reason:
        `artifact run_id mismatch — --decision-run-id=${decisionRunId}, census report run_id=` +
        `${censusRunId}, simulator report run_id=${simulatorRunId} (all three must agree)`,
    }
  }
  return {
    bound: true,
    reason: 'census report, simulator report, and --decision-run-id all carry the same run_id',
  }
}

/**
 * Finding #2 (adversarial review): the reconciliation-mode WINDOW census
 * report is loaded (its I-1..I-4 invariants get merged into the top-level
 * precondition check) but was never itself bound to `--window-run-id` — the
 * SAME artifact-binding check {@link checkArtifactRunIdBinding} already
 * applies to the decision census/simulator reports, applied here to the
 * window census report too: its own `run_id` must equal `--window-run-id`,
 * and its own `purpose` must be `"window"`. Without this, an operator could
 * pass an entirely unrelated (or stale) window census file and its
 * invariants would be silently trusted — the ACTUAL DB-level binding of
 * `--window-run-id` only happens much later, deep inside G-2R's
 * `bindG2rPair`, which never re-reads this file at all.
 */
export function checkWindowCensusBinding(
  windowRunId: string,
  windowCensusRunId: string,
  windowCensusPurpose: Smi5879Purpose
): { bound: boolean; reason: string } {
  if (windowCensusRunId !== windowRunId) {
    return {
      bound: false,
      reason:
        `window census report run_id="${windowCensusRunId}" does not match ` +
        `--window-run-id=${windowRunId}`,
    }
  }
  if (windowCensusPurpose !== 'window') {
    return {
      bound: false,
      reason: `window census report purpose="${windowCensusPurpose}", expected "window"`,
    }
  }
  return {
    bound: true,
    reason: 'window census report run_id and purpose match --window-run-id',
  }
}
