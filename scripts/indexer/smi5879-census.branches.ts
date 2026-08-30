/**
 * default_branch resolution pass for smi5879-census.ts (design doc 8.3.5.2.2)
 * @module scripts/indexer/smi5879-census.branches
 *
 * `skills` carries no `branch`/`default_branch` column, so every existing
 * consumer falls back to `parsed.ref ?? 'main'` — silently 404ing every sibling
 * fetch on a repo whose default branch is not `main`, which reads as a
 * confirmed-clean bundle. This module resolves the default branch once per
 * distinct `(owner, repo)` in the generation's population, via
 * `GET /repos/{owner}/{repo}`, and records the outcome — including failures —
 * into `smi5879_repo_branch`.
 *
 * Runs ONLY for a `rehearsal`/`decision` generation. A `window` generation
 * performs no GitHub I/O at all (8.3.5.2.2) — its `smi5879_repo_branch` stays
 * empty and its `branch_digest` is the empty-population digest, which is
 * correct rather than a gap.
 *
 * SMI-6015: the per-repo resolution mechanics (frozen-header fix, 401-fatal,
 * rate-limit split), the bounded-concurrency worker pool, batched writes, the
 * circuit breaker, and progress logging all moved to the sibling
 * `smi5879-census.branches.helpers.ts` (CLAUDE.md's <500-line-per-file
 * budget) — that module's own header has the full incident summary. This
 * file keeps the top-level orchestration: build the distinct-repo set, run
 * the pool, run the bounded item-6 re-resolution sweep before seal, and
 * report the final DB-authoritative counts.
 *
 * JUDGMENT CALL (flagged per task instructions): the design doc's
 * `smi5879_repo_branch.resolution` vocabulary includes `'unparseable' => repo_url
 * did not yield an (owner, repo) at all`, but `owner`/`repo` are NOT NULL primary-key
 * columns on that table — there is no key to insert an 'unparseable' row under
 * when derivation genuinely fails. This module therefore never emits an
 * 'unparseable' row: a `repo_url` that {@link parseSkillMdUrl} cannot derive an
 * `(owner, repo)` from is excluded from the "distinct repos to resolve" set
 * entirely (it is a row-level unfetchable condition per 8.5 G-1's own
 * independent listing of that case, not a `smi5879_repo_branch` row), and its
 * count is tracked separately in {@link BranchResolutionSummary.unparseable} for
 * report visibility. The `unparseable` CHECK value stays in the migration for
 * forward compatibility even though this implementation never writes it.
 */

import type { RateLimitTelemetry } from './_shared/rate-limit.ts'
import { parseSkillMdUrl } from './_shared/skill-md-fetch.ts'
import { queryRows, nullable, type PgConnParams } from './smi5879-census.pg.ts'
import {
  RESOLUTION_CONCURRENCY,
  WRITE_BATCH_SIZE,
  PROGRESS_LOG_INTERVAL,
  REEXOLUTION_SWEEP_MAX_PASSES,
  REEXOLUTION_SWEEP_WALL_CLOCK_BUDGET_MS,
  runResolutionPool,
  logResolutionProgress,
  checkCircuitBreaker,
  emptyResolutionCounts,
  BranchResolutionAuthError,
  BranchResolutionCircuitBreakerError,
} from './smi5879-census.branches.helpers.ts'
import { writeOutcomesBatch, updateOutcomesBatch } from './smi5879-census.branches.writes.ts'
import type {
  BranchResolutionSummary,
  DistinctRepo,
  ResolutionOutcome,
  ReresolutionSweepSummary,
} from './smi5879-census.types.ts'

export { BranchResolutionAuthError, BranchResolutionCircuitBreakerError }

