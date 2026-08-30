/**
 * Checkpoint/resume for smi5879-census.ts (SMI-5879 follow-up).
 * @module scripts/indexer/smi5879-census.resume
 *
 * PROBLEM: smi5879-census.ts has no checkpoint/resume. In production it died
 * 3x in ~24h because the host's `skillsmith-dev-1` Docker container got
 * restarted (confirmed via `docker inspect`'s `StartedAt` jumping forward
 * with `RestartCount:0` — a stop/start, not a crash-loop, plausibly routine
 * laptop sleep/wake), silently killing the `docker exec -d` background
 * process. Progress made (up to 74% of ~31,800 branch resolutions on one
 * attempt) was lost every time, forcing a cold restart via the sibling
 * `smi5879_gc_force_abandon` recovery function.
 *
 * DESIGN: DB-native resume, reusing the EXISTING, already-3x-adversarially-
 * reviewed claim CAS (`smi5879_claim_run`, `supabase/migrations/
 * 20260808000000_smi5879_snapshot_generations.sql` SECTION 7) — ZERO new
 * migration, ZERO new SQL function. Two alternatives were considered and
 * rejected:
 *
 * 1. A file-based checkpoint mirroring the sibling `smi5879-simulate-full.ts`
 *    + `smi5879-simulate-full.checkpoint.ts`'s JSON `row_results` checkpoint.
 *    Rejected: branch-resolution progress here is ALREADY durably persisted
 *    per-batch straight to Postgres (`smi5879_repo_branch`, via
 *    `writeOutcomesBatch`/`updateOutcomesBatch` — each batch is one plain
 *    `INSERT`/`UPDATE` statement, atomic per Postgres single-statement
 *    semantics, independently durable, confirmed before relying on this). A
 *    separate JSON checkpoint file would be redundant, could drift from DB
 *    truth, and the population-load step is one opaque `INSERT...SELECT` in
 *    a single transaction with no per-row granularity a JSON checkpoint
 *    could usefully track anyway (unlike `smi5879-simulate-full.ts`'s
 *    row-by-row fetch loop).
 * 2. A new SQL function to reopen an `abandoned` row back to `open`.
 *    Rejected: the actual failure mode (a container bounce killing a
 *    background process) leaves the row `status='open'` the whole time —
 *    nobody calls `smi5879_release_run` or `smi5879_gc_force_abandon` on a
 *    process that just vanishes. The EXISTING `smi5879_claim_run` takeover
 *    CAS (a stale heartbeat, or a NULL token from a clean release, makes a
 *    claim re-attachable) already handles re-attaching to that still-open
 *    row. Scoping resume to `status='open'` only avoids new schema/CAS
 *    surface and stays consistent with the migration's own stated
 *    philosophy ("a mismatch is never recoverable in-place — the correct
 *    action is a new generation, not a repair") for anything already
 *    abandoned — if an operator already force-abandoned a stuck generation
 *    (the pre-`--resume` recovery path), the correct next step is a FRESH
 *    generation, not resuming the abandoned one.
 *
 * MECHANISM (three read-only/reused-write touchpoints, all in TypeScript):
 *   1. {@link findResumableRun} — discovery. `smi5879_run_one_open`
 *      guarantees at most one `open` row database-wide, so discovery is
 *      unambiguous; `purpose`/`ruleset_epoch` (immutable columns, never
 *      UPDATEd anywhere in this codebase) must match this invocation's CLI
 *      args exactly, mirroring the sibling checkpoint tool's
 *      `assertCheckpointIdentity` contract — refuse loudly on any mismatch.
 *   2. {@link obtainClaimedRun} — converges the fresh and resume paths onto
 *      the SAME `smi5879_claim_run` call. This is the ONLY thing that
 *      actually decides whether a resume may proceed against a live vs.
 *      dead prior process; discovery above is advisory only.
 *   3. {@link isPopulated} — population is all-or-nothing (one
 *      `REPEATABLE READ` transaction in `smi5879-census.ts`'s `populate()`),
 *      so "any row present" unambiguously means "fully loaded" — no partial-
 *      population state is possible to misjudge.
 *
 * `distinctRepos()` (`smi5879-census.branches.ts`) carries the fourth piece —
 * excluding already-resolved `(owner, repo)` pairs so
 * `resolveDefaultBranches` is safe to call twice for the same generation —
 * kept in that file since it is that module's own state, not this one's.
 *
 * Every write this module triggers (the fresh-path `INSERT INTO smi5879_run`,
 * the claim itself) is UNCHANGED, pre-existing code, called through the exact
 * same guarded paths (`smi5879_snapshot_guard`, `smi5879_run_one_open`,
 * `smi5879_claim_run`'s CAS) a fresh run already went through. This module
 * adds read-only discovery/existence checks around those calls, never a new
 * way to mutate `smi5879_run`/`smi5879_snapshot_pre`/`smi5879_repo_branch`.
 *
 * ROUND-2 ADVERSARIAL REVIEW ADDITIONS (SMI-5879 checkpoint/resume follow-up):
 * a dedicated confirmation pass on this fix, per CLAUDE.md's "a fix for a
 * race condition needs its own confirmation review round" rule, found three
 * Medium-severity gaps this module (plus `smi5879-census.heartbeat.ts`)
 * closes: (a) {@link describeResumeClaimRefusal} distinguishes a genuinely
 * live claim from a generation that moved to `abandoned`/was sealed
 * elsewhere between discovery and claim — the two need OPPOSITE operator
 * advice (wait vs. never wait), and the original single fixed message always
 * said "wait"; (b) the claim call sets `lock_timeout` — unlike the fresh
 * path (always targeting a row THIS process just INSERTed), `--resume`
 * targets a PRE-EXISTING row a frozen (not killed) sibling process's own
 * `FOR UPDATE` could still be holding, which previously could hang the
 * claim indefinitely.
 *
 * ROUND-3 (CROSS-MODEL REVIEW) ADDITIONS — the round-2 pass above was
 * Claude-family end to end (concurrency-auditor + an Opus subagent);
 * per ADR-128's pre-merge policy this fix then also got an INDEPENDENT
 * cross-provider review (GPT-5.6-Sol via NEEDLE), which found what the
 * Claude-family passes missed:
 *   (High) TOKEN FENCING. Every prior write path here trusted "I
 *   successfully claimed at the START of this run" for the run's ENTIRE
 *   remaining duration — the heartbeat's takeover deadline narrows the
 *   window a stale-but-still-executing holder can keep writing after a
 *   resumer takes over, but does not CLOSE it (a process whose heartbeat
 *   calls failed can resume writing the instant connectivity recovers,
 *   before its next heartbeat tick has a chance to detect the theft). Fixed
 *   in `smi5879-census.ts`'s `populate()`/`seal()` and
 *   `smi5879-census.branches.writes.ts`'s `writeOutcomesBatch()`/
 *   `updateOutcomesBatch()` — every one of those writes is now fenced by
 *   `runner_token` inline in the SAME write statement (no new SQL
 *   function), and every one throws loudly on a fenced-out write rather
 *   than silently no-op-ing.
 *   (Medium, same root cause) The seal-attribution ambiguity — see
 *   `seal()`'s own doc comment for how token-fencing plus `RETURNING`
 *   directly replaces this module's former `assertGenerationSealed`.
 *   (Medium) `p_takeover_after` is now passed EXPLICITLY to
 *   `smi5879_claim_run` from the SAME `HEARTBEAT_TAKEOVER_AFTER_MS`
 *   constant `startCensusHeartbeat` uses, rather than relying on the SQL
 *   function's own DEFAULT staying in sync by code-comment convention —
 *   see {@link obtainClaimedRun}'s claim-call comment.
 */

