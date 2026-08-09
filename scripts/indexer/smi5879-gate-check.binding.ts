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

import type { Smi5879Purpose } from './smi5879-census.types.ts'
import type { GenerationBinding, Smi5879GateCheckDbDeps } from './smi5879-gate-check.types.ts'

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