/**
 * Query the just-loaded population's distinct repo_urls, derive `(owner, repo)`
 * pairs, and exclude any pair that already has a `smi5879_repo_branch` row for
 * this `run_id` (SMI-5879 checkpoint/resume follow-up).
 *
 * The exclusion is what makes {@link resolveDefaultBranches} safe to call
 * twice for the SAME generation — on a fresh run `smi5879_repo_branch` has
 * zero rows for a brand-new `run_id`, so the exclusion is a no-op; on a
 * resumed run (a prior invocation died mid-pass after writing SOME batches)
 * it naturally yields exactly the still-unresolved remainder, so the main
 * pass's plain `INSERT` (`buildBatchInsertSql`) never re-attempts a repo it
 * already has a row for and never hits a duplicate-key error on `(run_id,
 * owner, repo)`. A row is excluded regardless of its `resolution` value
 * (including `'transient'`) — a transient repo already has a row, so
 * re-attempting it here would still violate the PK; its re-attempt is
 * {@link sweepTransientRepos}'s job (an `UPDATE`, not an `INSERT`), which
 * queries `smi5879_repo_branch` directly and is unaffected by this function.
 *
 * Both queries are read-only and rely on the SAME single-active-claim-holder
 * convention every other write path in this module already assumes (no lock
 * taken here) — see this module's own header for the pre-existing trust
 * model this does not change.
 */
export async function distinctRepos(
  conn: PgConnParams,
  runId: string
): Promise<{ repos: DistinctRepo[]; unparseableCount: number }> {
  const rows = await queryRows(
    conn,
    `SELECT DISTINCT repo_url FROM smi5879_snapshot_pre WHERE run_id = :'run_id' AND repo_url IS NOT NULL`,
    { run_id: runId }
  )
  const seen = new Map<string, DistinctRepo>()
  let unparseableCount = 0
  for (const [rawUrl] of rows) {
    // SMI-5879 coordinator review (2026-08-30): under noUncheckedIndexedAccess,
    // destructuring a row of unknown static length types `rawUrl` as
    // `string | undefined`, even though this query always selects exactly one
    // column. Guard rather than assert, matching this module's existing
    // defensive style — an actually-missing first column is treated the same
    // as any other skip-worthy row, not a crash.
    if (rawUrl === undefined) continue
    const url = nullable(rawUrl)
    if (url === null) continue
    const parsed = parseSkillMdUrl(url, null)
    if (!parsed) {
      unparseableCount++
      continue
    }
    seen.set(`${parsed.owner}/${parsed.repo}`, { owner: parsed.owner, repo: parsed.repo })
  }

  const alreadyResolved = await queryRows(
    conn,
    `SELECT owner, repo FROM smi5879_repo_branch WHERE run_id = :'run_id'`,
    { run_id: runId }
  )
  for (const [owner, repo] of alreadyResolved) {
    // owner/repo are NOT NULL columns (this exclusion IS the entire "safe to
    // call resolveDefaultBranches twice" mechanism, SMI-5879 round-2 review
    // finding) — a missing cell here means queryRows's own field-count
    // parsing itself is broken, not a data condition. Fail loudly rather
    // than silently no-op `seen.delete("undefined/undefined")`, which would
    // leave an already-resolved repo un-excluded and only surface later as a
    // confusing duplicate-key abort at the end of an expensive pass. Mirrors
    // queryTransientRepos's identical guard in smi5879-census.branches.helpers.ts.
    if (owner === undefined || repo === undefined) {
      throw new Error(
        `SMI-6015/SMI-5879: malformed smi5879_repo_branch row for run_id=${runId} — expected ` +
          `(owner, repo), got ${JSON.stringify([owner, repo])}`
      )
    }
    seen.delete(`${owner}/${repo}`)
  }

  return { repos: [...seen.values()], unparseableCount }
}

