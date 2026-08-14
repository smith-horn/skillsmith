/**
 * SMI-5879 Wave 3 item 1: create, populate, resolve, seal, and validate one
 * snapshot generation for the pre-merge safety-gate harness.
 * @module scripts/indexer/smi5879-census
 *
 * Deliberately NO shebang (unlike revalidate-stale-quarantines.ts and its
 * siblings): this file is always invoked via `npx tsx scripts/indexer/
 * smi5879-census.ts`, never executed directly, and `run-gate-callsites.
 * test.ts`'s Shape-3 census pins the exact set of shebang-bearing indexer
 * files — adding one here for a purely cosmetic convention isn't worth
 * touching that pinned set. See that test's Shape-4 section for why this
 * file's `import.meta.url` direct-entry guard is deliberately NOT paired
 * with `assertRunAllowed`/`assertFreezeMarkerClear`.
 *
 * Design doc: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.3.5.2
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md, item 1
 *
 * Lifecycle: create generation (`smi5879_run` INSERT, `open`) -> claim
 * (`smi5879_claim_run`) -> populate `smi5879_snapshot_pre` in one `REPEATABLE READ`
 * transaction (design doc's exact "Population load" SQL, §8.3.5.2.3) -> resolve
 * `default_branch` per distinct repo (`rehearsal`/`decision` only — a `window`
 * generation performs no GitHub I/O, §8.3.5.2.2) -> seal (count + digest + status
 * flip in one transaction, §8.3.5.2.4) -> release claim -> run I-1..I-5 (fail
 * closed) -> write the machine-readable census report.
 *
 * CLI contract, mirroring revalidate-stale-quarantines.ts's --dry-run/--apply
 * precedent (Wave 3 plan item 1): `--dry-run` is the DEFAULT. Unlike that script,
 * this tool has no idempotent/safe-to-repeat default action — creating a
 * generation, claiming it, and loading 300K+ rows are exactly the operations the
 * `smi5879_run_one_open` mutual-exclusion index exists to serialize, so
 * `--dry-run` here means "validate arguments and DB/GitHub connectivity only —
 * create, claim, populate NOTHING." `--apply` performs the real lifecycle above.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/indexer/smi5879-census.ts \
 *     --purpose=rehearsal --ruleset-epoch=2026-07-29T23:41:09Z [--apply] [--report-path=<path>]
 */

import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  poolerSessionConnParams,
  runPsql,
  queryRows,
  queryScalar,
  nullable,
  type PgConnParams,
} from './smi5879-census.pg.ts'
import {
  resolveDefaultBranches,
  sweepTransientRepos,
  queryBranchResolutionCounts,
} from './smi5879-census.branches.ts'
import { runInvariantChecks, checkI6BranchResolutionQuality } from './smi5879-census.invariants.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { newRateLimitTelemetry } from './_shared/rate-limit.ts'
import type {
  BranchResolutionSummary,
  CohortCounts,
  Smi5879CensusReport,
  Smi5879Purpose,
} from './smi5879-census.types.ts'

const VALID_PURPOSES: readonly Smi5879Purpose[] = ['rehearsal', 'decision', 'window']
const HEARTBEAT_INTERVAL_MS = 60_000
const RULESET_EPOCH_PROVENANCE =
  '`last_scanned_at` freshness is a date-based proxy for ruleset version (no ' +
  '`scanner_ruleset_version` column exists on `skills` — migration 039 adds only ' +
  'content_hash/last_scanned_at/security_score/security_findings/quarantined). The ' +
  'proxy over-includes into C3 (a row scanned recently under an older ruleset looks ' +
  'fresh), which enlarges the fully-simulated population — cost, not risk (design doc 8.3.1.5).'

export interface CliArgs {
  purpose: Smi5879Purpose
  rulesetEpoch: string
  apply: boolean
  reportPath: string
}

