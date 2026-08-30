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
 * `--resume` (SMI-5879 checkpoint/resume follow-up, added after this tool died
 * 3x in 24h in production to a host container bounce silently killing its
 * `docker exec -d` background process): re-attaches to the SAME still-`open`
 * generation instead of creating a new one, via the EXISTING `smi5879_claim_run`
 * takeover CAS — no new SQL, no new migration. Requires `--apply`. Full design
 * rationale, identity-check contract, and why an `abandoned` generation is
 * deliberately NOT resumable: `smi5879-census.resume.ts`'s module header.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/indexer/smi5879-census.ts \
 *     --purpose=rehearsal --ruleset-epoch=2026-07-29T23:41:09Z [--apply] [--report-path=<path>]
 *   varlock run -- npx tsx scripts/indexer/smi5879-census.ts \
 *     --purpose=decision --ruleset-epoch=2026-07-29T23:41:09Z --apply --resume
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
import { isPopulated, obtainClaimedRun } from './smi5879-census.resume.ts'
import { populate, seal } from './smi5879-census.lifecycle.ts'
import { startCensusHeartbeat } from './smi5879-census.heartbeat.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { newRateLimitTelemetry } from './_shared/rate-limit.ts'
import type {
  BranchResolutionSummary,
  CohortCounts,
  Smi5879CensusReport,
  Smi5879Purpose,
} from './smi5879-census.types.ts'

const VALID_PURPOSES: readonly Smi5879Purpose[] = ['rehearsal', 'decision', 'window']
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
  /** SMI-5879 checkpoint/resume follow-up — see this file's header for the full contract. */
  resume: boolean
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
  const resume = argv.includes('--resume')
  if (resume && !apply) {
    throw new Error(
      'SMI-5879: --resume requires --apply — a dry-run resume does nothing useful and is refused ' +
        'here rather than silently behaving like a plain --dry-run. Pass --apply --resume together.'
    )
  }
  const reportPath = find('report-path') ?? `smi5879-census-report-${Date.now()}.json`

  return { purpose: purpose as Smi5879Purpose, rulesetEpoch, apply, reportPath, resume }
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
  const token = randomUUID()
  const holder = buildHolder()

  // SMI-5879 checkpoint/resume follow-up: obtains + claims either a fresh
  // run_id (default) or the existing open one (--resume) — see
  // smi5879-census.resume.ts for the full identity-check/claim contract.
  const runId = await obtainClaimedRun(conn, args, token, holder)

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
    // SMI-5879 checkpoint/resume follow-up: population is all-or-nothing
    // (isPopulated's doc comment) — skip re-running it rather than hitting a
    // duplicate-key error on every row's (run_id, id) PK.
    if (await isPopulated(conn, runId)) {
      // SMI-5879 checkpoint/resume round-2 review finding: log the row count,
      // not just "already loaded" — makes a suspiciously-small (e.g.
      // hand-inserted) population visibly distinguishable from a genuine
      // multi-hundred-thousand-row prior load in the operator's terminal.
      const existingCount = await queryScalar(
        conn,
        `SELECT count(*) FROM smi5879_snapshot_pre WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      console.log(
        `[smi5879-census] run_id=${runId} population already loaded (${existingCount} rows) — ` +
          'skipping population load (resume).'
      )
    } else {
      await populate(conn, runId, token)
    }

    const isFetchingGeneration = args.purpose !== 'window'
    if (isFetchingGeneration) {
      // SMI-6015: a callback, not a frozen headers object — buildGitHubHeaders()
      // is invoked fresh on every retry attempt inside resolveOne, not once for
      // the whole (potentially multi-hour) pass. getInstallationToken() caches
      // and only re-mints near expiry, so this costs ~nil when still fresh.
      const getHeaders = () => buildGitHubHeaders('skillsmith-smi5879-census/1.0')
      const telemetry = newRateLimitTelemetry()
      // SMI-5879 checkpoint/resume follow-up: safe to call even when a prior
      // (crashed) invocation already wrote SOME smi5879_repo_branch rows —
      // distinctRepos() (smi5879-census.branches.ts) excludes anything
      // already recorded, so this only resolves the unresolved remainder (a
      // no-op exclusion on a fresh run, whose branch table starts empty).
      branchSummary = await resolveDefaultBranches(conn, runId, token, getHeaders, telemetry)

      // Item 6: bounded re-resolution sweep over any still-transient rows,
      // BEFORE seal (the guard permits UPDATE while status='open'). Reduces
      // how often the I-6 gate immediately below actually fires.
      const sweep = await sweepTransientRepos(conn, runId, token, getHeaders, telemetry)
      // SMI-5879 checkpoint/resume follow-up: ALWAYS re-derive the final
      // counts (incl. distinct_repos) from smi5879_repo_branch directly —
      // previously only done inside `if (sweep)`, and distinct_repos was
      // never overwritten, trusting resolveDefaultBranches's own in-process
      // repos.length from the START of its call, which undercounts under
      // resume (only the remainder THIS invocation processed). A report-
      // accuracy fix that applies unconditionally, not just under resume.
      const dbCounts = await queryBranchResolutionCounts(conn, runId)
      branchSummary = {
        ...branchSummary,
        distinct_repos: dbCounts.resolved + dbCounts.not_found + dbCounts.transient,
        resolved: dbCounts.resolved,
        not_found: dbCounts.not_found,
        transient: dbCounts.transient,
        reresolution_sweep: sweep,
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

    // SMI-5879 checkpoint/resume, cross-model review finding (High + Medium):
    // seal() is now token-fenced and self-verifying — see its own doc
    // comment. It throws directly on a fenced-out/already-sealed-elsewhere
    // seal, replacing the round-2 fix's separate assertGenerationSealed()
    // (a later status READ that could not distinguish "I sealed it" from
    // "I merely observed someone else's seal").
    await seal(conn, runId, token)
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
    resumed: args.resume,
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
    `\n── Census Summary (${report.run_id}${report.resumed ? ', resumed' : ''}) ──\n` +
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
