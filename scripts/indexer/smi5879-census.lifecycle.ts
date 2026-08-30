/**
 * Population load + seal for smi5879-census.ts (design doc 8.3.5.2.3/8.3.5.2.4).
 * @module scripts/indexer/smi5879-census.lifecycle
 *
 * Split out of smi5879-census.ts (CLAUDE.md's <500-line-per-file budget —
 * the SMI-5879 checkpoint/resume follow-up's token-fencing additions pushed
 * that file over) — no logical boundary change, same code `runCensus()`
 * already called. Both functions are TOKEN-FENCED (SMI-5879 checkpoint/
 * resume, cross-model review finding — High): every write here requires
 * `runner_token = :'token'` in the same statement as the write itself, so a
 * claim that was silently taken over mid-run can never keep writing.
 */

import { queryRows, type PgConnParams } from './smi5879-census.pg.ts'

/**
 * Population load — design doc 8.3.5.2.3's SQL shape, one `REPEATABLE READ`
 * transaction, TOKEN-FENCED. The standalone `SELECT ... FOR UPDATE`
 * pre-check (now ALSO requiring `runner_token = :'token'`) acquires the
 * registry-row lock FIRST, as its own EARLIER statement — round-3 briefly
 * folded this into a `CROSS JOIN` inside the `INSERT` itself and a round-4
 * cross-model review caught that this changes lock-ORDERING even though the
 * row-level fencing still worked correctly in isolation: an `UPDATE`/
 * `INSERT`'s own FROM-list subqueries are not guaranteed to evaluate
 * strictly after that statement's row lock is acquired, so folding the
 * fence into a single combined statement is safe for population load
 * (nothing here computes an aggregate over what OTHER writers are doing)
 * but is NOT safe for `seal()` below (see that function's doc comment for
 * the empirically-reproduced undercounting bug this exact pattern caused
 * there). Restored here anyway, even though benign for this specific
 * statement, so both writers share the identical, unambiguous "lock first,
 * as a separate earlier statement" shape — no longer relying on a
 * per-statement judgment call about whether folding is safe. The
 * `CROSS JOIN` fence inside the `INSERT` itself still does the actual
 * write-gating (verified live: a token mismatch dilutes the ENTIRE INSERT
 * to zero rows, never partial, never an error THROUGH THIS PATH — see the
 * REPEATABLE-READ-specific exception in the post-write verification
 * below).
 *
 * POST-WRITE VERIFICATION (round-4 Low finding, round-5 confirmation-review
 * strengthening): round 4 checked "do I still hold the claim" via a
 * SEPARATE, LATER, unlocked read — round 5 found this left a genuinely
 * empty `skills` table sealing successfully with all invariants passing
 * (informational for a fenced write specifically — an empty source and a
 * fenced-out write are indistinguishable either way — but a real data-
 * completeness gap for the tool's actual job: catching an incomplete
 * population before it gates a merge). Replaced with a same-SNAPSHOT
 * comparison instead: a trailing `SELECT` (still inside this same
 * REPEATABLE READ transaction, so it sees exactly what the `INSERT` saw,
 * not a possibly-already-different `skills` read moments after COMMIT)
 * returns `(loaded, source)` — the row counts of `smi5879_snapshot_pre` and
 * `skills` respectively — which must be EQUAL by construction (the fenced
 * INSERT is `FROM skills s` unfiltered). A mismatch means either the fence
 * rejected the write (claim lost) or a genuine data-integrity anomaly;
 * either way, fail loudly rather than seal an incomplete population.
 * Structurally distinguished from the pre-check's own 1-column output the
 * same way `seal()` disambiguates its `RETURNING` row — by column COUNT
 * (2, not a naming convention), not by any value that could collide with
 * caller-controlled data (see that function's own doc comment for why a
 * string-prefix convention was proven insufficient). The one residual gap
 * (claim lost AND `skills` is ALSO genuinely empty, so `0 === 0` matches)
 * is bounded, not silent: EVERY subsequent write this generation makes
 * (branch-resolution batches, `seal()`) is independently token-fenced and
 * would reject a still-stolen claim at that point instead. Exported for
 * direct fencing tests.
 */
