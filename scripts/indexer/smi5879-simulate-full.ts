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
 * SMI-6015 Wave 1 added `--max-elapsed-minutes=<N>` (wall-clock
 * self-checkpoint-and-exit) and `--cohorts=<comma-list>` (cohort-scoped
 * rehearsal dispatches) — see `smi5879-simulate-full.cli.ts` for parsing.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/indexer/smi5879-simulate-full.ts \
 *     --run-id=<sealed generation run_id> --purpose=<decision|window|rehearsal> \
 *     [--apply] [--checkpoint-path=<path>] [--report-path=<path>] [--baseline-commit=<sha>] \
 *     [--max-elapsed-minutes=<N>] [--cohorts=<comma-list>]
 */

import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { newRateLimitTelemetry } from './_shared/rate-limit.ts'
import { poolerSessionConnParams, runPsql } from './smi5879-census.pg.ts'
import { createSmi5879SimulateFullDbDeps } from './smi5879-simulate-full.db.ts'
import {
  materializeBaseline,
  importBaselineScanSkillBundle,
} from './smi5879-simulate-full.baseline.ts'
import { scanSkillBundle as headScanSkillBundle } from './skill-processor.security.ts'
import { parseArgs, type CliArgs } from './smi5879-simulate-full.cli.ts'
import {
  runMainPass,
  assertPatTokenSource,
  HEARTBEAT_INTERVAL_MS,
} from './smi5879-simulate-full.helpers.ts'
import {
  computeCoverage,
  summarizeCounts,
  estimateCompletionAt,
  runSweepPhase,
  decideExitCode,
} from './smi5879-simulate-full.sweep.ts'
import {
  checkpointPathFor,
  readCheckpoint,
  writeCheckpoint,
  isAbnormalResume,
  assertCheckpointIdentity,
  assertCheckpointRowsBelongToGeneration,
} from './smi5879-simulate-full.checkpoint.ts'
import { ALL_SIMULATED_COHORTS } from './smi5879-simulate-full.types.ts'
import type {
  Smi5879SimulateFullDbDeps,
  Smi5879SimulateCheckpoint,
  Smi5879SimulateFullReport,
  SimSnapshotRow,
  SimulatedCohort,
  ScanSkillBundleFn,
} from './smi5879-simulate-full.types.ts'

export { parseArgs, type CliArgs }

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