/**
 * Run the full default_branch resolution pass for `runId`'s just-loaded
 * population and write every outcome to `smi5879_repo_branch`. `getHeaders`
 * is a callback (SMI-6015), not a frozen headers object — `resolveOne`
 * invokes it fresh on every retry attempt so a token that expires mid-pass
 * is transparently refreshed. Writes are batched and flushed incrementally
 * as outcomes arrive (real progress visible in the table during the pass,
 * not just after it finishes), and a circuit breaker aborts a doomed pass
 * once the transient rate exceeds threshold past warm-up.
 *
 * Throws `BranchResolutionAuthError` (401) or `BranchResolutionCircuitBreakerError`
 * on an aborted pass — deliberately uncaught here. The caller
 * (`smi5879-census.ts`'s `runCensus()`) already wraps this call in a `try`
 * whose `finally` stops the heartbeat and releases the claim but does NOT
 * call `seal()` on the exception path, so an abort leaves the generation
 * `status='open'` — diagnosable (a human or a retry can inspect exactly how
 * far `smi5879_repo_branch` got) rather than silently sealed with a report
 * that already claims success. This reuses the SAME fatal-abort shape
 * `startCensusHeartbeat`'s own doc comment establishes for a lost claim:
 * "exits non-zero... must not attempt to re-claim."
 *
 * SMI-5879 checkpoint/resume follow-up: this IS now safe to call more than
 * once for the same generation — {@link distinctRepos} excludes any repo
 * that already has a `smi5879_repo_branch` row, so a resumed invocation's
 * main-pass `INSERT` (`buildBatchInsertSql`) never re-attempts an
 * already-recorded `(run_id, owner, repo)` and never hits its PK's
 * duplicate-key error. The normal call shape is still exactly once per
 * generation, immediately after the population load — a resume just means a
 * SECOND process happens to make that same call against a `run_id` a PRIOR
 * process already made partial progress on.
 */
export async function resolveDefaultBranches(
  conn: PgConnParams,
  runId: string,
  token: string,
  getHeaders: () => Promise<Record<string, string>>,
  telemetry: RateLimitTelemetry
): Promise<BranchResolutionSummary> {
  const { repos, unparseableCount } = await distinctRepos(conn, runId)

  let buffer: ResolutionOutcome[] = []
  const pendingFlushes: Promise<void>[] = []
  const counts = emptyResolutionCounts()

  // SMI-5879 cross-model review round-4 finding (Medium): a rejected
  // `writeOutcomesBatch` promise here was previously left UNHANDLED —
  // `pendingFlushes.push(writeOutcomesBatch(...))` with no `.catch()`,
  // called from inside a SYNCHRONOUS `onOutcome` callback the pool has no
  // visibility into. `runCancellablePool` only aborts on a THROWN
  // `processItem`/a `PoolAbortSignal` return from `onOutcome` — a rejected
  // entry in `pendingFlushes` was invisible to it and sat unhandled until
  // `Promise.all(pendingFlushes)` below, reached only after the ENTIRE pool
  // finishes (hours, at this pass's conservative rate). Verified live: an
  // unhandled rejection there kills the process via Node's default
  // `--unhandled-rejections=throw` before `runCensus()`'s `finally` can run
  // `heartbeat.stop()`/`smi5879_release_run()` — a claim-loss abort would
  // then leave `runner_token` held for the full 30-minute takeover window
  // instead of releasing immediately, directly regressing `--resume`'s own
  // recovery time. Captured here and surfaced through `onOutcome`'s
  // PoolAbortSignal return on the VERY NEXT completion, so the pool stops
  // cooperatively through its own (already-reviewed) abort machinery.
  //
  // Named `writeError`, not `fencedOutError` (round-5 confirmation review,
  // Low): this `.catch()` captures WHATEVER `writeOutcomesBatch` rejects
  // with — a `ClaimFencedWriteError` on a lost claim, but ALSO a genuine
  // `PsqlExitError` from an unrelated SQL failure after its own retries are
  // exhausted. Either way this pass must stop, so the STOP behavior below
  // is correct regardless of cause — but the variable name (and the
  // `if (writeError) throw writeError` priority over `abortedBy` below)
  // must not itself assert a specific cause the value can't guarantee.
  let writeError: Error | undefined

  const flush = (): void => {
    if (buffer.length === 0) return
    const toWrite = buffer
    buffer = []
    pendingFlushes.push(
      writeOutcomesBatch(conn, runId, token, toWrite).catch((err) => {
        writeError = err as Error
      })
    )
  }

  const { abortedBy } = await runResolutionPool(
    repos,
    getHeaders,
    telemetry,
    RESOLUTION_CONCURRENCY,
    (outcome, completedCount) => {
      buffer.push(outcome)
      counts[outcome.resolution]++
      if (buffer.length >= WRITE_BATCH_SIZE) flush()
      if (completedCount % PROGRESS_LOG_INTERVAL === 0) {
        logResolutionProgress(runId, completedCount, repos.length, counts, telemetry)
      }
      if (writeError) return { reason: writeError }
      return checkCircuitBreaker(completedCount, counts.transient)
    }
  )

  flush()
  await Promise.all(pendingFlushes)
  logResolutionProgress(
    runId,
    counts.resolved + counts['not-found'] + counts.transient,
    repos.length,
    counts,
    telemetry
  )

  // The FINAL flush() above (the sub-WRITE_BATCH_SIZE remainder) runs AFTER
  // the pool has already returned, so a rejection on THAT specific flush was
  // never visible to any onOutcome tick — check it explicitly rather than
  // let it disappear as a captured-but-unthrown value.
  //
  // SMI-5879 cross-model review round-5 finding (Low): `writeError` is
  // checked FIRST, ahead of `abortedBy` — if the circuit breaker trips or a
  // 401 lands in the exact same window a flush is separately rejected, the
  // operator needs "your claim was stolen" (the more actionable, instance-
  // specific diagnosis), not "52% transient"/"credential failure" (a
  // diagnosis about the PASS, not this run's claim). Both orderings fail
  // safe either way (a re-run is refused by the claim CAS regardless), this
  // is purely about which message the operator sees first.
  if (writeError) throw writeError
  if (abortedBy) throw abortedBy

  return {
    distinct_repos: repos.length,
    resolved: counts.resolved,
    not_found: counts['not-found'],
    transient: counts.transient,
    unparseable: unparseableCount,
    reresolution_sweep: null,
  }
}

