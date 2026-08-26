/**
 * SMI-6015 PAT-sharded fetch, Wave 2 item 3: the N-way shard-report merge
 * tool. Reads N `report_kind: 'full_simulation'` reports — one per completed,
 * sealed shard of ONE decision generation — and produces the single merged
 * report `smi5879-gate-check.ts` evaluates.
 * @module scripts/indexer/smi5879-merge-shards
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 3. N-way checkpoint/report merge tool (new script)")
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.3.5.2.4/§8.4/§8.5
 *
 * WHY THIS TOOL IS SAFETY-CRITICAL
 * --------------------------------
 * `smi5879-gate-check.ts` accepts exactly ONE `full_simulation` report per
 * decision `run_id` (`smi5879-gate-check.io.ts`, `evaluateG2`) and derives a
 * merge-gate decision from it. This is the THIRD write site of that report
 * shape (after `smi5879-simulate-full.ts` and its deadline-exit path), and
 * the only one that constructs a report from data it did not itself observe.
 * Everything the gate believes about population coverage flows through here.
 *
 * Two siblings hold the substance (CLAUDE.md's <500-line-per-file convention,
 * mirroring how `smi5879-simulate-full.ts` splits
 * `.cli.ts`/`.checkpoint.ts`/`.sweep.ts`/`.output.ts`): `.merge-rules.ts` owns
 * every row of the plan's merge-rule table and its invariants, and
 * `.population.ts` owns the digest-verified population load plus the
 * set-equality check that is the actual safety property — both files state
 * that property in full in their own module docs. THIS file owns argument
 * parsing, shard-report loading, orchestration ORDER, and the atomic,
 * self-validating write.
 *
 * ORDER MATTERS. The population is loaded ONLY after `verifyDigest` confirms
 * the sealed generation still hashes to what it hashed to at seal time — the
 * same `smi5879_population_digest()` re-verification `runSimulateFull`
 * performs on a cold start and `bindGeneration` performs for every gate. A
 * set-equality check against an unverified population proves nothing, because
 * the population itself could have drifted to match a corrupted merge.
 *
 * There is deliberately NO flag to skip the population verification. A merge
 * produced without it is not a weaker artifact, it is an unsound one, and an
 * escape hatch on this path would be an escape hatch on the merge gate.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/indexer/smi5879-merge-shards.ts \
 *     --run-id=<sealed decision generation run_id> \
 *     --reports=<path1>,<path2>,<path3> \
 *     --output=<merged-report-path>
 */

import { renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { poolerSessionConnParams } from './smi5879-census.pg.ts'
import { createSmi5879SimulateFullDbDeps } from './smi5879-simulate-full.db.ts'
import { loadSimulatorReport } from './smi5879-gate-check.io.ts'
import { printSummary } from './smi5879-simulate-full.output.ts'
import { decideExitCode } from './smi5879-simulate-full.sweep.ts'
import {
  assembleMergedReport,
  assertCountsBalance,
  assertIdenticalIdentityFields,
  assertShardReportNumericSanity,
  mergeCoverage,
  mergeRows,
  mergeSweep,
  recomputeCounts,
  type ShardReportInput,
} from './smi5879-merge-shards.merge-rules.ts'
import {
  assertRowOutcomeCoherence,
  assertRowOutcomeFieldPresence,
} from './smi5879-merge-shards.outcome-coherence.ts'
import {
  assertCoverageTotalsMatchPopulation,
  assertMergedRowsMatchPopulation,
  assertReportsBindToGeneration,
  loadVerifiedPopulation,
  type Smi5879MergeShardsDbDeps,
} from './smi5879-merge-shards.population.ts'
import type { Smi5879SimulateFullReport } from './smi5879-simulate-full.types.ts'

export type { Smi5879MergeShardsDbDeps }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface MergeShardsCliArgs {
  runId: string
  /** Absolute-or-relative paths, in the operator's own order; at least one. */
  reportPaths: string[]
  outputPath: string
}

export function parseArgs(argv: string[]): MergeShardsCliArgs {
  const find = (name: string): string | undefined => {
    const prefix = `--${name}=`
    const hit = argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
  }

  const runId = find('run-id')
  if (!runId) {
    throw new Error('SMI-6015: --run-id=<sealed decision generation run_id> is required.')
  }

  const reportsRaw = find('reports')
  if (reportsRaw === undefined || reportsRaw.trim() === '') {
    throw new Error(
      'SMI-6015: --reports=<path1,path2,...> is required — the per-shard ' +
        'full_simulation report files to merge.'
    )
  }
  const reportPaths = reportsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (reportPaths.length === 0) {
    throw new Error(`SMI-6015: --reports="${reportsRaw}" contained no usable paths.`)
  }
  // A path repeated in --reports would surface downstream as a confusing
  // "row id appears in more than one shard report" for EVERY row of that
  // shard. Catch the actual operator mistake here, comparing resolved paths
  // so two spellings of the same file (`./a.json` and `a.json`) are caught too.
  const seen = new Map<string, string>()
  const repeated: string[] = []
  for (const path of reportPaths) {
    const key = resolve(path)
    const prior = seen.get(key)
    if (prior !== undefined) repeated.push(`${prior} and ${path} resolve to the same file (${key})`)
    else seen.set(key, path)
  }
  if (repeated.length > 0) {
    throw new Error(
      `SMI-6015: --reports lists the same report file more than once — ${repeated.join('; ')}. ` +
        'Each shard report must be passed exactly once.'
    )
  }

  const outputPath = find('output')
  if (!outputPath) {
    throw new Error('SMI-6015: --output=<merged-report-path> is required.')
  }

  return { runId, reportPaths, outputPath }
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

/**
 * Load every shard report through `loadSimulatorReport` — the EXACT validator
 * `smi5879-gate-check.ts` applies to the artifact it gates on, including its
 * `validateSimulatorReportConsistency` cross-check of coverage/rows/counts.
 * A shard report the gate would reject can never become an input to a report
 * the gate is meant to accept, and `loadSimulatorReport`'s
 * missing-vs-malformed distinction is preserved in the thrown message.
 */
export function loadShardReports(reportPaths: readonly string[]): ShardReportInput[] {
  const inputs: ShardReportInput[] = []
  for (const path of reportPaths) {
    const loaded = loadSimulatorReport(path, 'shard report')
    if (loaded.status !== 'ok') {
      throw new Error(
        `SMI-6015: cannot merge — shard report at ${path} is ${loaded.status}: ${loaded.reason}. ` +
          'Every shard report must be a complete, well-formed full_simulation report before it can ' +
          'contribute to a gate-eligible merged report.'
      )
    }
    const input: ShardReportInput = { path, report: loaded.value }
    assertShardReportNumericSanity(input)
    inputs.push(input)
  }
  return inputs
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the whole merge and return the assembled report. Exported for the test
 * suite; `main()` is the CLI entrypoint (the same split
 * `runSimulateFull`/`main` uses).
 *
 * Ordering is load-bearing: cheap structural checks first (so an operator
 * mistake fails before a DB round trip), then the digest-verified population,
 * then the set-equality check, then every derived field recomputed against
 * the already-verified row set.
 */
export async function runMergeShards(
  db: Smi5879MergeShardsDbDeps,
  args: MergeShardsCliArgs,
  now: Date = new Date()
): Promise<Smi5879SimulateFullReport> {
  const inputs = loadShardReports(args.reportPaths)
  const identity = assertIdenticalIdentityFields(inputs)
  const mergedRows = mergeRows(inputs)
  // Wave 2 adversarial review finding: a row can pass id-disjointness and
  // (later) population set-equality while still carrying an `outcome` label
  // that disagrees with its own prePortQuarantine/postPortQuarantine fields
  // — neither check above would catch that. Cheap, purely local, so it runs
  // before the DB round trip alongside the other structural checks.
  // Round-2 confirmation review found a gap in the round-1 fix: it only
  // covered verdict-delta outcomes, so a real newly_quarantined row
  // mislabeled unfetchable/unevaluable/content_drifted (while still
  // carrying quarantine fields) skipped it entirely. Field-presence runs
  // FIRST — it's the check that actually closes that gap; coherence then
  // only needs to worry about the four outcomes it's scoped to.
  assertRowOutcomeFieldPresence(mergedRows)
  assertRowOutcomeCoherence(mergedRows)

  const { population, summary } = await loadVerifiedPopulation(db, args.runId)
  assertReportsBindToGeneration(identity, args.runId, summary)

  // THE safety property — exact set equality against the digest-verified
  // population. Everything below it is arithmetic over a row set already
  // proven to be the whole population and nothing but the population.
  assertMergedRowsMatchPopulation(mergedRows, population)

  const coverage = mergeCoverage(inputs, mergedRows)
  assertCoverageTotalsMatchPopulation(coverage, population)

  // Recomputed from the merged rows, never summed from the shard reports'
  // own `counts` fields (plan merge-rule table) — and immediately balanced
  // against `rows.length`, so the "recompute, never sum" rule and its
  // invariant stay paired at the call site.
  const counts = recomputeCounts(mergedRows)
  assertCountsBalance(counts, mergedRows)

  const sweep = mergeSweep(inputs)

  return assembleMergedReport(identity, coverage, mergedRows, counts, sweep, now.toISOString())
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Write the merged report atomically, and only after re-reading it through
 * `loadSimulatorReport` — the exact validator the gate will apply.
 *
 * Two precedents combined. The atomic temp-file-then-`renameSync` is
 * `writeCheckpoint`'s (`smi5879-simulate-full.checkpoint.ts`): a crash
 * mid-write can never leave `--output` itself truncated. The round trip
 * through the gate's own loader is this tool's own addition: a merged report
 * that the gate would reject must never reach the path an operator is about
 * to hand the gate. On failure the temp file is deliberately LEFT in place
 * and named in the error, matching `readCheckpoint`'s guidance to inspect a
 * `.tmp` sibling rather than have it silently disappear.
 */
export function writeMergedReport(path: string, report: Smi5879SimulateFullReport): void {
  const tmpPath = `${path}.tmp-${process.pid}`
  writeFileSync(tmpPath, JSON.stringify(report, null, 2))
  const reloaded = loadSimulatorReport(tmpPath, 'merged report')
  if (reloaded.status !== 'ok') {
    throw new Error(
      `SMI-6015: the merged report failed the gate's own simulator-report validation ` +
        `(${reloaded.status}: ${reloaded.reason}). This is a bug in the merge tool, not in the ` +
        `shard reports — ${path} was NOT written. The rejected output is left at ${tmpPath} for ` +
        'inspection.'
    )
  }
  renameSync(tmpPath, path)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const conn = poolerSessionConnParams()
  const db = createSmi5879SimulateFullDbDeps(conn)

  const report = await runMergeShards(db, args)
  writeMergedReport(args.outputPath, report)
  printSummary(report)
  console.log(
    `Merged ${args.reportPaths.length} shard report(s) into ${args.outputPath} ` +
      `(${report.rows.length} rows, set-equal to the digest-verified sealed population).`
  )

  // Same exit-code policy as the simulator itself (`decideExitCode`, reused
  // rather than restated). Note that `scanned === total` is guaranteed by the
  // time we get here — set equality plus the cohort-total cross-check force
  // it — so a non-zero exit from a successful merge means either a non-null
  // `sweep.hard_stopped` or a cohort with unevaluable > 0: real, reportable
  // reasons the gate would return INCONCLUSIVE, surfaced now rather than at
  // gate time.
  process.exitCode = decideExitCode(report.coverage, report.sweep.hard_stopped)
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