// runMainPass lives in smi5879-simulate-full.helpers.ts (500-line budget)

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

  // SMI-6015 Wave 1: the resolved cohort scope for THIS invocation — always
  // explicit (never left as an implicit "undefined means all four"), so
  // checkpoint identity/coverage code never has to special-case "omitted."
  const cohorts: SimulatedCohort[] = args.cohorts ?? [...ALL_SIMULATED_COHORTS]

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
      { runId: args.runId, purpose: args.purpose, tokenSource, cohorts },
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
  // SMI-6015 Wave 1: THIS invocation's own deadline (Date.now() now +
  // --max-elapsed-minutes) — deliberately independent of `startedAt` above
  // (the checkpoint's persisted, cross-dispatch start, used only for ETA).
  // Mirrors `smi5879-census.branches.ts`'s `sweepTransientRepos`: a GHA
  // `timeout-minutes` ceiling bounds THIS dispatch, not the whole effort.
  const deadlineAtMs =
    args.maxElapsedMinutes !== undefined ? Date.now() + args.maxElapsedMinutes * 60_000 : undefined

  let checkpoint: Smi5879SimulateCheckpoint = existingCheckpoint ?? {
    run_id: args.runId,
    purpose: args.purpose,
    baseline_commit: args.baselineCommit,
    token_source: tokenSource,
    cohorts,
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
    const totalRows = rows.length
    if (existingCheckpoint) {
      // Must run only after the real row set for this generation is loaded
      // (SMI-5879 review finding 1) — refuses a checkpoint whose row_results
      // keys don't correspond to any row in THIS generation.
      assertCheckpointRowsBelongToGeneration(existingCheckpoint, rows, checkpointPath)
    }
    const branchMap = await db.loadBranchMap(args.runId)
    // SMI-6015 Wave 1 correctness guard-rail: `rowsByCohort` stays built
    // from the FULL `rows` regardless of `--cohorts` — an excluded cohort
    // must report its real `total` (scanned: 0, status: 'partial'), never a
    // spuriously-`full` total: 0. Only `rowsForMainPass` is filtered.
    const rowsByCohort = { C1: [], C2: [], C3: [], C4: [] } as Record<
      SimulatedCohort,
      SimSnapshotRow[]
    >
    for (const row of rows) rowsByCohort[row.cohort].push(row)
    const rowsForMainPass =
      args.cohorts !== undefined ? rows.filter((r) => cohorts.includes(r.cohort)) : rows

    const telemetry = newRateLimitTelemetry()
    // SMI-6015: getHeaders is invoked fresh on every fetch attempt (inside
    // retryPrimaryFetch), not built once here and frozen for the whole
    // (potentially multi-day) run — buildGitHubHeaders()/getInstallationToken()
    // already cache and only re-mint near expiry, so this costs ~nil when fresh.
    const getHeaders = () => buildGitHubHeaders('skillsmith-smi5879-simulate/1.0')
    const scanDeps = { scanPostPort, scanPrePort, telemetry, getHeaders }

    const results = new Map(Object.entries(checkpoint.row_results))

    /** Assemble the gate-eligible report from current state — shared by the normal-completion and deadline-exit paths. */
    const buildReport = (
      scannedRows: number,
      sweepInfo: {
        passes_run: number
        hard_stopped: Smi5879SimulateFullReport['sweep']['hard_stopped']
      }
    ): Smi5879SimulateFullReport => ({
      report_kind: 'full_simulation',
      run_id: args.runId,
      purpose: args.purpose,
      status: summary.status,
      token_source: tokenSource,
      baseline_commit: args.baselineCommit,
      coverage: computeCoverage(rowsByCohort, results),
      estimated_completion_at: estimateCompletionAt(startedAt, new Date(), totalRows, scannedRows),
      sweep: sweepInfo,
      rows: [...results.values()],
      counts: summarizeCounts(results.values()),
      generated_at: new Date().toISOString(),
    })

    const mainPassResult = await runMainPass(
      rowsForMainPass,
      results,
      branchMap,
      scanDeps,
      async (current) => {
        checkpoint = {
          ...checkpoint,
          clean_shutdown: false,
          row_results: Object.fromEntries(current),
          updated_at: new Date().toISOString(),
        }
        writeCheckpoint(checkpointPath, checkpoint)
      },
      deadlineAtMs
    )

    // SMI-6015 Wave 1: a deadline hit is an EXPECTED, non-fatal stop, never
    // a crash — `clean_shutdown: true` is correct (the checkpoint is fully
    // consistent, so a resume should not pay the abnormal-resume digest
    // re-verification cost for something that isn't actually suspect).
    // `decideExitCode` naturally returns 1 on the resulting partial
    // coverage, which the workflow interprets as "continues, re-dispatch."
    const exitOnDeadline = (reason: string): Smi5879SimulateFullReport => {
      console.log(
        `[smi5879-simulate-full] run_id=${args.runId} ${reason} — ${results.size}/${totalRows} ` +
          'rows scanned. Writing checkpoint and exiting for re-dispatch (never a hard failure).'
      )
      checkpoint = {
        ...checkpoint,
        clean_shutdown: true,
        row_results: Object.fromEntries(results),
        updated_at: new Date().toISOString(),
      }
      writeCheckpoint(checkpointPath, checkpoint)
      return buildReport(results.size, {
        passes_run: checkpoint.sweep.pass,
        hard_stopped: checkpoint.sweep.hard_stopped,
      })
    }

    if (mainPassResult.deadlineExceeded) {
      return exitOnDeadline(
        `wall-clock deadline (--max-elapsed-minutes=${args.maxElapsedMinutes}) reached mid-main-pass`
      )
    }
    // Deadline reached exactly as the main pass finished — skip the tier-3
    // sweep this dispatch (its own SWEEP_COOLDOWN_MS cooldown is not itself
    // deadline-aware; a documented Wave 1 bound, not a silent gap — the
    // sweep only reprocesses the smaller `unevaluable` residual and stays
    // separately bounded by MAX_SWEEP_PASSES/SWEEP_COOLDOWN_MS).
    // TESTING NOTE: this exact branch shares 100% of its behavior with the
    // `mainPassResult.deadlineExceeded` branch above (the same `exitOnDeadline`
    // helper) — only the triggering condition differs. It sits in the same
    // synchronous continuation as that check (no `await` between them), so a
    // black-box test cannot advance the clock into the narrow window between
    // them without mocking `runMainPass` itself; deliberately not covered by
    // a dedicated test for that reason — reviewed by inspection instead.
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
      return exitOnDeadline(
        'wall-clock deadline reached after the main pass — skipping the tier-3 sweep'
      )
    }

    // Tier-3 sweep phase — extracted to smi5879-simulate-full.sweep.ts's
    // `runSweepPhase` (SMI-6015 Wave 1: 500-line budget). See its own doc
    // comments for the resume/finding-2a/2b and abort-checkpoint rationale.
    const sweepResult = await runSweepPhase(
      rows,
      branchMap,
      scanDeps,
      results,
      checkpoint,
      checkpointPath
    )
    checkpoint = sweepResult.checkpoint

    return buildReport(results.size, {
      passes_run: checkpoint.sweep.pass,
      hard_stopped: sweepResult.hardStopped,
    })
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
      ALL_SIMULATED_COHORTS.map(
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