export async function populate(conn: PgConnParams, runId: string, token: string): Promise<void> {
  let rows: string[][]
  try {
    rows = await queryRows(
      conn,
      `BEGIN ISOLATION LEVEL REPEATABLE READ;
       SELECT run_id FROM smi5879_run WHERE run_id = :'run_id' AND status = 'open' AND runner_token = :'token' FOR UPDATE;
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
       FROM skills s
       CROSS JOIN (
         SELECT 1 FROM smi5879_run r
          WHERE r.run_id = :'run_id' AND r.status = 'open' AND r.runner_token = :'token'
          FOR UPDATE
       ) fence;
       SELECT (SELECT count(*) FROM smi5879_snapshot_pre WHERE run_id = :'run_id')::text AS loaded,
              (SELECT count(*) FROM skills)::text AS source;
       COMMIT;`,
      { run_id: runId, token }
    )
  } catch (err) {
    // SMI-5879 cross-model review round-4 finding (Medium): under
    // REPEATABLE READ specifically (unlike seal()'s/the batch writes'
    // READ COMMITTED), a genuine takeover racing this transaction's own
    // fence-lock wait does NOT resolve to "0 rows, no error" — Postgres
    // raises SQLSTATE 40001 ("could not serialize access due to concurrent
    // update") instead, verified live. Without this catch, the operator
    // sees a raw, unhelpful psql exit-3 message that never mentions claims
    // or tokens. Recognized here and re-thrown as the same claim-lost
    // signal every other fencing rejection produces.
    const message = (err as Error).message
    if (/could not serialize access due to concurrent update/i.test(message)) {
      throw new Error(
        `SMI-5879: population load for ${runId} aborted with a serialization failure ` +
          '(SQLSTATE 40001) while waiting on the claim fence — a concurrent process (e.g. a ' +
          'resumer) committed a claim change while this transaction was blocked acquiring the ' +
          'registry-row lock. This run no longer holds a live claim; stop immediately, do not ' +
          'retry with the same token.'
      )
    }
    throw err
  }

  const comparisonRow = rows.find((r) => r.length === 2)
  if (!comparisonRow) {
    throw new Error(
      `SMI-5879: population load for ${runId} did not return its own row-count comparison — this ` +
        'should be impossible (the trailing SELECT always returns exactly one 2-column row); ' +
        'investigate before trusting anything about this population.'
    )
  }
  const [loaded, source] = comparisonRow
  if (loaded !== source) {
    throw new Error(
      `SMI-5879: population load for ${runId} loaded ${loaded} row(s) but skills has ${source} ` +
        '(measured within the SAME REPEATABLE READ snapshot, so this is not staleness) — either ' +
        "the claim fence rejected the write (token mismatch, or the generation is no longer 'open') " +
        'or a genuine data-integrity anomaly. Do not trust any rows this call may have inserted; ' +
        'stop immediately, do not retry with the same token.'
    )
  }
}