async function queryTransientRepos(conn: PgConnParams, runId: string): Promise<DistinctRepo[]> {
  const rows = await queryRows(
    conn,
    `SELECT owner, repo FROM smi5879_repo_branch WHERE run_id = :'run_id' AND resolution = 'transient'`,
    { run_id: runId }
  )
  return rows.map(([owner, repo]) => {
    // owner/repo are NOT NULL columns — a missing cell here means queryRows's
    // field-count parsing itself is broken, not a data condition. Fail loudly
    // rather than silently constructing a garbage DistinctRepo.
    if (owner === undefined || repo === undefined) {
      throw new Error(
        `SMI-6015: malformed smi5879_repo_branch row for run_id=${runId} — expected (owner, repo), got ${JSON.stringify([owner, repo])}`
      )
    }
    return { owner, repo }
  })
}

/**
 * Item 6 (SMI-6015): bounded re-resolution sweep over ONLY the rows the main
 * pass recorded `transient`, run BEFORE seal — the immutability guard
 * (`smi5879_snapshot_guard()`) permits UPDATE while `status='open'` (the
 * "operator repair" allowance the migration documents for the population
 * load, reused here for an automated repair of `smi5879_repo_branch`).
 *
 * Bounded two independent ways so one genuinely flaky repo (or a pass that
 * regresses without ever tripping the 50% circuit breaker) cannot force an
 * unbounded retry loop: a fixed pass cap ({@link REEXOLUTION_SWEEP_MAX_PASSES})
 * AND a wall-clock cap ({@link REEXOLUTION_SWEEP_WALL_CLOCK_BUDGET_MS}) —
 * either stops the sweep. A pass that makes no forward progress (the
 * residual count did not shrink) also stops early rather than spending
 * remaining budget on passes that cannot help.
 *
 * A 401 mid-sweep is exactly as fatal as one mid-pass — propagates
 * uncaught, same as `resolveDefaultBranches`.
 *
 * Returns `null` when there is nothing to sweep (the expected common case —
 * this only exists to shrink a NONZERO transient count towards zero before
 * I-6 checks it at seal time).
 */