/** Parse and validate CLI args. Throws with a clear, actionable message on any problem. */
export function parseArgs(argv: string[]): CliArgs {
  const find = (name: string): string | undefined => {
    const prefix = `--${name}=`
    const hit = argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
  }

  const purpose = find('purpose')
  if (!purpose || !VALID_PURPOSES.includes(purpose as Smi5879Purpose)) {
    throw new Error(
      `SMI-5879: --purpose=<${VALID_PURPOSES.join('|')}> is required, got ${purpose ?? '(missing)'}.`
    )
  }
  const rulesetEpoch = find('ruleset-epoch')
  if (!rulesetEpoch || Number.isNaN(Date.parse(rulesetEpoch))) {
    throw new Error(
      `SMI-5879: --ruleset-epoch=<ISO8601> is required and must be a parseable date, got ${rulesetEpoch ?? '(missing)'}.`
    )
  }
  const apply = argv.includes('--apply')
  const reportPath = find('report-path') ?? `smi5879-census-report-${Date.now()}.json`

  return { purpose: purpose as Smi5879Purpose, rulesetEpoch, apply, reportPath }
}

/** `host:pid:git-head`, for `smi5879_run.runner_holder` (design doc 8.3.5.2.5). */
function buildHolder(): string {
  let head = 'unknown'
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    // Not fatal — the holder string is for operator legibility only.
  }
  return `${hostname()}:${process.pid}:${head}`
}