/**
 * Seal — design doc 8.3.5.2.4's SQL shape: count + digest + status flip in
 * one transaction, TOKEN-FENCED and self-verifying (High + Medium findings).
 *
 * LOCK ORDERING (round-4 cross-model review, High — empirically
 * reproduced): the standalone `SELECT ... FOR UPDATE` pre-check is NOT
 * optional here, unlike its round-3-removed counterpart in `populate()`
 * above. Design doc SECTION 6 states sealing "must compute the count and
 * the digest and flip the status in ONE transaction, BEHIND THE SAME
 * REGISTRY-ROW LOCK every writer's trigger takes... splitting them
 * reintroduces the exact race SECTION 4 closes" — round 3 folded the lock
 * into the `UPDATE`'s own `WHERE runner_token = :'token'` clause and
 * dropped the separate pre-check, reasoning the `UPDATE`'s row lock would
 * cover it. It does NOT: `row_count = c.n`'s `FROM (SELECT count(*) ...) c`
 * subquery and the `smi5879_population_digest()`/`smi5879_branch_digest()`
 * calls are not guaranteed to evaluate strictly after the `UPDATE`
 * acquires (or blocks on) the target row's lock, so a concurrent writer
 * that is still mid-commit when `c` is computed, but finishes committing
 * before the `UPDATE`'s own lock is granted, is silently UNDER-COUNTED —
 * reproduced live: a writer holding the guard-trigger lock, committing 3s
 * into a blocked seal, produced `row_count=1`/`population_digest` for a
 * `smi5879_snapshot_pre` that actually held 2 rows. The pre-check restores
 * the ORIGINAL ordering guarantee (acquire the lock as an earlier,
 * separate statement, so every writer either commits before this lock is
 * taken and is counted, or blocks until this transaction commits and then
 * fails its own status check — "no third interleaving," design doc
 * SECTION 4) while ALSO requiring the matching token, so an already-stale
 * caller fails here too rather than proceeding to the `UPDATE`.
 *
 * SELF-VERIFICATION (Medium): `RETURNING` makes the affected-row-count
 * check ATOMIC with the `UPDATE` itself — this is what actually fixes the
 * round-2 `assertGenerationSealed` flaw the cross-model review caught:
 * that function did a SEPARATE, LATER `SELECT` of `status`, which cannot
 * distinguish "I just sealed this" from "someone else already sealed this
 * and I merely observed it." Checking THIS statement's own returned row
 * count needs no such inference. Zero rows returned means either the
 * token no longer matches (claim lost) or `status <> 'open'` (already
 * sealed/abandoned by someone else) — both are fatal, never retried.
 *
 * DISTINGUISHING THE `RETURNING` ROW STRUCTURALLY, NOT BY NAMING CONVENTION
 * (round-5 confirmation review, own-fix bug caught by direct live
 * reproduction): restoring the pre-check `SELECT` above means TWO
 * statements in this one script now produce row output — `queryRows`
 * concatenates ALL of it with no way to tell which statement produced which
 * line (its own doc comment says as much). A naive `rows.length !== 1`
 * check is WRONG here: it saw 2 concatenated rows (the pre-check's bare
 * `run_id` plus the `UPDATE`'s own `RETURNING`) and threw "0 rows updated"
 * on a seal that had ACTUALLY succeeded — caught by literally re-running
 * this exact race live and observing `status` flip to `'sealed'` in the
 * database while this function simultaneously reported failure.
 *
 * The FIRST fix for that (round 4) prefixed the `RETURNING` value with a
 * `'SEALED:'` marker string, reasoning no real `run_id` could ever collide
 * with it. Round 5 proved that reasoning insufficient by live reproduction:
 * `run_id` is attacker/caller-controlled data (verified live with a
 * `run_id` of literally `SEALED:evil-run-id`, and a second run_id
 * containing an embedded `\n` immediately followed by `SEALED:` — both
 * reproduced the EXACT same "DB says sealed, function says failed" symptom
 * the marker was built to prevent). A string-prefix CONVENTION on
 * caller-controlled data is not a structural guarantee.
 *
 * The actual fix: distinguish the two statements' output by ROW SHAPE, not
 * by value. The pre-check always returns exactly 1 column (`run_id`); the
 * `UPDATE`'s `RETURNING` here returns exactly 2 (`run_id, sealed_ok`) — a
 * property of the query's own column LIST, entirely independent of what
 * value `run_id` holds, so no `run_id` (however adversarial) can ever
 * produce a 2-column row from the pre-check. `rows.filter((r) => r.length
 * === 2)` is therefore airtight where a string-prefix filter was not.
 * Exported for direct fencing tests.
 */
export async function seal(conn: PgConnParams, runId: string, token: string): Promise<void> {
  const rows = await queryRows(
    conn,
    `BEGIN;
     SELECT run_id FROM smi5879_run WHERE run_id = :'run_id' AND status = 'open' AND runner_token = :'token' FOR UPDATE;
     UPDATE smi5879_run r
        SET status             = 'sealed',
            snapshot_sealed_at = now(),
            row_count          = c.n,
            population_digest  = smi5879_population_digest(:'run_id'),
            branch_digest      = smi5879_branch_digest(:'run_id')
       FROM (SELECT count(*) AS n FROM smi5879_snapshot_pre WHERE run_id = :'run_id') c
      WHERE r.run_id = :'run_id'
        AND r.status = 'open'
        AND r.runner_token = :'token'
     RETURNING r.run_id, true AS sealed_ok;
     COMMIT;`,
    { run_id: runId, token }
  )
  const sealedRows = rows.filter((r) => r.length === 2)
  if (sealedRows.length !== 1) {
    throw new Error(
      `SMI-5879: seal() did not seal generation ${runId} (${sealedRows.length} row(s) updated, ` +
        'expected 1) — either this run no longer holds a live claim (token mismatch), or status ' +
        "was already <> 'open' (sealed or abandoned by a concurrent process). This invocation " +
        'performed no reliable work; do not trust any report generated from it.'
    )
  }
}