import { randomUUID } from 'node:crypto'
import {
  runPsql,
  queryRows,
  queryScalar,
  nullable,
  type PgConnParams,
} from './smi5879-census.pg.ts'
import { HEARTBEAT_TAKEOVER_AFTER_MS } from './smi5879-census.heartbeat.ts'
import type { Smi5879Purpose } from './smi5879-census.types.ts'

/** Build a fresh `run_id` — legible (`purpose` + timestamp) plus a random suffix for uniqueness. */
function buildRunId(purpose: Smi5879Purpose): string {
  return `smi5879-${purpose}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
}

/**
 * True when `run_id` already has at least one `smi5879_snapshot_pre` row.
 * Population load is genuinely all-or-nothing — see this module's header —
 * so "any row present" therefore unambiguously means "fully loaded."
 */
export async function isPopulated(conn: PgConnParams, runId: string): Promise<boolean> {
  const scalar = await queryScalar(
    conn,
    `SELECT EXISTS(SELECT 1 FROM smi5879_snapshot_pre WHERE run_id = :'run_id')`,
    { run_id: runId }
  )
  return scalar === 't'
}

/**
 * Pure UX advisory for the FRESH-start path, run immediately before
 * `INSERT INTO smi5879_run`. If an `open` generation already exists, a bare
 * `INSERT` would fail on the `smi5879_run_one_open` unique index with a raw,
 * unhelpful Postgres constraint-violation message — this turns that into an
 * actionable suggestion to use `--resume` instead. This is NOT the
 * enforcement boundary (the unique index is, unchanged) — a TOCTOU race on
 * this check-then-act is harmless: worst case it fails to fire and the
 * caller gets the exact same raw constraint-violation error they'd have
 * gotten without this check at all.
 */
async function warnIfOpenRunExistsForFreshStart(conn: PgConnParams): Promise<void> {
  const openRunId = await queryScalar(conn, `SELECT run_id FROM smi5879_run WHERE status = 'open'`)
  if (openRunId !== null) {
    throw new Error(
      `SMI-5879: a generation is already 'open' (run_id=${openRunId}) — smi5879_run_one_open ` +
        'permits at most one open generation database-wide, so creating a fresh one here would ' +
        'fail. If this is a crashed/interrupted prior attempt you want to continue, re-run with ' +
        '--resume (matching --purpose/--ruleset-epoch). If it is a different, still-legitimately-' +
        'running generation, wait for it to seal or investigate before starting a new one.'
    )
  }
}

/**
 * Discover the run to resume for `--resume`. Queries for THE singleton
 * `open` row (if any — see this module's header for why discovery is
 * unambiguous) and verifies its `purpose`/`ruleset_epoch` match `purpose`/
 * `rulesetEpoch` exactly, mirroring the sibling `smi5879-simulate-full.ts`
 * checkpoint tool's `assertCheckpointIdentity` contract: refuse loudly on
 * any mismatch rather than silently resuming the wrong generation.
 *
 * `ruleset_epoch` equality is checked IN SQL (`= :'ruleset_epoch'::timestamptz`)
 * rather than by comparing strings in JS — the DB renders timestamptz values
 * in its own canonical format (e.g. `2026-07-29 23:41:09+00`), which is NOT
 * byte-identical to the ISO8601 string the CLI accepts
 * (`2026-07-29T23:41:09Z`) even when they denote the exact same instant; a
 * JS-side string comparison would false-mismatch a genuinely-matching epoch.
 *
 * Scoped ONLY to `status = 'open'` — a `sealed`/`abandoned` generation is
 * never resumable (this module's header explains why). Discovery is
 * advisory only, same as {@link warnIfOpenRunExistsForFreshStart} — the
 * actual takeover safety comes entirely from `smi5879_claim_run`'s own CAS,
 * called unconditionally right after this returns (see
 * {@link obtainClaimedRun}).
 */
export async function findResumableRun(
  conn: PgConnParams,
  purpose: Smi5879Purpose,
  rulesetEpoch: string
): Promise<string> {
  const rows = await queryRows(
    conn,
    `SELECT run_id, purpose,
            (ruleset_epoch = :'ruleset_epoch'::timestamptz) AS epoch_matches
       FROM smi5879_run
      WHERE status = 'open'`,
    { ruleset_epoch: rulesetEpoch }
  )
  if (rows.length === 0) {
    throw new Error(
      "SMI-5879: --resume was requested but no 'open' generation exists to resume. " +
        'smi5879_run_one_open guarantees at most one open row database-wide, so this means ' +
        'either nothing has been started yet, or the prior attempt already sealed/was ' +
        'abandoned. Drop --resume to start a fresh generation (a COLD START — confirm no real ' +
        'progress is being discarded first), or investigate why no open row exists.'
    )
  }
  // SMI-5879 checkpoint/resume round-2 review finding: this function's own
  // "discovery is unambiguous" claim rests entirely on smi5879_run_one_open
  // actually being a live unique index — `CREATE UNIQUE INDEX IF NOT EXISTS`
  // matches by NAME only, so a same-named-but-non-unique or invalidated index
  // would satisfy that DDL silently. Assert the singleton this function's own
  // contract depends on, rather than silently taking rows[0] and leaving a
  // schema-drift scenario to produce a wrong resume with no diagnostic at all.
  if (rows.length > 1) {
    throw new Error(
      `SMI-5879: --resume discovery found ${rows.length} 'open' generations, not at most one as ` +
        'smi5879_run_one_open is supposed to guarantee database-wide. This indicates that unique ' +
        'index is missing, non-unique, or invalidated — a schema-integrity problem, not routine ' +
        'contention. Refusing to guess which one to resume. Investigate the index before retrying: ' +
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'smi5879_run_one_open';`
    )
  }
  // SMI-5879 coordinator review (2026-08-30): rows.length === 1 is confirmed
  // above (neither 0 nor >1), so rows[0] is structurally guaranteed to exist
  // — but noUncheckedIndexedAccess can't see that guarantee statically. Assert
  // it with the same diagnostic-throw style as the rows.length > 1 check
  // above, rather than a silent non-null assertion, so a genuine queryRows
  // contract violation still fails loudly instead of surfacing as a raw
  // "undefined is not iterable" crash.
  const firstRow = rows[0]
  if (!firstRow) {
    throw new Error(
      'SMI-5879: --resume discovery confirmed rows.length === 1 but rows[0] was undefined — ' +
        'this should be structurally impossible and indicates a queryRows contract violation, ' +
        'not routine contention. Investigate before retrying.'
    )
  }
  const [runId, foundPurpose, epochMatches] = firstRow
  // Same rationale as the firstRow guard above: run_id is a NOT NULL column,
  // so this is structurally impossible for a real query result — but a plain
  // non-tuple array destructure still types each element as `T | undefined`
  // under noUncheckedIndexedAccess. Narrow explicitly rather than assert.
  if (runId === undefined) {
    throw new Error(
      'SMI-5879: --resume discovery row exists but its first column (run_id) was undefined — ' +
        'this should be structurally impossible for a NOT NULL column. Investigate before retrying.'
    )
  }
  if (foundPurpose !== purpose || epochMatches !== 't') {
    throw new Error(
      `SMI-5879: --resume found an open generation (run_id=${runId}, purpose=${foundPurpose}) ` +
        `that does not match this invocation's --purpose=${purpose}/--ruleset-epoch=${rulesetEpoch}. ` +
        'Refusing to resume a mismatched generation — a resume must reuse the SAME purpose/' +
        'ruleset-epoch the open generation was created with. Use the matching --purpose/' +
        '--ruleset-epoch, or drop --resume for a fresh generation once you have confirmed this ' +
        'mismatched open row is not still in legitimate use.'
    )
  }
  return runId
}