/** Build a fresh `run_id` — legible (`purpose` + timestamp) plus a random suffix for uniqueness. */
function buildRunId(purpose: Smi5879Purpose): string {
  return `smi5879-${purpose}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
}

/** Handle returned by {@link startCensusHeartbeat}. */
export interface CensusHeartbeat {
  /** Stop the timer and suppress any in-flight tick's fatal-abort/error logging. */
  stop(): void
}

/**
 * Start the claim's independent heartbeat (design doc 8.3.5.2.5): calls
 * `heartbeat(runId, token)` on a fixed interval. A `null` return means the
 * claim was stolen or the run was abandoned — design doc 8.3.5.2.5 states
 * this is "fatal and immediate: the runner stops fetching, stops writing
 * checkpoints... and exits non-zero. It must not attempt to re-claim" — so
 * `onFatal` fires and the timer stops itself; the caller must not re-claim.
 *
 * SMI-5879 retro finding (sibling-implementation audit, 2026-08-08): this
 * runner previously called `smi5879_heartbeat` on a bare `setInterval` and
 * only ever caught a THROWN error — it never read the call's own return
 * value, so a stolen claim (which `smi5879_heartbeat` signals by returning
 * SQL NULL, not by throwing — see
 * `smi5879-census.claim-gc.test.ts`'s "heartbeat returns NULL for a
 * stolen/mismatched token" case, which asserts the DB function's half of
 * this contract) went completely undetected: this tool would keep
 * populating/resolving branches/sealing under a claim it no longer actually
 * held. Extracted as its own exported, unit-testable function — mirroring
 * `lock-heartbeat.ts`'s `startLockHeartbeat` (SMI-5311), which exists for
 * the identical "auto-execing main() on import" testability reason — so the
 * fatal-abort path can be exercised with a fake `heartbeat` function and
 * fake timers instead of a live Postgres claim-theft race. A thrown/rejected
 * `heartbeat` call is left non-fatal (log + retry next tick): unlike item
 * 3's multi-day unattended `smi5879-simulate-full.ts` run, this tool's
 * lifecycle is short and typically operator-observed directly.
 */
export function startCensusHeartbeat(
  heartbeat: (runId: string, token: string) => Promise<string | null>,
  runId: string,
  token: string,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  onFatal: (message: string) => void = (message) => {
    console.error(`[smi5879-census] FATAL: ${message} Exiting without re-claiming.`)
    process.exit(1)
  }
): CensusHeartbeat {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void heartbeat(runId, token)
      .then((result) => {
        // A late callback after stop() must not fire — the run is done.
        if (stopped) return
        if (result === null) {
          stopped = true
          clearInterval(timer)
          onFatal(
            `heartbeat lost for run_id=${runId} — claim was stolen or the run was abandoned ` +
              '(design doc 8.3.5.2.5).'
          )
        }
      })
      .catch((err) => {
        if (!stopped) {
          console.error(`[smi5879-census] heartbeat failed: ${(err as Error).message}`)
        }
      })
  }, intervalMs)
  // Don't keep the event loop alive on the heartbeat alone (in-flight I/O still
  // pins it). Node's setInterval handle has unref; guard for non-Node timers.
  timer.unref?.()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** Population load — design doc 8.3.5.2.3's exact SQL shape, one `REPEATABLE READ` transaction. */
async function populate(conn: PgConnParams, runId: string): Promise<void> {
  await runPsql(
    conn,
    `BEGIN ISOLATION LEVEL REPEATABLE READ;
     SELECT run_id FROM smi5879_run WHERE run_id = :'run_id' AND status = 'open' FOR UPDATE;
     INSERT INTO smi5879_snapshot_pre (
       run_id, id, security_score, quarantined, quarantine_reason,
       last_scanned_at, indexed_at, last_seen_at, content_hash,
       updated_at, row_xmin, repo_url, skill_path, author, name, security_findings,
       snapshot_taken_at
     )
     SELECT
       :'run_id', s.id, s.security_score, s.quarantined, s.quarantine_reason,
       s.last_scanned_at, s.indexed_at, s.last_seen_at, s.content_hash,
       s.updated_at, s.xmin::text, s.repo_url, s.skill_path, s.author, s.name,
       s.security_findings, now()
     FROM skills s;
     COMMIT;`,
    { run_id: runId }
  )
}

/** Seal — design doc 8.3.5.2.4's exact SQL shape: count + digest + status flip in one transaction. */
async function seal(conn: PgConnParams, runId: string): Promise<void> {
  await runPsql(
    conn,
    `BEGIN;
     SELECT run_id FROM smi5879_run WHERE run_id = :'run_id' AND status = 'open' FOR UPDATE;
     UPDATE smi5879_run r
        SET status             = 'sealed',
            snapshot_sealed_at = now(),
            row_count          = c.n,
            population_digest  = smi5879_population_digest(:'run_id'),
            branch_digest      = smi5879_branch_digest(:'run_id')
       FROM (SELECT count(*) AS n FROM smi5879_snapshot_pre WHERE run_id = :'run_id') c
      WHERE r.run_id = :'run_id'
        AND r.status = 'open';
     COMMIT;`,
    { run_id: runId }
  )
}

async function readCohortCounts(conn: PgConnParams, runId: string): Promise<CohortCounts> {
  const rows = await queryRows(
    conn,
    `SELECT cohort, count(*) FROM v_smi5879_census_cohort WHERE run_id = :'run_id' GROUP BY cohort`,
    { run_id: runId }
  )
  const counts: CohortCounts = { C1: 0, C2: 0, C3: 0, C4: 0, E: 0 }
  for (const [cohort, n] of rows) {
    if (cohort in counts) counts[cohort as keyof CohortCounts] = Number(n)
  }
  return counts
}

async function readRunSummary(
  conn: PgConnParams,
  runId: string
): Promise<{
  status: string
  rowCount: number
  populationDigest: string | null
  branchDigest: string | null
}> {
  const rows = await queryRows(
    conn,
    `SELECT status, row_count, population_digest, branch_digest FROM smi5879_run WHERE run_id = :'run_id'`,
    { run_id: runId }
  )
  if (rows.length === 0) throw new Error(`SMI-5879: no smi5879_run row found for run_id=${runId}`)
  const [status, rowCount, populationDigest, branchDigest] = rows[0]
  return {
    status,
    rowCount: Number(nullable(rowCount) ?? '0'),
    populationDigest: nullable(populationDigest),
    branchDigest: nullable(branchDigest),
  }
}

/**
 * Run the full generation lifecycle (create -> claim -> populate -> resolve
 * branches -> seal -> release) and return the assembled census report. Exported
 * for the test suite; `main()` below is the CLI entrypoint that calls this and
 * decides the process exit code.
 */
export async function runCensus(conn: PgConnParams, args: CliArgs): Promise<Smi5879CensusReport> {
  const runId = buildRunId(args.purpose)
  const token = randomUUID()
  const holder = buildHolder()

  await runPsql(
    conn,
    `INSERT INTO smi5879_run (run_id, purpose, ruleset_epoch) VALUES (:'run_id', :'purpose', :'ruleset_epoch');`,
    { run_id: runId, purpose: args.purpose, ruleset_epoch: args.rulesetEpoch }
  )

  const claimed = await queryRows(
    conn,
    `SELECT run_id, runner_token FROM smi5879_claim_run(:'run_id', :'token', :'holder');`,
    { run_id: runId, token, holder }
  )
  if (claimed.length === 0) {
    throw new Error(
      `SMI-5879: claim of freshly-created generation ${runId} was refused — unexpected.`
    )
  }

  const heartbeat = startCensusHeartbeat(
    (rid, tok) =>
      queryScalar(conn, `SELECT smi5879_heartbeat(:'run_id', :'token');`, {
        run_id: rid,
        token: tok,
      }),
    runId,
    token
  )

  let branchSummary: BranchResolutionSummary | null = null
  try {
    await populate(conn, runId)

    const isFetchingGeneration = args.purpose !== 'window'
    if (isFetchingGeneration) {
      // SMI-6015: a callback, not a frozen headers object — buildGitHubHeaders()
      // is invoked fresh on every retry attempt inside resolveOne, not once for
      // the whole (potentially multi-hour) pass. getInstallationToken() caches
      // and only re-mints near expiry, so this costs ~nil when still fresh.
      const getHeaders = () => buildGitHubHeaders('skillsmith-smi5879-census/1.0')
      const telemetry = newRateLimitTelemetry()
      branchSummary = await resolveDefaultBranches(conn, runId, getHeaders, telemetry)

      // Item 6: bounded re-resolution sweep over any still-transient rows,
      // BEFORE seal (the guard permits UPDATE while status='open'). Reduces
      // how often the I-6 gate immediately below actually fires.
      const sweep = await sweepTransientRepos(conn, runId, getHeaders, telemetry)
      if (sweep) {
        const dbCounts = await queryBranchResolutionCounts(conn, runId)
        branchSummary = {
          ...branchSummary,
          resolved: dbCounts.resolved,
          not_found: dbCounts.not_found,
          transient: dbCounts.transient,
          reresolution_sweep: sweep,
        }
      }

      // SMI-6015 (GPT-5.6-Sol review, 2026-08-14): I-6 MUST gate seal(), not
      // just be reported alongside I-1..I-5 afterward — `runInvariantChecks`
      // below runs post-seal for the REPORT, but a generation is immutable
      // once sealed (smi5879_snapshot_guard), so checking I-6 only after
      // seal() would let a still-bad generation get sealed and reported as
      // "sealed" (implying success) even though its own invariant report
      // says otherwise. Throwing here (same as a 401/circuit-breaker abort)
      // skips seal() entirely and leaves the generation status='open' —
      // diagnosable, never falsely "sealed".
      const i6 = await checkI6BranchResolutionQuality(conn, runId)
      if (!i6.passed) {
        throw new Error(`SMI-5879: refusing to seal — I-6 (${i6.name}) failed: ${i6.detail}`)
      }
    }

    await seal(conn, runId)
  } finally {
    heartbeat.stop()
    await runPsql(conn, `SELECT smi5879_release_run(:'run_id', :'token');`, {
      run_id: runId,
      token,
    }).catch((err) => {
      console.error(`[smi5879-census] release failed (non-fatal): ${(err as Error).message}`)
    })
  }

  const isFetchingGeneration = args.purpose !== 'window'
  const invariants = await runInvariantChecks(conn, runId, isFetchingGeneration)
  const runSummary = await readRunSummary(conn, runId)
  const cohorts = await readCohortCounts(conn, runId)

  const report: Smi5879CensusReport = {
    run_id: runId,
    purpose: args.purpose,
    ruleset_epoch: args.rulesetEpoch,
    status: runSummary.status as Smi5879CensusReport['status'],
    row_count: runSummary.rowCount,
    population_digest: runSummary.populationDigest,
    branch_digest: runSummary.branchDigest,
    cohorts,
    excluded_cohort_e_count: cohorts.E,
    ruleset_epoch_provenance: RULESET_EPOCH_PROVENANCE,
    invariants,
    branch_resolution: branchSummary,
    generated_at: new Date().toISOString(),
  }
  return report
}

function printSummary(report: Smi5879CensusReport): void {
  const failedInvariants = report.invariants.filter((i) => !i.passed)
  console.log(
    `\n── Census Summary (${report.run_id}) ──\n` +
      `  purpose:            ${report.purpose}\n` +
      `  ruleset_epoch:       ${report.ruleset_epoch}\n` +
      `  status:              ${report.status}\n` +
      `  row_count:           ${report.row_count}\n` +
      `  population_digest:   ${report.population_digest}\n` +
      `  branch_digest:       ${report.branch_digest}\n` +
      `  C1 (must enumerate): ${report.cohorts.C1}\n` +
      `  C2 (unscored):       ${report.cohorts.C2}\n` +
      `  C3 (stale-scored):   ${report.cohorts.C3}\n` +
      `  C4 (quarantined):    ${report.cohorts.C4}\n` +
      `  E  (excluded):       ${report.cohorts.E}\n` +
      (report.branch_resolution
        ? `  branch resolution:   ${report.branch_resolution.resolved} resolved, ` +
          `${report.branch_resolution.not_found} not-found, ${report.branch_resolution.transient} transient, ` +
          `${report.branch_resolution.unparseable} unparseable-repo_url (of ${report.branch_resolution.distinct_repos} distinct repos)\n` +
          (report.branch_resolution.reresolution_sweep
            ? `  re-resolution sweep: ${report.branch_resolution.reresolution_sweep.passes_run} pass(es) over ` +
              `${report.branch_resolution.reresolution_sweep.repos_reattempted} repo(s), ` +
              `${report.branch_resolution.reresolution_sweep.remaining_transient} still transient` +
              `${report.branch_resolution.reresolution_sweep.wall_clock_stopped ? ' (wall-clock-capped)' : ''}\n`
            : '')
        : '') +
      `  invariants:          ${report.invariants.filter((i) => i.passed).length}/${report.invariants.length} passed\n`
  )
  for (const inv of report.invariants) {
    console.log(`  [${inv.passed ? 'PASS' : 'FAIL'}] ${inv.id} ${inv.name} — ${inv.detail}`)
  }
  if (failedInvariants.length > 0) {
    console.error(
      `\nFAILED CLOSED: ${failedInvariants.length} invariant(s) violated: ${failedInvariants.map((i) => i.id).join(', ')}\n`
    )
  }
}

async function dryRun(args: CliArgs): Promise<void> {
  console.log(
    `[DRY-RUN] purpose=${args.purpose} ruleset-epoch=${args.rulesetEpoch} report-path=${args.reportPath}`
  )
  const conn = poolerSessionConnParams()
  await runPsql(conn, 'SELECT 1;')
  console.log('[DRY-RUN] DB connectivity OK (session pooler).')
  if (args.purpose !== 'window') {
    const headers = await buildGitHubHeaders('skillsmith-smi5879-census/1.0')
    console.log(
      `[DRY-RUN] GitHub auth headers built (Authorization present: ${'Authorization' in headers}).`
    )
  }
  console.log(
    '[DRY-RUN] No generation created, claimed, or populated. Re-run with --apply to perform writes.'
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.apply) {
    await dryRun(args)
    return
  }
  const conn = poolerSessionConnParams()
  const report = await runCensus(conn, args)
  writeFileSync(args.reportPath, JSON.stringify(report, null, 2))
  printSummary(report)
  console.log(`Report written to ${args.reportPath}`)
  if (report.invariants.some((i) => !i.passed)) {
    process.exitCode = 1
  }
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
