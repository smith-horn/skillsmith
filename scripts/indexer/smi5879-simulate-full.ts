/**
 * SMI-5879 Wave 3 item 3: the real, gate-eligible pre-merge simulator.
 * @module scripts/indexer/smi5879-simulate-full
 *
 * Writes `report_kind: "full_simulation"` — the ONLY report shape
 * `gate-check.ts` (item 4) accepts for G-2. See
 * `smi5879-simulate-preflight-estimate.ts` for the sampled, non-gate-eligible
 * sibling tool.
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.2/§8.3.5/§8.5
 *
 * Lifecycle: validate args (hard-refuse `token_source==='app'`) -> load run
 * summary, refuse if not `sealed`/purpose mismatch -> claim
 * (`smi5879_claim_run`) -> start independent-timer heartbeat -> verify digest
 * (cold start, or resuming an abnormal prior termination) -> load population +
 * branch map -> main pass (batched, checkpointed) -> tier-3 sweep on the
 * `unevaluable` residual -> release claim -> write report.
 *
 * CLI contract, mirroring smi5879-census.ts's own --dry-run/--apply
 * precedent (which itself follows revalidate-stale-quarantines.ts's):
 * `--dry-run` is the DEFAULT — validates args, DB connectivity, and
 * PAT-only GitHub auth, WITHOUT claiming or fetching anything. `--apply`
 * performs the real run. UNLIKE revalidate-stale-quarantines.ts, this tool
 * NEVER writes to `skills` in either mode — "apply" here means only "claim
 * the generation, perform GitHub I/O, and write this tool's own
 * report/checkpoint files, plus the generation's own claim/heartbeat/release
 * fields" — never a `skills` row.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/indexer/smi5879-simulate-full.ts \
 *     --run-id=<sealed generation run_id> --purpose=<decision|window|rehearsal> \
 *     [--apply] [--checkpoint-path=<path>] [--report-path=<path>] [--baseline-commit=<sha>]
 */

import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { newRateLimitTelemetry, pMapBounded } from './_shared/rate-limit.ts'
import { poolerSessionConnParams, runPsql } from './smi5879-census.pg.ts'
import { createSmi5879SimulateFullDbDeps } from './smi5879-simulate-full.db.ts'
import {
  materializeBaseline,
  importBaselineScanSkillBundle,
  BASELINE_COMMIT_SHA,
} from './smi5879-simulate-full.baseline.ts'
import { scanSkillBundle as headScanSkillBundle } from './skill-processor.security.ts'
import {
  processRow,
  assertPatTokenSource,
  CHECKPOINT_BATCH_SIZE,
  PROCESS_CONCURRENCY,
  HEARTBEAT_INTERVAL_MS,
} from './smi5879-simulate-full.helpers.ts'
import {
  computeCoverage,
  summarizeCounts,
  estimateCompletionAt,
  checkpointPathFor,
  readCheckpoint,
  writeCheckpoint,
  isAbnormalResume,
  runTier3Sweep,
  decideExitCode,
  assertCheckpointIdentity,
  assertCheckpointRowsBelongToGeneration,
} from './smi5879-simulate-full.sweep.ts'
import type {
  Smi5879SimulateFullDbDeps,
  Smi5879SimulateCheckpoint,
  Smi5879SimulateFullReport,
  SimSnapshotRow,
  SimulatedCohort,
  ScanSkillBundleFn,
} from './smi5879-simulate-full.types.ts'
import type { Smi5879Purpose } from './smi5879-census.types.ts'

const SIMULATED_COHORTS: readonly SimulatedCohort[] = ['C1', 'C2', 'C3', 'C4']
const VALID_PURPOSES: readonly Smi5879Purpose[] = ['rehearsal', 'decision', 'window']

export interface CliArgs {
  runId: string
  purpose: Smi5879Purpose
  apply: boolean
  checkpointPath?: string
  reportPath?: string
  baselineCommit: string
}