/** The subset of `CliArgs` (smi5879-census.ts) {@link obtainClaimedRun} needs — kept narrow to avoid a circular import with that file. */
export interface ObtainClaimedRunArgs {
  purpose: Smi5879Purpose
  rulesetEpoch: string
  resume: boolean
}

/**
 * Obtain a claimed `run_id` — either a fresh one (default: advisory
 * pre-check, `INSERT`, then claim) or the existing open one (`--resume`:
 * {@link findResumableRun}, then the SAME claim call). Both paths converge
 * on the identical `smi5879_claim_run` CAS — the sole enforcement point
 * deciding whether this invocation may proceed. Throws a context-appropriate
 * error on refusal: a fresh claim being refused is unexpected (freshly
 * `INSERT`ed, nobody else could hold it yet); a resume claim being refused
 * means another process's heartbeat is still fresh — refusing to steal it.
 */
export async function obtainClaimedRun(
  conn: PgConnParams,
  args: ObtainClaimedRunArgs,
  token: string,
  holder: string
): Promise<string> {
  let runId: string
  if (args.resume) {
    runId = await findResumableRun(conn, args.purpose, args.rulesetEpoch)
  } else {
    runId = buildRunId(args.purpose)
    await warnIfOpenRunExistsForFreshStart(conn)
    await runPsql(
      conn,
      `INSERT INTO smi5879_run (run_id, purpose, ruleset_epoch) VALUES (:'run_id', :'purpose', :'ruleset_epoch');`,
      { run_id: runId, purpose: args.purpose, ruleset_epoch: args.rulesetEpoch }
    )
  }

  // SMI-5879 checkpoint/resume round-2 review finding: bound the wait. The
  // fresh path always targets a run_id THIS same process just INSERTed
  // (nobody else could hold a row lock on it), but `--resume` newly targets
  // a PRE-EXISTING row a frozen/hung sibling process's own populate()/seal()/
  // guard-trigger `FOR UPDATE` could still be holding (the design's stated
  // production trigger — "plausibly routine laptop sleep/wake" — freezes a
  // container, it does not always kill it outright). Without this, that
  // scenario hangs `smi5879_claim_run`'s UPDATE indefinitely with zero
  // output; with it, the wait is bounded to a diagnosable error. Verified
  // live: `SET lock_timeout` here is session-scoped to THIS one psql
  // subprocess only (each queryRows call is its own fresh session) and does
  // not affect any other statement.
  //
  // SMI-5879 checkpoint/resume round-3 (cross-model review) finding
  // (Medium): `p_takeover_after` is passed EXPLICITLY here — never relying
  // on `smi5879_claim_run`'s own DEFAULT interval '30 minutes' — using the
  // SAME `HEARTBEAT_TAKEOVER_AFTER_MS` constant `startCensusHeartbeat` uses
  // to decide when a persistently-failing heartbeat must self-terminate.
  // Previously these were two independently-defined values kept in sync only
  // by a code comment; if the DB default and the TS constant ever drifted
  // (or two deployed versions of this tool disagreed), a claim could become
  // takeover-eligible before the original holder considered itself stale —
  // widening the dual-writer window this fencing exists to close. A single
  // JS source of truth for both eliminates the drift entirely.
  //
  // Round-4 (cross-model review, Medium) follow-up: making this the
  // AUTHORITATIVE value (not mere documentation of the SQL default) means
  // it must still satisfy the migration's own ordering invariant —
  // `HEARTBEAT_TAKEOVER_AFTER_MS < smi5879_gc_force_abandon`'s
  // `p_stale_after` default (2h, still a bare SQL literal, never passed
  // explicitly) — asserted by `smi5879-census.heartbeat.test.ts`'s
  // "migration's documented ordering invariant" test, not enforced here at
  // runtime. See {@link HEARTBEAT_TAKEOVER_AFTER_MS}'s own doc comment.
  //
  // FRAGILITY NOTE (round-5 confirmation review, Informational): this is
  // safe ONLY because `SET lock_timeout = ...` emits no row output — the
  // SAME multi-statement-`queryRows` ambiguity `seal()` got burned by (see
  // `smi5879-census.lifecycle.ts`'s doc comment for the live-reproduced bug
  // it caused there) would resurface here if a future edit ever prepends a
  // row-producing statement before this `SELECT`. If that becomes
  // necessary, distinguish rows STRUCTURALLY (by column count, matching
  // `seal()`'s fix), never by a naming/prefix convention on a value.
  const claimed = await queryRows(
    conn,
    `SET lock_timeout = '10s'; ` +
      `SELECT run_id, runner_token FROM smi5879_claim_run(` +
      `:'run_id', :'token', :'holder', (:'takeover_after_ms' || ' milliseconds')::interval);`,
    {
      run_id: runId,
      token,
      holder,
      takeover_after_ms: String(HEARTBEAT_TAKEOVER_AFTER_MS),
    }
  )
  if (claimed.length === 0) {
    if (args.resume) {
      throw new Error(await describeResumeClaimRefusal(conn, runId))
    }
    throw new Error(
      `SMI-5879: claim of freshly-created generation ${runId} was refused — unexpected.`
    )
  }

  if (args.resume) {
    // SMI-5879 checkpoint/resume round-2 review finding (Low): a resumed
    // generation's smi5879_repo_branch rows can span two (potentially far
    // apart) wall-clock windows — a repo renamed/deleted/re-defaulted in the
    // gap is recorded at whichever instant its half was resolved. Per-row
    // `resolved_at` already makes this forensically recoverable, but nothing
    // previously recorded on the registry row itself that a resume even
    // happened. `notes` (SECTION 1 of the migration) exists for exactly this
    // and had no other writer — append rather than overwrite so a
    // multiply-resumed generation keeps every resume's own record.
    await runPsql(
      conn,
      `UPDATE smi5879_run
          SET notes = COALESCE(notes || E'\n', '') || :'note'
        WHERE run_id = :'run_id';`,
      { run_id: runId, note: `resumed at ${new Date().toISOString()} by ${holder}` }
    )
  }
  return runId
}

