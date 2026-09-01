/**
 * SMI-6321 regression suite — `purge_departed_team_members_inventory()`'s TOCTOU race,
 * exercised with TWO REAL, SIMULTANEOUS Postgres sessions.
 *
 * The bug: the sweep decided whether to destroy a departed member's device inventory
 * from an UNLOCKED read of `profiles.tier`, then acted on that read in later
 * statements. A re-authentication committing inside that window was invisible to the
 * decision and fully visible to everyone else, so the sweep deleted the entire
 * inventory of a member who was, by the time the DELETE ran, fully entitled again.
 * Confirmed live 15/20 in the SMI-6200 cross-wave UAT (SMI-6312 scenario R4).
 *
 * Every test here drives a controlled interleaving between two independent psql
 * sessions. A sequential simulation would prove nothing: the whole property under test
 * is what one session can observe while another is mid-transaction, and to a lone
 * session a locked read and an unlocked read are indistinguishable.
 *
 * Harness, connection env vars and the CI-coverage gap: see
 * ./purge-departed-toctou.test-helpers.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  PsqlSession,
  requireTestConn,
  noLiveTestPg,
  schemaSql,
  fixtureSql,
  TEST_USER,
  TEST_TEAM,
  type TestConn,
} from './purge-departed-toctou.test-helpers.ts'

let conn: TestConn
let ctl: PsqlSession // control/assertion session
let a: PsqlSession // "A" — the sweep
let b: PsqlSession // "B" — the concurrent re-authentication

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function deviceCount(): Promise<number> {
  const { stdout } = await ctl.send(
    `SELECT count(*) FROM user_devices WHERE user_id = '${TEST_USER}';`
  )
  return Number(stdout)
}

async function scheduleState(): Promise<'pending' | 'purged' | 'cancelled'> {
  const { stdout } = await ctl.send(
    `SELECT CASE WHEN purged_at IS NOT NULL THEN 'purged'
                 WHEN cancelled_reason IS NOT NULL THEN 'cancelled'
                 ELSE 'pending' END
       FROM team_member_inventory_purge_schedule WHERE user_id = '${TEST_USER}' LIMIT 1;`
  )
  return stdout as 'pending' | 'purged' | 'cancelled'
}

async function tier(): Promise<string> {
  const { stdout } = await ctl.send(`SELECT tier FROM profiles WHERE id = '${TEST_USER}';`)
  return stdout
}

describe.skipIf(noLiveTestPg)('SMI-6321 — departure-purge TOCTOU, two live sessions', () => {
  beforeAll(async () => {
    conn = requireTestConn()
    ctl = new PsqlSession(conn, 'ctl')
    const { stderr } = await ctl.send(schemaSql(), 60_000)
    // A failed schema build must be loud: every assertion below would otherwise pass
    // or fail for the wrong reason.
    expect(stderr, `schema build failed:\n${stderr}`).not.toMatch(/ERROR/)
  }, 90_000)

  afterAll(async () => {
    await Promise.all([ctl?.close(), a?.close(), b?.close()])
  })

  beforeEach(async () => {
    await a?.close()
    await b?.close()
    a = new PsqlSession(conn, 'A-sweep')
    b = new PsqlSession(conn, 'B-reauth')
    await ctl.send(fixtureSql())
  })

  // ==========================================================================
  // REQUIREMENT 1 — the race itself.
  // ==========================================================================
  it('does NOT purge when a concurrent re-authentication restores entitlement inside the sweep window', async () => {
    // B opens a transaction and performs the real restore write (team_members
    // re-provision + recompute_user_tier), taking — and HOLDING — the exclusive row
    // lock on this member's profiles row. This is exactly the state a login is in
    // during the milliseconds before it commits.
    await b.send('BEGIN;')
    const reauth = await b.send(`SELECT test_sso_reauth('${TEST_USER}', '${TEST_TEAM}');`)
    expect(reauth.stderr).not.toMatch(/ERROR/)
    expect(reauth.stdout).toBe('enterprise')

    // Sanity: the restore is NOT yet visible to anyone else. Pre-fix, this stale
    // 'community' is precisely the value the sweep read and destroyed data on.
    expect(await tier()).toBe('community')

    // A runs the sweep concurrently, without awaiting.
    const sweep = a.fire('SELECT purge_departed_team_members_inventory();')
    await sleep(500)

    // B's restore commits — inside the window the old code left open between its tier
    // read and its DELETE.
    await b.send('COMMIT;')
    const sweepResult = await sweep

    expect(sweepResult.stderr).not.toMatch(/deadlock/i)
    // THE REGRESSION ASSERTION. Pre-fix this returned 1 and the device was gone.
    expect(sweepResult.stdout.trim().split('\n').pop()).toBe('0')
    expect(await deviceCount()).toBe(1)
    expect(await scheduleState()).not.toBe('purged')
    expect(await tier()).toBe('enterprise')
  }, 60_000)

  it('leaves the schedule row resolvable — a later sweep cancels it once the restore has settled', async () => {
    await b.send('BEGIN;')
    await b.send(`SELECT test_sso_reauth('${TEST_USER}', '${TEST_TEAM}');`)
    const sweep = a.fire('SELECT purge_departed_team_members_inventory();')
    await sleep(500)
    await b.send('COMMIT;')
    await sweep

    // Second sweep, no contention: the member is now visibly enterprise, so the
    // pending row is CANCELLED rather than left to accumulate forever.
    const second = await a.send('SELECT purge_departed_team_members_inventory();')
    expect(second.stdout.trim().split('\n').pop()).toBe('0')
    expect(await scheduleState()).toBe('cancelled')
    expect(await deviceCount()).toBe(1)
  }, 60_000)

  // ==========================================================================
  // REQUIREMENT 2 — no regression on the happy path.
  // ==========================================================================
  it('still purges a genuinely departed, non-re-entitled member (no concurrency)', async () => {
    const sweep = await a.send('SELECT purge_departed_team_members_inventory();')
    expect(sweep.stderr).not.toMatch(/ERROR/)
    expect(sweep.stdout.trim().split('\n').pop()).toBe('1')
    expect(await deviceCount()).toBe(0)
    expect(await scheduleState()).toBe('purged')
  }, 60_000)

  it('still purges when the re-authentication arrives AFTER the sweep has taken its locks', async () => {
    // The mirror interleaving. The sweep holds profiles(member) from its tier read
    // through commit; a login arriving mid-sweep must simply wait, and the sweep's
    // decision — taken when the member was genuinely un-entitled — must stand. This is
    // a legitimate serialization, not the race, and it must NOT deadlock.
    await a.send('BEGIN;')
    const sweep = await a.send('SELECT purge_departed_team_members_inventory();')
    expect(sweep.stdout.trim().split('\n').pop()).toBe('1')

    const reauth = b.fire(`SELECT test_sso_reauth('${TEST_USER}', '${TEST_TEAM}');`)
    await sleep(500)
    await a.send('COMMIT;')
    const reauthResult = await reauth

    expect(reauthResult.stderr).not.toMatch(/deadlock|ERROR/i)
    expect(reauthResult.stdout).toBe('enterprise')
    expect(await scheduleState()).toBe('purged')
    expect(await deviceCount()).toBe(0)
  }, 60_000)

  it('still cancels for a member who was already visibly entitled before the sweep started', async () => {
    await ctl.send(`SELECT test_sso_reauth('${TEST_USER}', '${TEST_TEAM}');`)
    expect(await tier()).toBe('enterprise')
    const sweep = await a.send('SELECT purge_departed_team_members_inventory();')
    expect(sweep.stdout.trim().split('\n').pop()).toBe('0')
    expect(await scheduleState()).toBe('cancelled')
    expect(await deviceCount()).toBe(1)
  }, 60_000)

  // ==========================================================================
  // Deadlock analysis, asserted rather than argued.
  // ==========================================================================
  it('does not deadlock against the profiles-then-schedule lock order (SMI-6318 upsert shape)', async () => {
    // remove_team_member() and expire_stale_sso_members() take the profiles row lock
    // FIRST (via recompute_user_tier) and the pending schedule row SECOND — the exact
    // opposite of the sweep's schedule-then-profiles order. Once SMI-6318 converts
    // both call sites to `INSERT ... ON CONFLICT (user_id) WHERE pending DO UPDATE`,
    // that second lock lands on the very row the sweep is holding. With a plain
    // `FOR UPDATE` this interleaving produces `deadlock detected`, and the sweep's
    // function-level EXCEPTION WHEN OTHERS swallows it into a silent no-op sweep.
    // `FOR UPDATE NOWAIT` removes the cycle structurally: the sweep never waits.
    await ctl.send(
      `INSERT INTO team_members (id, team_id, user_id, role)
       VALUES ('smi6321-dl', '${TEST_TEAM}', '${TEST_USER}', 'member') ON CONFLICT DO NOTHING;`
    )

    await b.send('BEGIN;')
    await b.send(`SELECT recompute_user_tier('${TEST_USER}');`) // holds profiles(member)

    const sweep = a.fire('SELECT purge_departed_team_members_inventory();')
    await sleep(500)

    // B now reaches for the pending schedule row the sweep may be holding.
    const upsert = await b.send(
      `UPDATE team_member_inventory_purge_schedule
          SET scheduled_purge_at = now() + INTERVAL '30 days'
        WHERE user_id = '${TEST_USER}' AND purged_at IS NULL AND cancelled_reason IS NULL;`
    )
    await b.send('COMMIT;')
    const sweepResult = await sweep

    expect(sweepResult.stderr).not.toMatch(/deadlock/i)
    expect(upsert.stderr).not.toMatch(/deadlock/i)
    // And it still failed CLOSED: contention never becomes a purge.
    expect(await deviceCount()).toBe(1)
    expect(await scheduleState()).not.toBe('purged')
  }, 60_000)

  // ==========================================================================
  // Fail-closed branches.
  // ==========================================================================
  it('skips (does not purge) a schedule row whose profiles row does not exist', async () => {
    // Pre-fix this fell straight through to the DELETE: v_tier stayed NULL,
    // `NULL IN ('team','enterprise')` is NULL, the IF never fired. A row that cannot
    // be locked cannot be serialized against, so it must not be acted on.
    await ctl.send(fixtureSql({ withProfile: false }))
    const sweep = await a.send('SELECT purge_departed_team_members_inventory();')
    expect(sweep.stdout.trim().split('\n').pop()).toBe('0')
    expect(await deviceCount()).toBe(1)
    expect(await scheduleState()).toBe('pending')
  }, 60_000)

  it('reads the tier under a lock that recompute_user_tier() genuinely contends for', async () => {
    // The premise the whole fix rests on, asserted directly: recompute_user_tier()'s
    // UPDATE takes a conflicting row lock, so the sweep's locking read really is
    // serialized against it — while the UNLOCKED read the shipped bug performed
    // cheerfully returns the pre-restore value at the same instant.
    await ctl.send(
      `INSERT INTO team_members (id, team_id, user_id, role)
       VALUES ('smi6321-lock', '${TEST_TEAM}', '${TEST_USER}', 'member') ON CONFLICT DO NOTHING;`
    )
    await b.send('BEGIN;')
    await b.send(`SELECT recompute_user_tier('${TEST_USER}');`)

    // The exact lock the deployed function takes must be refused here.
    const locked = await a.send(
      `SELECT tier FROM profiles WHERE id = '${TEST_USER}' FOR NO KEY UPDATE NOWAIT;`
    )
    expect(locked.stderr).toMatch(/could not obtain lock on row/i)

    const unlocked = await a.send(`SELECT tier FROM profiles WHERE id = '${TEST_USER}';`)
    expect(unlocked.stdout).toBe('community') // the stale value the bug acted on

    await b.send('COMMIT;')
    expect(await tier()).toBe('enterprise')
  }, 60_000)

  it('is NOT blocked by ordinary foreign-key traffic on profiles(id) — the reason for NO KEY UPDATE', async () => {
    // `FOR UPDATE` is key-strength and conflicts with the `FOR KEY SHARE` every FK
    // child insert takes on its parent row. Eleven columns in the real schema reference
    // profiles(id), so a key-strength lock here would make the sweep skip members
    // because someone created an API key or an invitation — nothing to do with
    // entitlement. This test pins the distinction so a future "tighten the lock" edit
    // fails loudly.
    await ctl.send(
      `DROP TABLE IF EXISTS smi6321_fk_child;
       CREATE TABLE smi6321_fk_child (id SERIAL PRIMARY KEY, owner UUID REFERENCES profiles(id));`
    )
    await b.send('BEGIN;')
    await b.send(`INSERT INTO smi6321_fk_child (owner) VALUES ('${TEST_USER}');`)

    const keyStrength = await a.send(
      `SELECT tier FROM profiles WHERE id = '${TEST_USER}' FOR UPDATE NOWAIT;`
    )
    expect(keyStrength.stderr).toMatch(/could not obtain lock on row/i)

    const noKey = await a.send(
      `SELECT tier FROM profiles WHERE id = '${TEST_USER}' FOR NO KEY UPDATE NOWAIT;`
    )
    expect(noKey.stderr).not.toMatch(/could not obtain lock/i)
    expect(noKey.stdout).toBe('community')

    // And the sweep itself proceeds normally through that FK traffic.
    const sweep = await a.send('SELECT purge_departed_team_members_inventory();')
    expect(sweep.stdout.trim().split('\n').pop()).toBe('1')
    expect(await deviceCount()).toBe(0)

    await b.send('COMMIT;')
    await ctl.send('DROP TABLE IF EXISTS smi6321_fk_child;')
  }, 60_000)

  it('one contended row does not abort the sweep for the rest of the queue', async () => {
    // The stated purpose of processing rows independently. A single locked member must
    // cost exactly one skipped row, not the whole night's retention work.
    const u2 = '63210000-0000-0000-0000-0000000000c2'
    const u3 = '63210000-0000-0000-0000-0000000000c3'
    await ctl.send(
      `INSERT INTO auth.users (id, email) VALUES ('${u2}','c2@x.test'),('${u3}','c3@x.test');
       INSERT INTO profiles (id, email, tier, role)
         VALUES ('${u2}','c2@x.test','community','user'),('${u3}','c3@x.test','community','user');
       INSERT INTO user_devices (device_id, user_id, label, last_seen_at)
         VALUES ('6321cccc-0000-0000-0000-0000000000c2','${u2}','c2',now()),
                ('6321cccc-0000-0000-0000-0000000000c3','${u3}','c3',now());
       INSERT INTO team_member_inventory_purge_schedule (user_id, departed_team_id, scheduled_purge_at)
         VALUES ('${u2}',NULL,now()-INTERVAL '1 day'),('${u3}',NULL,now()-INTERVAL '1 day');`
    )

    // Hold ONLY the first member's profiles row.
    await b.send('BEGIN;')
    await b.send(`UPDATE profiles SET updated_at = now() WHERE id = '${TEST_USER}';`)

    const sweep = await a.send('SELECT purge_departed_team_members_inventory();')
    await b.send('COMMIT;')

    // Two of the three purged; the contended one skipped and left pending.
    expect(sweep.stdout.trim().split('\n').pop()).toBe('2')
    expect(sweep.stderr).toMatch(/SKIPPED/i)
    expect(await deviceCount()).toBe(1) // contended member's device survives
    expect(await scheduleState()).toBe('pending')

    const others = await ctl.send(
      `SELECT count(*) FROM user_devices WHERE user_id IN ('${u2}','${u3}');`
    )
    expect(others.stdout).toBe('0') // the rest of the queue completed
  }, 60_000)

  it('writes a queryable skip audit row, not just a server-log warning', async () => {
    // cron.job_run_details records status and return value, not NOTICEs — so without
    // this row a silently-deferring retention purge would be unobservable.
    await b.send('BEGIN;')
    await b.send(`UPDATE profiles SET updated_at = now() WHERE id = '${TEST_USER}';`)
    await a.send('SELECT purge_departed_team_members_inventory();')
    await b.send('COMMIT;')

    const audit = await ctl.send(
      `SELECT metadata->>'reason' FROM audit_logs
        WHERE event_type = 'inventory:team_departure_purge.skipped'
          AND metadata->>'user_id' = '${TEST_USER}';`
    )
    expect(audit.stdout).toBe('lock_unavailable')
  }, 60_000)
})
