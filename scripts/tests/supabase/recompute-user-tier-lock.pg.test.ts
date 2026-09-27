/**
 * SMI-6656 regression suite -- `recompute_user_tier()`'s lost-update race and
 * `recompute_team_members_tier()`'s member-ordering deadlock, exercised with TWO REAL,
 * SIMULTANEOUS Postgres sessions.
 *
 * THE BUGS. `recompute_user_tier(UUID)` computed the new tier in one statement and
 * persisted it in a separate UPDATE, taking no lock first. Under READ COMMITTED, a
 * recompute whose SELECT saw stale sources can still commit its UPDATE AFTER a concurrent
 * writer already recomputed with newer sources -- the newer value is silently overwritten
 * (a lost update). Separately, `recompute_team_members_tier(TEXT)`'s member loop had no
 * ORDER BY, so two concurrent calls over overlapping rosters could lock member profiles
 * rows in opposite orders and deadlock.
 *
 * Every test here drives a controlled interleaving between independent psql sessions. A
 * sequential simulation would prove nothing -- a locked read and an unlocked read, or an
 * ordered loop and an unordered one, are indistinguishable to a session with no
 * competitor. Harness, connection env vars and the CI-coverage gap: see
 * ./recompute-user-tier-lock.test-helpers.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  PsqlSession,
  requireTestConn,
  noLiveTestPg,
  schemaSql,
  fixtureSql,
  TEST_USER,
  SUB_A,
  MEMBERS,
  MEMBER_COUNT,
  SUB_TEAM_1,
  SUB_TEAM_2,
  CONTROL_USER,
  SUB_CONTROL,
  type TestConn,
} from './recompute-user-tier-lock.test-helpers.ts'

let conn: TestConn
let ctl: PsqlSession // control/assertion session
let a: PsqlSession
let b: PsqlSession

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function tierOf(userId: string): Promise<string> {
  const { stdout } = await ctl.send(`SELECT tier FROM profiles WHERE id = '${userId}';`)
  return stdout
}

describe.skipIf(noLiveTestPg)('SMI-6656 -- recompute_user_tier lock, two live sessions', () => {
  beforeAll(async () => {
    conn = requireTestConn()
    ctl = new PsqlSession(conn, 'ctl')
    const { stderr } = await ctl.send(schemaSql(), 60_000)
    // A failed schema build must be loud: every assertion below would otherwise pass or
    // fail for the wrong reason.
    expect(stderr, `schema build failed:\n${stderr}`).not.toMatch(/ERROR/)
  }, 90_000)

  afterAll(async () => {
    await Promise.all([ctl?.close(), a?.close(), b?.close()])
  })

  beforeEach(async () => {
    await a?.close()
    await b?.close()
    a = new PsqlSession(conn, 'A')
    b = new PsqlSession(conn, 'B')
    await ctl.send(fixtureSql())
  })

  // ==========================================================================
  // REQUIREMENT 1 -- the lost-update race itself.
  // ==========================================================================
  it("does not lose B's newer recompute to A's stale one (recompute_user_tier)", async () => {
    // B takes the profiles(TEST_USER) row lock FIRST, via an ordinary UPDATE -- standing
    // in for "A has already read its stale snapshot and is somewhere between its own
    // SELECT and its own UPDATE" from the caller's point of view. Held open.
    await b.send('BEGIN;')
    const hold = await b.send(
      `UPDATE profiles SET updated_at = now() WHERE id = '${TEST_USER}' AND TRUE;`
    )
    expect(hold.stderr).not.toMatch(/ERROR/)

    // A fires its recompute concurrently, without awaiting. Pre-fix: its SELECT (no lock
    // needed) runs immediately against the CURRENT committed subscriptions ('individual'),
    // then its UPDATE blocks on B's held lock. Post-fix: its very first statement (the new
    // FOR NO KEY UPDATE) blocks immediately, before it has read anything at all.
    // Capture A's own backend PID BEFORE firing, so the wait below is attributed to A and
    // not to any other backend that happens to be waiting on a lock while running this
    // function. Counting "some active backend whose query text matches" would go green on a
    // shared or concurrently-used test database when A itself had not yet connected.
    const aPid = (await a.send('SELECT pg_backend_pid();')).stdout.trim()
    expect(aPid).toMatch(/^\d+$/)

    const recomputeA = a.fire(`SELECT recompute_user_tier('${TEST_USER}');`)

    // Assert A is REALLY blocked on the row lock before B proceeds. A bare sleep-then-check
    // cannot tell "A blocked" from "A never connected": if A reached the server only after
    // B committed, the whole call would run post-commit, return 'enterprise', and this test
    // would pass having constructed no race at all -- the same silence-as-success shape the
    // fix exists to remove. So observe the wait itself from a THIRD session, and fail if it
    // never appears. Scoped to A's own PID: a match on "any active backend running this
    // function and waiting on a lock" is satisfiable by an unrelated session on a shared test
    // database, which would make this guard green while A had not yet connected at all.
    const blockedWaiterCount = async (): Promise<number> => {
      const r = await ctl.send(
        `SELECT count(*) FROM pg_stat_activity
          WHERE pid = ${aPid}
            AND state = 'active'
            AND wait_event_type = 'Lock';`
      )
      return Number.parseInt(r.stdout.trim(), 10)
    }
    let sawBlocked = false
    for (let i = 0; i < 40 && !sawBlocked; i++) {
      if ((await blockedWaiterCount()) >= 1) sawBlocked = true
      else await sleep(250)
    }
    expect(
      sawBlocked,
      'A was never observed waiting on a lock, so no race was constructed and the assertion ' +
        'below would pass vacuously. Either A never reached the server or the lock is absent.'
    ).toBe(true)

    // And it has not landed anything yet -- the row is still whatever B's harmless touch
    // left it as (unchanged tier).
    expect(await tierOf(TEST_USER)).toBe('community')

    // B now changes the SOURCE (upgrades the subscription), recomputes for real, and
    // commits -- all while still holding the SAME open transaction from above.
    const upgrade = await b.send(
      `UPDATE subscriptions SET tier = 'enterprise' WHERE id = '${SUB_A}' AND TRUE;`
    )
    expect(upgrade.stderr).not.toMatch(/ERROR/)
    const recomputeB = await b.send(`SELECT recompute_user_tier('${TEST_USER}');`)
    expect(recomputeB.stderr).not.toMatch(/ERROR/)
    expect(recomputeB.stdout).toBe('enterprise')
    await b.send('COMMIT;')

    const recomputeAResult = await recomputeA
    expect(recomputeAResult.stderr).not.toMatch(/ERROR|deadlock/i)

    // THE REGRESSION ASSERTION. Pre-fix, A's UPDATE (unblocked once B committed) persisted
    // A's STALE computed value ('individual'), silently overwriting B's already-committed
    // 'enterprise'. Post-fix, A's lock forces it to compute AFTER B's commit, so it agrees.
    expect(await tierOf(TEST_USER)).toBe('enterprise')
    expect(recomputeAResult.stdout).toBe('enterprise')
  }, 60_000)

  // ==========================================================================
  // REQUIREMENT 2 -- no deadlock across two overlapping-roster recomputes.
  // ==========================================================================
  it('does not deadlock when two sessions recompute overlapping team rosters', async () => {
    // Team T1 (SUB_TEAM_1) has MEMBERS inserted in that physical order; team T2 (SUB_TEAM_2)
    // has the SAME MEMBER_COUNT members inserted in FULLY REVERSED order (fixtureSql). Fired
    // back-to-back with no stagger so both sessions' member-by-member lock acquisition races
    // to overlap -- the same interleaving two concurrent subscription-change webhooks for
    // these two teams would produce. MEMBER_COUNT is 8, not 2: see this suite's own header
    // and the test-helpers' MEMBERS doc comment for why a longer roster is what makes this
    // reproduction measuredly reliable rather than an intermittent coin flip.
    const teamA = a.fire(`SELECT recompute_team_members_tier('${SUB_TEAM_1}');`)
    const teamB = b.fire(`SELECT recompute_team_members_tier('${SUB_TEAM_2}');`)

    const [resultA, resultB] = await Promise.all([teamA, teamB])

    expect(resultA.stderr, `A stderr:\n${resultA.stderr}`).not.toMatch(/deadlock/i)
    expect(resultB.stderr, `B stderr:\n${resultB.stderr}`).not.toMatch(/deadlock/i)
    expect(resultA.stdout.trim()).toBe(String(MEMBER_COUNT))
    expect(resultB.stdout.trim()).toBe(String(MEMBER_COUNT))

    // Both teams are 'team'-tier active subscriptions and none of the members holds an
    // outranking own subscription, so every member converges on 'team'.
    for (const member of MEMBERS) {
      expect(await tierOf(member)).toBe('team')
    }
  }, 60_000)

  // ==========================================================================
  // REQUIREMENT 3 -- non-concurrent control: an ordinary single-session recompute still
  // returns and persists the right tier.
  // ==========================================================================
  it('still returns and persists the correct tier with no concurrency at all', async () => {
    const result = await ctl.send(`SELECT recompute_user_tier('${CONTROL_USER}');`)
    expect(result.stderr).not.toMatch(/ERROR/)
    expect(result.stdout).toBe('enterprise')
    expect(await tierOf(CONTROL_USER)).toBe('enterprise')

    // And the downgrade direction: cancelling the only source drops the tier back. Still
    // recompute_user_tier, single-session -- recompute_team_members_tier has no control
    // path in this suite.
    await ctl.send(
      `UPDATE subscriptions SET status = 'canceled' WHERE id = '${SUB_CONTROL}' AND TRUE;`
    )
    const again = await ctl.send(`SELECT recompute_user_tier('${CONTROL_USER}');`)
    expect(again.stdout).toBe('community')
    expect(await tierOf(CONTROL_USER)).toBe('community')
  }, 60_000)

  // ==========================================================================
  // REQUIREMENT 4 -- the lock is actually ACQUIRED, not merely present in the
  // source text.
  //
  // Why this test exists, and why it is now the ONLY thing asserting the lock.
  // The migration used to assert the statement's SHAPE by reading
  // pg_proc.prosrc. That block is DELETED -- do not read this comment as
  // describing a secondary guard that still exists. Five review rounds each
  // found a new way to satisfy a textual check while acquiring no lock:
  // `IF FALSE THEN <the statement> END IF;`, a /* */-commented copy, a
  // lowercase copy after the read, two whitespace spellings, the text inside a
  // string literal, and a nested block comment. The class is unbounded, so the
  // check was removed rather than patched a sixth time. What that cost is
  // recorded in the migration header: input-DEPENDENT predicate narrowing now
  // ships even when this suite runs, because this suite tests fixed fixture
  // ids. What survives here is the behavioural assertion.
  //
  // ATTRIBUTION. `xmax` is set by ANY row lock or update, so the probe row is
  // chosen so that nothing else in the function can set it: tier is already
  // 'community' and the user has no subscriptions and no team memberships, so
  // recompute returns 'community' and the function's own
  // `UPDATE ... WHERE tier IS DISTINCT FROM v_new_tier` matches no row.
  //
  // The tier assertion below narrows that but does not prove it. If the probe
  // row somehow pre-existed at a NON-community tier, the function would update
  // it TO community and both the tier and xmax assertions would still pass --
  // so xmax would be attributable to the UPDATE, not the lock. What rules that
  // out is the pre-call baseline (`xmax = 0`), which also fails in that case,
  // plus beforeEach deleting all profiles and users before reinserting. Stated
  // as a bounded argument rather than a guarantee, because it is one.
  //
  // The pre-call baseline is also the known-negative for the instrument
  // itself: without it, a tuple carrying a stale xmax from an earlier
  // rolled-back transaction reads as locked (measured -- it is how a first
  // draft of this test passed the IF FALSE mutation it exists to catch).
  // ==========================================================================
  it('actually acquires the row lock, not just the text of one', async () => {
    const PROBE = '66560000-0000-0000-0000-0000000000ff'
    await ctl.send(
      `INSERT INTO auth.users (id, email) VALUES ('${PROBE}', 'smi6656-probe@example.test')
         ON CONFLICT DO NOTHING;
       INSERT INTO profiles (id, email, tier, role)
         VALUES ('${PROBE}', 'smi6656-probe@example.test', 'community', 'user')
         ON CONFLICT DO NOTHING;`
    )

    const lockedFlag = async (s: PsqlSession): Promise<string> =>
      (
        await s.send(`SELECT (xmax <> '0')::text FROM profiles WHERE id = '${PROBE}';`)
      ).stdout.trim()

    await a.send('BEGIN;')

    // Known-negative, in-band: the tuple carries no xmax before the call.
    expect(await lockedFlag(a)).toBe('false')

    const call = await a.send(`SELECT recompute_user_tier('${PROBE}');`)
    expect(call.stderr).not.toMatch(/ERROR/)
    expect(call.stdout).toBe('community')

    // Attribution: the function's own UPDATE must NOT have fired, so the only
    // statement that can have set xmax is the lock.
    const tierInTxn = (
      await a.send(`SELECT tier FROM profiles WHERE id = '${PROBE}';`)
    ).stdout.trim()
    expect(
      tierInTxn,
      "the probe user's tier changed, so the function's UPDATE fired and xmax is no longer " +
        'attributable to the lock alone — re-pick the probe row'
    ).toBe('community')

    // THE ASSERTION. false here means the statement is in the source but never
    // ran: an IF FALSE guard, a commented-out copy, or a deleted one.
    expect(
      await lockedFlag(a),
      'recompute_user_tier() did not acquire a row lock on the profiles row. The statement may ' +
        "be present in the source but unreachable — which the migration's textual smoke cannot " +
        'detect. This is the behavioural guarantee for SMI-6656.'
    ).toBe('true')

    await a.send('ROLLBACK;')
  }, 60_000)

  // ==========================================================================
  // REQUIREMENT 5 -- the lock is not STRONGER than NO KEY UPDATE.
  //
  // Scope, stated so this is not read as more than it is: this arm detects only
  // a WIDENING. It would pass if the lock were absent entirely, because absent
  // and NO KEY are indistinguishable to FK-child traffic -- neither blocks it.
  // Every weakening, SKIP LOCKED included, is test 6's side of the bracket.
  //
  // The deleted textual smoke asserted THREE things about this lock, not one.
  // Two of them survive in test 1: SKIP LOCKED leaves the body running
  // unlocked, so the lost update reproduces, and NOWAIT surfaces 55P03 on
  // session A's stderr. The third -- that the lock is not WIDENED to
  // FOR UPDATE -- was covered by nothing, because every other test here passes
  // under a widening: FOR UPDATE blocks identically in test 1, sets xmax
  // identically in test 4, and preserves ascending order in test 2.
  //
  // FOR UPDATE is KEY strength, so it conflicts with the FOR KEY SHARE that
  // Postgres takes on a parent row for every FK-child INSERT. Twelve columns
  // reference profiles(id), so a widening would block device-login approval
  // and licence issuance for the length of a roster recompute -- traffic that
  // never blocked before SMI-6656. The fix was downgraded from FOR UPDATE
  // mid-review for exactly that reason; this arm is what pins the downgrade.
  //
  // Both sibling functions that lock profiles rows already have this arm
  // (purge-departed-toctou.pg.test.ts, inventory-device-lock.pg.test.ts), and
  // neither substitutes for it: MEASURED, purge-departed-toctou.pg.test.ts is
  // 11/11 green both pristine and with THIS function's lock widened. SMI-6857.
  // ==========================================================================
  it('is not widened to KEY strength: ordinary FK traffic on profiles(id) does not block it', async () => {
    // ON DELETE CASCADE so that a failure mid-test cannot outlive it: without
    // it, a surviving child row makes the next test's `DELETE FROM profiles`
    // fixture reset fail, and the real failure is then buried under unrelated ones.
    await ctl.send(
      `DROP TABLE IF EXISTS smi6857_fk_child;
       CREATE TABLE smi6857_fk_child (
         id    SERIAL PRIMARY KEY,
         owner UUID REFERENCES profiles(id) ON DELETE CASCADE
       );`
    )

    // B holds an open FK-child INSERT: FOR KEY SHARE on TEST_USER's profiles row.
    await b.send('BEGIN;')
    const ins = await b.send(`INSERT INTO smi6857_fk_child (owner) VALUES ('${TEST_USER}');`)
    // No stderr interpolated into any message in this arm or test 6: vitest's
    // retry condition (vitest.preset.ts) matches /timeout/i against the whole
    // assertion message, so embedding Postgres's own error text can annotate a
    // deterministic logic regression as infra flake. vitest prints the received
    // value anyway.
    expect(ins.stderr, 'the FK-child INSERT itself failed').not.toMatch(/ERROR/)

    // KNOWN-POSITIVE for the instrument: prove that FK traffic really is holding
    // a lock which KEY strength conflicts with. Without this, a test that
    // contended nothing would pass whatever strength the function uses.
    const keyStrength = await a.send(
      `SELECT tier FROM profiles WHERE id = '${TEST_USER}' FOR UPDATE NOWAIT;`
    )
    expect(
      keyStrength.stderr,
      'FOR UPDATE NOWAIT was not refused, so session B is not holding the FOR KEY SHARE this ' +
        'test depends on -- the assertion below would then pass for the wrong reason'
    ).toMatch(/could not obtain lock on row/i)

    // KNOWN-NEGATIVE: NO KEY strength is admitted through that same traffic.
    // Asserted with a message and a POSITIVE stdout check, because a bare
    // `not.toMatch` passes on any unrelated failure that leaves stderr without
    // that phrase -- including one that returned no row at all.
    const noKey = await a.send(
      `SELECT tier FROM profiles WHERE id = '${TEST_USER}' FOR NO KEY UPDATE NOWAIT;`
    )
    expect(
      noKey.stderr,
      'FOR NO KEY UPDATE NOWAIT was refused through FK-child traffic, contradicting the measured ' +
        'conflict matrix -- the engine or the harness is not behaving as this arm assumes'
    ).not.toMatch(/could not obtain lock/i)
    expect(noKey.stdout, 'the known-negative probe returned no row, so it proved nothing').toBe(
      'community'
    )

    // THE ASSERTION. Bounded, so a widened lock fails in seconds with a named
    // error rather than hanging to the test timeout -- a hang is
    // indistinguishable from an unrelated stall, which is the failure mode this
    // suite exists to avoid.
    await a.send("SET lock_timeout = '3s';")
    const call = await a.send(`SELECT recompute_user_tier('${TEST_USER}');`)
    // Reduced to a boolean BEFORE asserting. Matching on `call.stderr` directly
    // puts Postgres's own "canceling statement due to lock timeout" text into the
    // assertion error, which matches vitest.preset.ts's retry condition (/timeout/i)
    // and gets a deterministic logic regression annotated as infra flake and run
    // twice. That preset's comment claims assertion failures never match it; an
    // assertion that quotes a timeout error is how that stops being true.
    const blockedOnLock = /lock timeout/i.test(call.stderr)
    expect(
      blockedOnLock,
      'recompute_user_tier() blocked on ordinary FK-child traffic, so its row lock was widened ' +
        'to FOR UPDATE. Twelve columns reference profiles(id): this stalls device-login approval ' +
        'and licence issuance for the length of a recompute, traffic that never blocked before ' +
        'SMI-6656. (FOR SHARE is NOT this failure -- it does not conflict with FOR KEY SHARE, ' +
        'so it passes this arm; test 6 is what catches it.)'
    ).toBe(false)
    expect(call.stderr).not.toMatch(/ERROR/)
    expect(call.stdout).toBe('individual')

    await a.send('RESET lock_timeout;')
    await b.send('ROLLBACK;')
    await ctl.send('DROP TABLE IF EXISTS smi6857_fk_child;')
  }, 60_000)

  // ==========================================================================
  // REQUIREMENT 6 -- the lock is not WEAKER than NO KEY UPDATE.
  //
  // Tests 5 and 6 are a BRACKETING PAIR, and that is the point of having both:
  // 5 says the lock is at MOST NO KEY UPDATE strength, 6 says at LEAST. Together
  // they constrain it from both directions FOR THE ROWS THEY EXERCISE, which is
  // what the deleted textual smoke was doing and what kept rotting in prose.
  // Neither is redundant: a FOR UPDATE widening PASSES test 6 (it still waits),
  // and every weakening PASSES test 5 (nothing weaker blocks on FK traffic).
  // Delete either one and a whole side of the bracket goes with it.
  //
  // Why FOR SHARE needs its own coverage: it is not KEY strength, so it does not
  // conflict with FK-child FOR KEY SHARE and test 5 structurally cannot see it --
  // yet it is genuinely broken. Two sessions can BOTH hold FOR SHARE on one row,
  // so it provides zero mutual exclusion between two recomputes, which is the
  // entire SMI-6656 fix; they then deadlock upgrading. Before SMI-6857 only
  // test 2 caught it, and only in roughly 10 runs out of 12, because that arm is
  // timing-dependent by its own design. Roughly one run in six shipped green.
  //
  // MEASURED conflict matrix (postgres:17.6, with a no-holder known-negative
  // where everything proceeds and a held-FOR UPDATE known-positive where
  // everything conflicts, so the probe discriminates in both directions):
  //   held FOR SHARE vs FOR NO KEY UPDATE -> CONFLICT  (a correct body WAITS)
  //   held FOR SHARE vs FOR SHARE         -> proceeds  (mutation detected here)
  //   held FOR SHARE vs FOR KEY SHARE     -> proceeds  (mutation detected here)
  //
  // So this arm catches the whole too-weak family in one assertion: absent,
  // FOR KEY SHARE, FOR SHARE, SKIP LOCKED (skips the row, never waits) and
  // NOWAIT (fails instantly with 55P03, not a lock timeout).
  //
  // WHAT NEITHER ARM CATCHES, recorded rather than left for the next reader to
  // discover: a lock taken inside a subtransaction that is then rolled back. All
  // arms pass, because the caller still waits to acquire it, and `xmax` still
  // reads set to the calling session even though the lock has been released.
  // ==========================================================================
  it('is not weakened below NO KEY strength: a held FOR SHARE must block it', async () => {
    // ATTRIBUTION, and this arm is USELESS without it. A first version of this
    // test used TEST_USER and passed under every weakening. Measured cause: the
    // function does not stop at its lock. The trailing
    // `UPDATE profiles SET tier ... WHERE tier IS DISTINCT FROM v_new_tier`
    // takes NO KEY UPDATE strength itself, which conflicts with a held FOR SHARE
    // on its own -- so the call timed out whatever the lock statement said, and
    // the assertion could not tell the two apart. Only NOWAIT failed, because it
    // errors instantly before reaching the UPDATE.
    //
    // The fix is test 4's attribution trick: use a row whose tier is ALREADY the
    // value recompute computes, so the UPDATE's predicate excludes it, no row is
    // a candidate, and no lock is taken there (MEASURED: that UPDATE returns in
    // ~23ms against a held FOR SHARE and leaves xmax = 0). The lock statement is
    // then the only thing in the function that can block, and the assertion at the
    // END of this arm is what keeps that true rather than assumed.
    const PROBE = '66560000-0000-0000-0000-0000000000fe'
    await ctl.send(
      `INSERT INTO auth.users (id, email) VALUES ('${PROBE}', 'smi6857-probe@example.test')
         ON CONFLICT DO NOTHING;
       INSERT INTO profiles (id, email, tier, role)
         VALUES ('${PROBE}', 'smi6857-probe@example.test', 'community', 'user')
         ON CONFLICT DO NOTHING;`
    )

    await b.send('BEGIN;')
    const held = await b.send(`SELECT tier FROM profiles WHERE id = '${PROBE}' FOR SHARE;`)
    expect(held.stderr, 'session B could not take FOR SHARE').not.toMatch(/ERROR/)
    expect(held.stdout, 'session B took no row, so it is holding nothing').toBe('community')

    // KNOWN-POSITIVE: the FOR SHARE is really held AND really does conflict with
    // the strength the fix requires. If this probe proceeds, the assertion below
    // cannot distinguish a correct lock from a weakened one.
    const conflicts = await ctl.send(
      `SELECT tier FROM profiles WHERE id = '${PROBE}' FOR NO KEY UPDATE NOWAIT;`
    )
    expect(
      conflicts.stderr,
      'a held FOR SHARE did not refuse FOR NO KEY UPDATE NOWAIT, so this arm proves nothing'
    ).toMatch(/could not obtain lock on row/i)

    // OBSERVE the wait on A's own backend instead of letting a lock_timeout fire.
    // Same shape as test 1, and better here for three measured reasons: no error
    // is produced at all, so no assertion message can carry Postgres's timeout
    // text into vitest's retry condition; it is positive evidence that A waited
    // on a *Lock*, not an inference from an error string; and it costs ~200ms
    // rather than waiting out a timeout on every run, forever. Scoped to A's own
    // PID so an unrelated waiter on a shared test database cannot satisfy it.
    const aPid = (await a.send('SELECT pg_backend_pid();')).stdout.trim()
    expect(aPid).toMatch(/^\d+$/)

    const callA = a.fire(`SELECT recompute_user_tier('${PROBE}');`)

    const aIsLockWaiting = async (): Promise<number> => {
      const r = await ctl.send(
        `SELECT count(*) FROM pg_stat_activity
          WHERE pid = ${aPid} AND state = 'active' AND wait_event_type = 'Lock';`
      )
      return Number.parseInt(r.stdout.trim(), 10)
    }
    // 40 iterations, matching test 1's convention rather than a shorter window of
    // its own: the bound is not a deterministic guarantee, so the only thing a
    // tighter window buys is a false failure on a slow machine.
    //
    // What this poll does NOT distinguish: it matches on `wait_event_type` alone,
    // not on the blocked relation, tuple or blocker PID. It is sound for the body
    // shipped today, where the lock statement is the only thing that can wait on
    // this row. A future body that waits on some OTHER lock would satisfy it.
    let sawBlocked = false
    for (let i = 0; i < 40 && !sawBlocked; i++) {
      if ((await aIsLockWaiting()) >= 1) sawBlocked = true
      else await sleep(250)
    }

    // THE ASSERTION.
    expect(
      sawBlocked,
      'recompute_user_tier() never waited on a held FOR SHARE, so its row lock is weaker than ' +
        'FOR NO KEY UPDATE -- FOR SHARE, FOR KEY SHARE, SKIP LOCKED, NOWAIT, or absent. Two ' +
        'sessions can then both hold this row and neither excludes the other, which is the ' +
        'entire SMI-6656 fix.'
    ).toBe(true)

    await b.send('ROLLBACK;')
    const after = await callA
    expect(
      after.stderr,
      "the call failed once B released, so the wait above was not B's lock"
    ).not.toMatch(/ERROR/)

    // ATTRIBUTION, and THIS is the assertion that carries it -- not a tier re-read.
    // A first version re-read the tier here and called that the attribution check.
    // It could not fail: a lock_timeout aborts the whole statement, so a fired
    // UPDATE is rolled back and the tier always reads unchanged. MEASURED, with the
    // lock deleted on a TEST_USER-shaped row: that re-read PASSED while this
    // assertion FAILED with 'individual'. The credit was on the inert assertion.
    //
    // What this proves: the tier A computed equals the tier the row already had, so
    // the function's own `UPDATE ... WHERE tier IS DISTINCT FROM v_new_tier`
    // predicate was FALSE, no row was a candidate, and that UPDATE took no lock.
    // So the wait observed above cannot have been the UPDATE.
    expect(
      after.stdout,
      'the probe user computed a different tier, so the UPDATE predicate was TRUE and the wait ' +
        'above is not attributable to the lock alone -- re-pick the probe row'
    ).toBe('community')
  }, 60_000)
})
