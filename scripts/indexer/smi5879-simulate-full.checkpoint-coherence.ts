/**
 * SMI-6481: the checkpoint-resume coherence guard, split out of the sibling
 * `smi5879-simulate-full.checkpoint.ts` (CLAUDE.md's <500-line-per-file
 * convention — this guard's remediation message, enumerating every
 * offending row id plus a surgical-fix/cold-start decision tree, pushed
 * `.checkpoint.ts` to 538 lines). `.checkpoint.ts` keeps on-disk I/O, shape
 * validation, and the two identity guards (`assertCheckpointIdentity`/
 * `assertCheckpointRowsBelongToGeneration`); this module owns exactly one
 * additional guard, about OUTCOME coherence rather than identity/shape.
 * @module scripts/indexer/smi5879-simulate-full.checkpoint-coherence
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3c
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.3.5.2.4
 */

import {
  assertRowsInternallyCoherent,
  findIncoherentRowIds,
} from './smi5879-merge-shards.outcome-coherence.ts'
import type { SimRowResult } from './smi5879-simulate-full.types.ts'

/**
 * Cap on how many offending row ids {@link assertCheckpointRowsAreCoherent}
 * lists inline — generous relative to `MAX_IDS_IN_ERROR`'s 10
 * (`smi5879-merge-shards.merge-rules.ts`, the cap each individual coherence
 * assert's OWN thrown message uses) — the whole point here is to give the
 * operator a COMPLETE removal list for the realistic case: a handful to low
 * hundreds of pre-SMI-6436-mislabeled rows out of a population that can run
 * into the hundreds of thousands — while still bounding the message size
 * against a pathological fully-corrupt checkpoint where most/every row is
 * affected.
 */
const MAX_IDS_IN_CHECKPOINT_REMEDIATION = 500

/**
 * SMI-6481: refuse to resume a checkpoint whose OWN `row_results` are
 * internally inconsistent. Reuses the SAME asserts
 * `runMergeShards`/`bindSimulatorReportToPopulation` already apply to a
 * finished report (`smi5879-merge-shards.outcome-coherence.ts`) — a
 * checkpoint's `row_results` has the identical shape and the identical
 * failure mode. Called by `smi5879-simulate-full.ts` immediately after
 * seeding `results` from `checkpoint.row_results`, before any scan/fetch.
 *
 * By the time this can fire, `runMainPass` (`smi5879-simulate-full.mainpass.ts`)
 * and `runSweepPhase` (`smi5879-simulate-full.sweep.ts`) BOTH already
 * validate every fresh `processRow` outcome before it is ever merged into
 * `results` and checkpointed — so a live classifier regression should never
 * reach a checkpoint file in the first place. This guard is what catches it
 * if that ever fails: a checkpoint written by PRE-SMI-6436 classification
 * code (before any of these guards existed) is the most likely cause, but a
 * defect in the CURRENT classifier that somehow slipped past those two
 * checks — or a checkpoint hand-edited/corrupted outside this tool — cannot
 * be ruled out, so the message below does not claim a single cause with
 * certainty.
 */
export function assertCheckpointRowsAreCoherent(
  rows: readonly SimRowResult[],
  checkpointPath: string
): void {
  try {
    assertRowsInternallyCoherent(rows)
  } catch (err) {
    const offendingIds = findIncoherentRowIds(rows)
    const capped = offendingIds.length > MAX_IDS_IN_CHECKPOINT_REMEDIATION
    const idList = capped
      ? `${offendingIds.slice(0, MAX_IDS_IN_CHECKPOINT_REMEDIATION).join(', ')}, and ${offendingIds.length - MAX_IDS_IN_CHECKPOINT_REMEDIATION} more`
      : offendingIds.join(', ')
    throw new Error(
      `SMI-6481: checkpoint at ${checkpointPath} contains ${offendingIds.length} internally-` +
        `inconsistent row(s), refused before any scan/fetch was attempted: ${(err as Error).message} ` +
        'This checkpoint was very likely written by pre-SMI-6436 classification code (which could ' +
        'mislabel a real newly_quarantined/newly_cleared verdict flip as bundle_absent) — or, less ' +
        "likely, by a defect in the CURRENT classifier that slipped past this run's own per-batch " +
        'validation (runMainPass/runSweepPhase), or by external tampering with the checkpoint file. ' +
        "PREFERRED FIX (surgical — preserves every other row's recorded progress on what can be a " +
        `multi-day scan): remove exactly these row id(s) from the checkpoint's own row_results so ` +
        `this run re-scans them fresh under the fixed classifier: ${idList}` +
        (capped
          ? " (enumerate the full list offline with: npx tsx -e \"import{readFileSync}from'node:fs';" +
            "import{findIncoherentRowIds}from'./scripts/indexer/smi5879-merge-shards.outcome-coherence.ts';" +
            `const c=JSON.parse(readFileSync('${checkpointPath}','utf8'));` +
            'console.log(findIncoherentRowIds(Object.values(c.row_results)))")'
          : '') +
        '. LAST-RESORT COLD START (only if the surgical fix above is impractical — e.g. most of the ' +
        `checkpoint is affected): delete the checkpoint (${checkpointPath}) entirely and start a fresh ` +
        'run — this discards ALL progress recorded in it, not just the offending row(s), which can be ' +
        'a significant cost on a multi-day scan.',
      { cause: err }
    )
  }
}