export function parseArgs(argv: string[]): CliArgs {
  const find = (name: string): string | undefined => {
    const prefix = `--${name}=`
    const hit = argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
  }
  const runId = find('run-id')
  if (!runId) throw new Error('SMI-5879: --run-id=<generation run_id> is required.')
  const purpose = find('purpose')
  if (!purpose || !VALID_PURPOSES.includes(purpose as Smi5879Purpose)) {
    throw new Error(
      `SMI-5879: --purpose=<${VALID_PURPOSES.join('|')}> is required, got ${purpose ?? '(missing)'}.`
    )
  }
  // `checkpointPath`/`reportPath` are genuinely optional (downstream defaults via
  // `?? checkpointPathFor(...)` / `?? 'smi5879-simulate-report-...'`) — under
  // `exactOptionalPropertyTypes`, an optional property means "may be omitted",
  // not "may be omitted OR explicitly `undefined`", so the key must be left off
  // entirely when the flag wasn't passed rather than assigned `undefined`.
  const checkpointPath = find('checkpoint-path')
  const reportPath = find('report-path')
  return {
    runId,
    purpose: purpose as Smi5879Purpose,
    apply: argv.includes('--apply'),
    ...(checkpointPath !== undefined ? { checkpointPath } : {}),
    ...(reportPath !== undefined ? { reportPath } : {}),
    baselineCommit: find('baseline-commit') ?? BASELINE_COMMIT_SHA,
  }
}

/** `host:pid:git-head`, for `smi5879_run.runner_holder` — mirrors smi5879-census.ts's buildHolder(). */
function buildHolder(): string {
  let head = 'unknown'
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    // Not fatal — operator legibility only.
  }
  return `${hostname()}:${process.pid}:${head}`
}

/**
 * Run the main pass over every not-yet-attempted row (from the checkpoint, if
 * resuming), in concurrency-bounded batches, checkpointing after each batch.
 */
async function runMainPass(
  rows: SimSnapshotRow[],
  alreadyResults: Map<string, import('./smi5879-simulate-full.types.ts').SimRowResult>,
  branchMap: import('./smi5879-simulate-full.types.ts').BranchMap,
  scanDeps: {
    scanPostPort: ScanSkillBundleFn
    scanPrePort: ScanSkillBundleFn
    telemetry: ReturnType<typeof newRateLimitTelemetry>
    headers: Record<string, string>
  },
  onBatchDone: (
    results: Map<string, import('./smi5879-simulate-full.types.ts').SimRowResult>
  ) => Promise<void>
): Promise<void> {
  const pending = rows.filter((r) => !alreadyResults.has(r.id))
  for (let i = 0; i < pending.length; i += CHECKPOINT_BATCH_SIZE) {
    const batch = pending.slice(i, i + CHECKPOINT_BATCH_SIZE)
    const outcomes = await pMapBounded(batch, (row) => processRow(row, branchMap, scanDeps), {
      concurrency: PROCESS_CONCURRENCY,
    })
    for (const outcome of outcomes) alreadyResults.set(outcome.id, outcome)
    await onBatchDone(alreadyResults)
  }
}

/**
 * Run the full generation lifecycle and return the assembled report.
 * Exported for the test suite; `main()` is the CLI entrypoint.
 */
