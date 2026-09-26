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
  // Why this test exists, and why it is here rather than in the migration's
  // own smoke block. The migration asserts the locking statement's SHAPE by
  // reading pg_proc.prosrc. Text presence is not evidence of reachability, and
  // no pattern can make it so: `IF FALSE THEN <the exact statement> END IF;`
  // satisfies any textual assertion and acquires nothing. Measured -- it
  // passed a stricter earlier version of that block, as did a /* */-commented
  // copy and a lowercase copy moved after the read. A cross-family reviewer
  // named all three; the migration's smoke now says plainly that it proves
  // shape only, and this is the test that proves the behaviour.
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
})