export async function sweepTransientRepos(
  conn: PgConnParams,
  runId: string,
  token: string,
  getHeaders: () => Promise<Record<string, string>>,
  telemetry: RateLimitTelemetry
): Promise<ReresolutionSweepSummary | null> {
  let remaining = await queryTransientRepos(conn, runId)
  if (remaining.length === 0) return null

  const initialCount = remaining.length
  const startedAt = Date.now()
  let passesRun = 0
  let wallClockStopped = false

  for (let pass = 1; pass <= REEXOLUTION_SWEEP_MAX_PASSES; pass++) {
    if (remaining.length === 0) break
    if (Date.now() - startedAt > REEXOLUTION_SWEEP_WALL_CLOCK_BUDGET_MS) {
      wallClockStopped = true
      break
    }
    passesRun = pass
    const prevRemaining = remaining.length

    // SMI-6015 (GPT-5.6-Sol review, 2026-08-14): the between-passes check
    // above cannot interrupt a single pass already in flight at the
    // conservative 1 req/sec pace — a large `remaining` set could run for
    // hours before this loop ever got back here. Passing the SAME absolute
    // deadline into the pool itself makes it enforceable mid-pass, not just
    // between passes.
    const deadlineAtMs = startedAt + REEXOLUTION_SWEEP_WALL_CLOCK_BUDGET_MS
    const outcomes: ResolutionOutcome[] = []
    const { abortedBy, deadlineExceeded } = await runResolutionPool(
      remaining,
      getHeaders,
      telemetry,
      RESOLUTION_CONCURRENCY,
      (outcome) => {
        outcomes.push(outcome)
      },
      deadlineAtMs
    )

    for (let i = 0; i < outcomes.length; i += WRITE_BATCH_SIZE) {
      await updateOutcomesBatch(conn, runId, token, outcomes.slice(i, i + WRITE_BATCH_SIZE))
    }

    // A fatal auth error aborts the whole census the same way a mid-main-pass
    // 401 does — thrown AFTER this pass's own partial progress is durably
    // written above, never before (no data loss on abort). A deadline is NOT
    // fatal — unlike abortedBy, it's an expected way for a pass to stop, so
    // it falls through to the same "compute remaining, log, continue-or-break"
    // path as a normally-completed pass, not a throw.
    if (abortedBy) throw abortedBy

    // A deadline-exceeded pass only processed a PREFIX of `remaining` (the
    // pool stops pulling new work, but doesn't retroactively un-process what
    // it already started) — repos never attempted this pass are still
    // transient, not just the ones that came back transient in `outcomes`.
    const attempted = new Set(outcomes.map((o) => `${o.repo.owner}/${o.repo.repo}`))
    const neverAttempted = remaining.filter((r) => !attempted.has(`${r.owner}/${r.repo}`))
    remaining = [
      ...outcomes.filter((o) => o.resolution === 'transient').map((o) => o.repo),
      ...neverAttempted,
    ]
    console.log(
      `[smi5879-census.branches] run_id=${runId} re-resolution sweep pass ${pass}: ` +
        `${prevRemaining} -> ${remaining.length} transient` +
        (deadlineExceeded ? ' (deadline exceeded mid-pass)' : '')
    )
    if (deadlineExceeded) {
      wallClockStopped = true
      break
    }
    if (remaining.length >= prevRemaining) break // no forward progress — stop early, don't burn remaining passes
  }

  return {
    passes_run: passesRun,
    repos_reattempted: initialCount,
    remaining_transient: remaining.length,
    wall_clock_stopped: wallClockStopped,
  }
}

/** DB-authoritative resolution counts for `runId`, queried directly (single source of truth post-sweep). */
export async function queryBranchResolutionCounts(
  conn: PgConnParams,
  runId: string
): Promise<{ resolved: number; not_found: number; transient: number }> {
  const rows = await queryRows(
    conn,
    `SELECT resolution, count(*) FROM smi5879_repo_branch WHERE run_id = :'run_id' GROUP BY resolution`,
    { run_id: runId }
  )
  const counts = { resolved: 0, not_found: 0, transient: 0 }
  for (const [resolution, n] of rows) {
    if (resolution === 'resolved') counts.resolved = Number(n)
    else if (resolution === 'not-found') counts.not_found = Number(n)
    else if (resolution === 'transient') counts.transient = Number(n)
  }
  return counts
}