/**
 * SMI-5879 checkpoint/resume round-2 review finding (Medium): a zero-row
 * `smi5879_claim_run` result means one of TWO structurally different things
 * — (1) another process genuinely holds a live claim (fresh heartbeat), for
 * which waiting is the correct advice, or (2) the generation's `status` has
 * moved to `abandoned` (or was already `sealed` by someone else) since
 * discovery, for which waiting is FUTILE — `smi5879_claim_run`'s own
 * `status IN ('open','sealed')` predicate means an abandoned row can never
 * become claimable again, no matter how long the operator waits. The
 * PREVIOUS single fixed message asserted case (1) unconditionally, which
 * actively misdirects an operator in case (2) — exactly the state
 * `smi5879_gc_force_abandon` (the pre-`--resume` recovery path this module's
 * header names) puts a generation into. Distinguish them with one follow-up
 * read.
 */
export async function describeResumeClaimRefusal(
  conn: PgConnParams,
  runId: string
): Promise<string> {
  const rows = await queryRows(
    conn,
    `SELECT status, runner_holder, runner_heartbeat_at FROM smi5879_run WHERE run_id = :'run_id'`,
    { run_id: runId }
  )
  const [status, holder, heartbeatAt] = rows[0] ?? []
  if (status !== undefined && status !== 'open' && status !== 'sealed') {
    return (
      `SMI-5879: --resume could not claim generation ${runId} — its status is now '${status}', not ` +
      "'open'/'sealed'. It was transitioned by a CONCURRENT process between this invocation's " +
      'discovery and its claim attempt (e.g. an operator running smi5879_gc_force_abandon at the ' +
      'same time). Waiting will NOT help — smi5879_claim_run never reopens a non-open/sealed row, ' +
      'no matter how long the wait. Start a fresh generation instead (drop --resume).'
    )
  }
  // A missing cell (row entirely absent) is a DIFFERENT condition from a
  // present-but-SQL-NULL cell (nullable()'s own job) — handle the former
  // before delegating to the latter rather than passing `undefined` into a
  // function typed to accept only `string`.
  const display = (cell: string | undefined): string =>
    cell === undefined ? 'unknown' : (nullable(cell) ?? 'unknown')
  return (
    `SMI-5879: --resume could not claim generation ${runId} — another process ` +
    `(holder=${display(holder)}, last heartbeat=${display(heartbeatAt)}) ` +
    `appears to hold an active claim (its heartbeat has not gone stale past the ` +
    `${Math.round(HEARTBEAT_TAKEOVER_AFTER_MS / 60_000)}-minute takeover threshold this run passes ` +
    'explicitly to smi5879_claim_run). Refusing to steal a live claim. Confirm no other process is ' +
    'genuinely still running before retrying, or wait for its heartbeat to go stale.'
  )
}