export async function runSimulateFull(
  db: Smi5879SimulateFullDbDeps,
  scanPostPort: ScanSkillBundleFn,
  scanPrePort: ScanSkillBundleFn,
  args: CliArgs,
  env: NodeJS.ProcessEnv = process.env
): Promise<Smi5879SimulateFullReport> {
  const tokenSource = assertPatTokenSource(env)

  const summary = await db.getRunSummary(args.runId)
  if (!summary) throw new Error(`SMI-5879: no smi5879_run row for run_id=${args.runId}.`)
  if (summary.status !== 'sealed') {
    throw new Error(
      `SMI-5879: generation ${args.runId} is "${summary.status}", not "sealed" — the simulator ` +
        'only runs against a sealed generation.'
    )
  }
  if (summary.purpose !== args.purpose) {
    throw new Error(
      `SMI-5879: generation ${args.runId} has purpose "${summary.purpose}", but --purpose=` +
        `${args.purpose} was given. Refusing to run against the wrong generation.`
    )
  }

  const checkpointPath = args.checkpointPath ?? checkpointPathFor(args.runId)
  const existingCheckpoint = readCheckpoint(checkpointPath)
  const isColdStart = existingCheckpoint === null

  if (existingCheckpoint) {
    // Identity check FIRST, before the (pre-existing) baseline_commit check
    // and before claiming — a wrong --checkpoint-path pointing at another
    // generation's checkpoint must be refused loudly, never silently
    // trusted (SMI-5879 review finding 1).
    assertCheckpointIdentity(
      existingCheckpoint,
      { runId: args.runId, purpose: args.purpose, tokenSource },
      checkpointPath
    )
    if (existingCheckpoint.baseline_commit !== args.baselineCommit) {
      throw new Error(
        `SMI-5879: existing checkpoint at ${checkpointPath} was computed against baseline commit ` +
          `${existingCheckpoint.baseline_commit}, but this run resolved ${args.baselineCommit}. A ` +
          'resume must use the SAME baseline pin as the original run — start a fresh checkpoint path instead.'
      )
    }
  }

  const token = randomUUID()
  const holder = buildHolder()
  const claimed = await db.claimRun(args.runId, token, holder)
  if (!claimed.claimed) {
    throw new Error(
      `SMI-5879: claim of generation ${args.runId} was refused — held by another runner.`
    )
  }

  const startedAt = new Date(existingCheckpoint?.started_at ?? new Date().toISOString())

  let checkpoint: Smi5879SimulateCheckpoint = existingCheckpoint ?? {
    run_id: args.runId,
    purpose: args.purpose,
    baseline_commit: args.baselineCommit,
    token_source: tokenSource,
    clean_shutdown: false,
    row_results: {},
    sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
    started_at: startedAt.toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Self-rescheduling setTimeout loop rather than setInterval (SMI-5879
  // review finding 4): the NEXT heartbeat call is only scheduled after the
  // current one settles, so a slow db.heartbeat() call from one tick can
  // never overlap with a second in-flight call from the next tick.
  // db.heartbeat()'s own rejection (transient network/psql failure) gets
  // the SAME fatal-abort treatment as a `result === null` (lost claim) —
  // design doc 8.3.5.2.5 treats "lost claim OR a genuine error" identically,
  // never re-claiming and never silently swallowing either.
  let heartbeatTimer: NodeJS.Timeout | null = null
  let heartbeatStopped = false

  const fatalHeartbeatAbort = (message: string): void => {
    heartbeatStopped = true
    checkpoint.clean_shutdown = false
    writeCheckpoint(checkpointPath, checkpoint)
    console.error(`[smi5879-simulate-full] FATAL: ${message} Exiting without re-claiming.`)
    process.exit(1)
  }

  const scheduleHeartbeat = (): void => {
    heartbeatTimer = setTimeout(() => {
      void runHeartbeatTick()
    }, HEARTBEAT_INTERVAL_MS)
    heartbeatTimer.unref?.()
  }

  const runHeartbeatTick = async (): Promise<void> => {
    if (heartbeatStopped) return
    let result: string | null
    try {
      result = await db.heartbeat(args.runId, token)
    } catch (err) {
      fatalHeartbeatAbort(
        `heartbeat call threw for run_id=${args.runId}: ${(err as Error).message}`
      )
      return
    }
    if (result === null) {
      fatalHeartbeatAbort(
        `heartbeat lost for run_id=${args.runId} — claim was stolen or the run was abandoned.`
      )
      return
    }
    if (!heartbeatStopped) scheduleHeartbeat()
  }

  scheduleHeartbeat()

  try {
    if (isColdStart || isAbnormalResume(existingCheckpoint)) {
      const digest = await db.verifyDigest(args.runId)
      if (!digest.populationMatches || !digest.branchMatches) {
        checkpoint.clean_shutdown = false
        writeCheckpoint(checkpointPath, checkpoint)
        throw new Error(
          `SMI-5879: digest verification failed for run_id=${args.runId} ` +
            `(population_matches=${digest.populationMatches}, branch_matches=${digest.branchMatches}). ` +
            'The generation is corrupt — the correct action is a new generation, not a repair.'
        )
      }
    }

    const rows = await db.loadCohortRows(args.runId)
    if (existingCheckpoint) {
      // Must run only after the real row set for this generation is loaded
      // (SMI-5879 review finding 1) — refuses a checkpoint whose row_results
      // keys don't correspond to any row in THIS generation.
      assertCheckpointRowsBelongToGeneration(existingCheckpoint, rows, checkpointPath)
    }
    const branchMap = await db.loadBranchMap(args.runId)
    const rowsByCohort = { C1: [], C2: [], C3: [], C4: [] } as Record<
      SimulatedCohort,
      SimSnapshotRow[]
    >
    for (const row of rows) rowsByCohort[row.cohort].push(row)

    const telemetry = newRateLimitTelemetry()
    const headers = await buildGitHubHeaders('skillsmith-smi5879-simulate/1.0')
    const scanDeps = { scanPostPort, scanPrePort, telemetry, headers }

    const results = new Map(Object.entries(checkpoint.row_results))

    await runMainPass(rows, results, branchMap, scanDeps, async (current) => {
      checkpoint = {
        ...checkpoint,
        clean_shutdown: false,
        row_results: Object.fromEntries(current),
        updated_at: new Date().toISOString(),
      }
      writeCheckpoint(checkpointPath, checkpoint)
    })

    // Resume state threaded into the sweep (SMI-5879 review finding 2a) —
    // a crash mid-sweep must not reset the MAX_SWEEP_PASSES budget or the
    // non-decrease hard-stop streak. `priorResidualHistory` is captured ONCE
    // here and `sweepResidualHistory` grows it incrementally via `onPass`
    // (below) as the single source of truth for every per-pass checkpoint
    // write — the final write after the sweep returns reuses the exact same
    // running total rather than re-deriving/re-adding it (finding 2b).
    const priorSweepPass = checkpoint.sweep.pass
    const priorNonDecreaseStreak = checkpoint.sweep.non_decrease_streak
    const priorResidualHistory = [...checkpoint.sweep.residual_history]
    const sweepResidualHistory: number[] = [...priorResidualHistory]

    const residual = [...results.values()].filter((r) => r.outcome === 'unevaluable')
    const sweep = await runTier3Sweep(
      residual,
      async (residualIds) => {
        const idSet = new Set(residualIds)
        const targets = rows.filter((r) => idSet.has(r.id))
        const outcomes = await pMapBounded(targets, (row) => processRow(row, branchMap, scanDeps), {
          concurrency: PROCESS_CONCURRENCY,
        })
        const updated = new Map(outcomes.map((o) => [o.id, o]))
        for (const [id, result] of updated) results.set(id, result)
        return updated
      },
      {
        startingPass: priorSweepPass,
        startingNonDecreaseStreak: priorNonDecreaseStreak,
        onPass: (pass, residualSize, nonDecreaseStreak) => {
          sweepResidualHistory.push(residualSize)
          checkpoint = {
            ...checkpoint,
            clean_shutdown: false,
            row_results: Object.fromEntries(results),
            sweep: {
              pass,
              residual_history: [...sweepResidualHistory],
              non_decrease_streak: nonDecreaseStreak,
              hard_stopped: null,
            },
            updated_at: new Date().toISOString(),
          }
          writeCheckpoint(checkpointPath, checkpoint)
        },
      }
    )

    const coverage = computeCoverage(rowsByCohort, results)
    const counts = summarizeCounts(results.values())
    const totalRows = rows.length
    const scannedRows = results.size

    checkpoint = {
      ...checkpoint,
      clean_shutdown: true,
      row_results: Object.fromEntries(results),
      sweep: {
        pass: sweep.passesRun,
        residual_history: [...priorResidualHistory, ...sweep.residualHistory],
        non_decrease_streak: sweep.nonDecreaseStreak,
        hard_stopped: sweep.hardStopped,
      },
      updated_at: new Date().toISOString(),
    }
    writeCheckpoint(checkpointPath, checkpoint)

    const report: Smi5879SimulateFullReport = {
      report_kind: 'full_simulation',
      run_id: args.runId,
      purpose: args.purpose,
      status: summary.status,
      token_source: tokenSource,
      baseline_commit: args.baselineCommit,
      coverage,
      estimated_completion_at: estimateCompletionAt(startedAt, new Date(), totalRows, scannedRows),
      sweep: { passes_run: checkpoint.sweep.pass, hard_stopped: sweep.hardStopped },
      rows: [...results.values()],
      counts,
      generated_at: new Date().toISOString(),
    }
    return report
  } finally {
    heartbeatStopped = true
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    await db.releaseRun(args.runId, token).catch((err) => {
      console.error(`[smi5879-simulate-full] release failed (non-fatal): ${(err as Error).message}`)
    })
  }
}

function printSummary(report: Smi5879SimulateFullReport): void {
  console.log(
    `\n── Simulation Summary (${report.run_id}) ──\n` +
      `  report_kind:       ${report.report_kind}\n` +
      `  token_source:      ${report.token_source}\n` +
      `  baseline_commit:   ${report.baseline_commit}\n` +
      `  sweep:             ${report.sweep.passes_run} pass(es), hard_stopped=${report.sweep.hard_stopped ?? 'none'}\n` +
      SIMULATED_COHORTS.map(
        (c) =>
          `  coverage.${c}:       ${report.coverage[c].status} (${report.coverage[c].scanned}/${report.coverage[c].total}, unevaluable=${report.coverage[c].unevaluable}, unfetchable=${report.coverage[c].unfetchable})`
      ).join('\n') +
      `\n  counts: ${JSON.stringify(report.counts)}\n`
  )
}

async function dryRun(args: CliArgs): Promise<void> {
  console.log(
    `[DRY-RUN] run-id=${args.runId} purpose=${args.purpose} baseline-commit=${args.baselineCommit}`
  )
  assertPatTokenSource()
  const conn = poolerSessionConnParams()
  await runPsql(conn, 'SELECT 1;')
  console.log('[DRY-RUN] DB connectivity OK (session pooler).')
  const headers = await buildGitHubHeaders('skillsmith-smi5879-simulate/1.0')
  console.log(
    `[DRY-RUN] GitHub auth headers built (Authorization present: ${'Authorization' in headers}).`
  )
  console.log(
    '[DRY-RUN] No generation claimed, no GitHub fetches performed, no checkpoint/report written. ' +
      'Re-run with --apply to perform the real simulation.'
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.apply) {
    await dryRun(args)
    return
  }
  const conn = poolerSessionConnParams()
  const db = createSmi5879SimulateFullDbDeps(conn)
  const baselineDir = materializeBaseline(args.baselineCommit)
  const { scanSkillBundle: scanPrePort } = await importBaselineScanSkillBundle(baselineDir)

  const report = await runSimulateFull(db, headScanSkillBundle, scanPrePort, args)
  const reportPath = args.reportPath ?? `smi5879-simulate-report-${args.runId}.json`
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  printSummary(report)
  console.log(`Report written to ${reportPath}`)

  process.exitCode = decideExitCode(report.coverage, report.sweep.hard_stopped)
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
