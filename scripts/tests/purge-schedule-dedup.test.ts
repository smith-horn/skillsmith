/**
 * SMI-6318: behavioural regression suite for "one PENDING inventory-purge row per
 * user, governed by the MOST RECENT departure".
 *
 * @see supabase/migrations/20260831130000_purge_schedule_pending_dedup.sql
 * @see supabase/migrations/20260707000004_team_member_departure_purge.sql
 * @see supabase/migrations/20260829230000_sso_member_lifecycle.sql
 *
 * Runs the REAL shipped functions against a real Postgres (see
 * `purge-schedule-dedup.test-helpers.ts` for the harness and how to stand the
 * instance up). Every case skips cleanly when no live test Postgres is
 * configured, matching the sibling SMI-5879/SMI-5898 suites.
 *
 * The FIRST case is a negative control that reproduces SMI-6318 with the
 * pre-fix code. Without it, everything below could pass against a schema where
 * departures had simply stopped scheduling purges at all.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll } from 'vitest'
import {
  noLiveTestPg,
  dedupMigrationLocked,
  dedupMigrationPath,
  resetToPreFixState,
  applyDedupFix,
  seedTeams,
  joinTeam,
  departViaRpc,
  departViaSweep,
  pendingRows,
  rowCensus,
  backdatePending,
  daysUntil,
  DEPARTER_ID,
  readMigration,
} from './purge-schedule-dedup.test-helpers.ts'
import { runPsql, queryScalar, type PgConnParams } from '../indexer/smi5879-census.pg.ts'

const TIMEOUT_MS = 60_000

/**
 * `post-merge-verify.yml` runs `scripts/tests/**` on a DELIBERATELY git-crypt-locked
 * checkout (SMI-4221/SMI-5984), where `supabase/migrations/**` is ciphertext and nothing
 * below can read the migration. Content assertions skip there; the filename-existence
 * check stays on, since filenames survive encryption. A lock detected WITHOUT that
 * workflow's own env var is not handled here at all — `readMigration()` throws for it, so
 * a failed unlock in any other lane fails loudly instead of silently degrading.
 */
const MIGRATION_LOCKED = dedupMigrationLocked()

/** Fresh database seeded to the pre-fix state; `applyFix` then applies SMI-6318. */
async function setup(applyFix: boolean): Promise<{ conn: PgConnParams; stderr: string }> {
  const conn = await resetToPreFixState()
  await seedTeams(conn)
  const stderr = applyFix ? await applyDedupFix(conn) : ''
  return { conn, stderr }
}

describe.skipIf(noLiveTestPg || MIGRATION_LOCKED)(
  'SMI-6318 purge-schedule pending de-duplication',
  () => {
    describe('negative control — the bug is real in the pre-fix code', () => {
      it(
        'leaves TWO pending rows after departure -> rejoin -> departure',
        async () => {
          const { conn } = await setup(false)

          const first = await joinTeam(conn, 't-plain')
          await departViaRpc(conn, first)
          await backdatePending(conn, 5)

          const second = await joinTeam(conn, 't-plain')
          await departViaRpc(conn, second)

          const rows = await pendingRows(conn)
          // This is SMI-6318 itself. If this assertion ever flips to 1 without the
          // fix applied, the bug was fixed somewhere else and this suite's
          // post-fix cases have stopped proving anything.
          expect(rows).toHaveLength(2)

          // And the damage: the OLDER row's timer is the one the sweep would act
          // on first, ~5 days ahead of the window the second departure earned.
          const oldest = rows[rows.length - 1]
          await expect(daysUntil(conn, oldest.scheduledPurgeAt)).resolves.toBeLessThan(26)
        },
        TIMEOUT_MS
      )
    })

    describe('the one-time backfill', () => {
      it(
        'collapses pre-existing duplicates to the most recent departure without destroying history',
        async () => {
          const { conn } = await setup(false)

          const first = await joinTeam(conn, 't-plain')
          await departViaRpc(conn, first)
          await backdatePending(conn, 5)
          const second = await joinTeam(conn, 't-sso')
          await departViaRpc(conn, second)
          expect(await pendingRows(conn)).toHaveLength(2)

          await applyDedupFix(conn)

          const rows = await pendingRows(conn)
          expect(rows).toHaveLength(1)
          // The survivor is the LATER window, and it is the second departure's team.
          expect(rows[0].departedTeamId).toBe('t-sso')
          await expect(daysUntil(conn, rows[0].scheduledPurgeAt)).resolves.toBeGreaterThan(29.9)

          // The superseded row is CANCELLED, not deleted — the departure history survives
          // under a reason distinguishable from a genuine sweep cancellation.
          const census = await rowCensus(conn)
          expect(census.total).toBe(2)
          expect(census.pending).toBe(1)
          expect(census.reasons).toEqual(['superseded_by_later_departure'])
        },
        TIMEOUT_MS
      )
    })

    describe('requirement 1 — departure, rejoin, departure', () => {
      it(
        "keeps exactly ONE pending row whose window is the SECOND departure's own 30 days",
        async () => {
          const { conn } = await setup(true)

          const first = await joinTeam(conn, 't-plain')
          await departViaRpc(conn, first)
          expect(await pendingRows(conn)).toHaveLength(1)

          // Simulate the first departure having happened ~5 days ago. Without this
          // backdating, "extended" and "not extended" would be indistinguishable.
          await backdatePending(conn, 5)
          const beforeSecond = (await pendingRows(conn))[0]
          expect(await daysUntil(conn, beforeSecond.scheduledPurgeAt)).toBeLessThan(25.1)

          const second = await joinTeam(conn, 't-plain')
          await departViaRpc(conn, second)

          const rows = await pendingRows(conn)
          expect(rows).toHaveLength(1)
          // A full fresh 30-day window from the SECOND departure — not the ~25 days
          // that remained of the first.
          const remaining = await daysUntil(conn, rows[0].scheduledPurgeAt)
          expect(remaining).toBeGreaterThan(29.9)
          expect(remaining).toBeLessThan(30.1)
        },
        TIMEOUT_MS
      )
    })

    describe('requirement 2 — cross-path interleaving', () => {
      it(
        'extends rather than duplicates when the RPC schedules first and the sweep second',
        async () => {
          const { conn } = await setup(true)

          const plain = await joinTeam(conn, 't-plain')
          await joinTeam(conn, 't-sso', { sso: true, staleDays: 30 })
          await departViaRpc(conn, plain)
          await backdatePending(conn, 5)

          expect(await departViaSweep(conn)).toBeGreaterThanOrEqual(1)

          const rows = await pendingRows(conn)
          expect(rows).toHaveLength(1)
          // Re-attributed to the departure that now governs the window.
          expect(rows[0].departedTeamId).toBe('t-sso')
          expect(await daysUntil(conn, rows[0].scheduledPurgeAt)).toBeGreaterThan(29.9)
        },
        TIMEOUT_MS
      )

      it(
        'extends rather than duplicates when the sweep schedules first and the RPC second',
        async () => {
          const { conn } = await setup(true)

          await joinTeam(conn, 't-sso', { sso: true, staleDays: 30 })
          const plain = await joinTeam(conn, 't-plain')

          expect(await departViaSweep(conn)).toBeGreaterThanOrEqual(1)
          expect(await pendingRows(conn)).toHaveLength(1)
          await backdatePending(conn, 5)

          await departViaRpc(conn, plain)

          const rows = await pendingRows(conn)
          expect(rows).toHaveLength(1)
          expect(rows[0].departedTeamId).toBe('t-plain')
          expect(await daysUntil(conn, rows[0].scheduledPurgeAt)).toBeGreaterThan(29.9)
        },
        TIMEOUT_MS
      )
    })

    describe('one sweep run, one user, two teams', () => {
      it(
        'issues two upserts in the SAME transaction and still lands one pending row',
        async () => {
          const { conn } = await setup(true)

          // The upsert cannot see a row inserted by its OWN command, but these are two
          // separate statements in one transaction, so the second sees the first. If that
          // assumption were wrong the second would raise 23505 into the sweep's per-row
          // handler and silently lose that member's retention window.
          await joinTeam(conn, 't-sso', { sso: true, staleDays: 30 })
          await joinTeam(conn, 't-sso2', { sso: true, staleDays: 30 })

          expect(await departViaSweep(conn)).toBe(2)

          const rows = await pendingRows(conn)
          expect(rows).toHaveLength(1)
          expect(await daysUntil(conn, rows[0].scheduledPurgeAt)).toBeGreaterThan(29.9)

          // No per-row warning was swallowed: both expiries recorded a real window.
          const withWindow = await queryScalar(
            conn,
            `SELECT count(*)::text FROM audit_logs
            WHERE event_type = 'sso:expired'
              AND metadata->>'inventory_purge_scheduled_at' IS NOT NULL;`
          )
          expect(withWindow).toBe('2')
        },
        TIMEOUT_MS
      )
    })

    describe('monotonicity — the deadline never moves backwards', () => {
      it(
        'keeps the later window (and its team) when a new departure would shorten it',
        async () => {
          const { conn } = await setup(true)

          const sso = await joinTeam(conn, 't-sso', { sso: true, staleDays: 30 })
          expect(sso).toBeTruthy()
          await departViaSweep(conn)
          // Push the existing window PAST what a fresh departure would grant, the
          // state a transaction that started earlier but commits later produces.
          await backdatePending(conn, -5)
          const before = (await pendingRows(conn))[0]
          expect(await daysUntil(conn, before.scheduledPurgeAt)).toBeGreaterThan(34.9)

          const plain = await joinTeam(conn, 't-plain')
          await departViaRpc(conn, plain)

          const rows = await pendingRows(conn)
          expect(rows).toHaveLength(1)
          // GREATEST kept the further-out deadline...
          expect(await daysUntil(conn, rows[0].scheduledPurgeAt)).toBeGreaterThan(34.9)
          // ...and the CASE arm kept departed_team_id in lockstep with it, so the row
          // never describes one departure's team with another departure's deadline.
          expect(rows[0].departedTeamId).toBe('t-sso')
        },
        TIMEOUT_MS
      )
    })

    describe('resolved rows are history, not an obstacle', () => {
      it(
        'lets a user with purged and cancelled rows depart again',
        async () => {
          const { conn } = await setup(true)

          await runPsql(
            conn,
            `INSERT INTO team_member_inventory_purge_schedule
             (user_id, departed_team_id, scheduled_purge_at, purged_at)
           VALUES (:'u', 't-plain', now() - INTERVAL '60 days', now() - INTERVAL '60 days');
           INSERT INTO team_member_inventory_purge_schedule
             (user_id, departed_team_id, scheduled_purge_at, cancelled_reason)
           VALUES (:'u', 't-plain', now() - INTERVAL '31 days', 'still_entitled_at_sweep');`,
            { u: DEPARTER_ID }
          )

          const plain = await joinTeam(conn, 't-plain')
          await departViaRpc(conn, plain)

          const census = await rowCensus(conn)
          expect(census.pending).toBe(1)
          expect(census.total).toBe(3)
        },
        TIMEOUT_MS
      )
    })

    describe('the migration applies cleanly and its own smoke blocks run', () => {
      let stderr = ''
      beforeAll(async () => {
        const applied = await setup(true)
        stderr = applied.stderr
      }, TIMEOUT_MS)

      it('reports every smoke block as passed, none skipped or failed', () => {
        expect(stderr).toContain('SMI-6318 smoke 1 passed')
        expect(stderr).toContain('SMI-6318 smoke 2 passed')
        expect(stderr).toContain('SMI-6318 smoke 3 passed')
        expect(stderr).toContain('SMI-6318 regression smoke passed r1-r4')
        expect(stderr).not.toContain('SMOKE FAIL')
        // r2/r3 degrade to a NOTICE when real SSO members exist; on a throwaway
        // database they must actually have run.
        expect(stderr).not.toContain('smoke r2/r3 SKIPPED')
      })

      it(
        'bumps schema_version to 111',
        async () => {
          const { conn } = await setup(true)
          await expect(
            queryScalar(conn, 'SELECT max(version)::text FROM schema_version;')
          ).resolves.toBe('111')
        },
        TIMEOUT_MS
      )
    })
  }
)

/**
 * Always-on CI gate. The behavioural suite above needs a live Postgres and
 * therefore SKIPS in CI; these assertions read the shipped migration text and
 * run everywhere it is readable, so a future edit that drops the arbiter, the
 * monotonic write, the departed_team_id lockstep, the boundary discipline or the
 * Check-52 REVOKE fails at PR time rather than silently.
 */
describe('SMI-6318 migration exists', () => {
  it('is present by filename even on a git-crypt-locked checkout', () => {
    expect(existsSync(dedupMigrationPath())).toBe(true)
  })
})

describe.skipIf(MIGRATION_LOCKED)(
  'SMI-6318 migration text keeps the properties the design depends on',
  () => {
    const sql = MIGRATION_LOCKED
      ? ''
      : readMigration('20260831130000_purge_schedule_pending_dedup.sql')

    it("arbitrates on user_id alone, with the sweep's own pending predicate", () => {
      const conflicts = sql.match(
        /ON CONFLICT \(user_id\) WHERE purged_at IS NULL AND cancelled_reason IS NULL/g
      )
      // Exactly the two departure write paths — a third would mean a call site was
      // added without being considered here.
      expect(conflicts).toHaveLength(2)
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS uq_team_member_purge_schedule_pending_user\s+ON team_member_inventory_purge_schedule \(user_id\)\s+WHERE purged_at IS NULL AND cancelled_reason IS NULL/
      )
    })

    it('commits the index and both function bodies in ONE transaction', () => {
      // Adversarial review H1: an earlier draft split these into three transactions.
      // Committing the index alone leaves the pre-fix plain INSERTs live against it —
      // a repeat departure then raises 23505, which the sweep's per-row handler
      // downgrades to a WARNING and a silently lost retention window. Committing the
      // functions alone leaves their ON CONFLICT with no arbiter (42P10). They ship
      // together or not at all.
      const ddlEnd = sql.indexOf('Tx 2 -- schema_version')
      expect(ddlEnd).toBeGreaterThan(0)
      const ddl = sql.slice(0, ddlEnd)
      expect(ddl.match(/^BEGIN;$/gm)).toHaveLength(1)
      expect(ddl.match(/^COMMIT;$/gm)).toHaveLength(1)
      expect(ddl.match(/^CREATE OR REPLACE FUNCTION/gm)).toHaveLength(2)
      expect(ddl).toMatch(/^CREATE UNIQUE INDEX IF NOT EXISTS/m)
    })

    it('takes the table lock explicitly before the backfill', () => {
      // Adversarial review L1: "same transaction" is NOT atomicity under READ COMMITTED —
      // the backfill UPDATE and the index build take separate snapshots, and a departure
      // committing between them would recreate a duplicate and fail the index build.
      // The explicit SHARE lock is what actually closes that gap.
      const lockAt = sql.indexOf('LOCK TABLE team_member_inventory_purge_schedule IN SHARE MODE')
      const backfillAt = sql.indexOf("SET cancelled_reason = 'superseded_by_later_departure'")
      expect(lockAt).toBeGreaterThan(0)
      expect(backfillAt).toBeGreaterThan(lockAt)
    })

    it('bounds how long the browser-facing RPC can wait on a row lock', () => {
      // Adversarial review M5: the upsert can now queue behind the 03:40 UTC purge sweep's
      // FOR UPDATE SKIP LOCKED transaction. remove_team_member() is called from the browser
      // under PostgREST's 8s statement_timeout, so an unbounded wait becomes an opaque 57014.
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION remove_team_member\(p_member_id TEXT\)[\s\S]{0,2000}?SET lock_timeout TO '2s'\nAS \$remove_team_member\$/
      )
    })

    it('warns rather than raises when the sweep cannot record a window', () => {
      // Adversarial review M3: raising inside the sweep's per-row isolation block would roll
      // back recompute_user_tier() and skip the license-key revocation while the membership
      // DELETE stands — leaving an entitlement (and an active team/enterprise key) alive
      // past the membership it came from. That is worse than the missing row it reacts to.
      const sweep = sql.slice(
        sql.indexOf('AS $expire_stale_sso_members$'),
        sql.lastIndexOf('$expire_stale_sso_members$')
      )
      expect(sweep).toMatch(
        /IF v_purge_at IS NULL THEN\s+RAISE WARNING 'expire_stale_sso_members: inventory purge schedule upsert affected no '/
      )
      // ...and the revocation must still come after it, inside the same block.
      expect(sweep.indexOf('IF v_purge_at IS NULL THEN')).toBeLessThan(
        sweep.indexOf('UPDATE license_keys lk')
      )
      // The caller-facing RPC keeps the opposite policy: fail closed, no removal without a window.
      const rpc = sql.slice(
        sql.indexOf('AS $remove_team_member$'),
        sql.lastIndexOf('$remove_team_member$')
      )
      expect(rpc).toMatch(/IF v_purge_at IS NULL THEN\s+RAISE EXCEPTION/)
    })

    it('ships a runnable, unencrypted paired rollback (ADR-108)', () => {
      // The migration itself is git-crypt encrypted, so rollback steps living only in its
      // comments are unreadable to an incident responder without a decrypt key.
      const down = 'supabase/rollbacks/20260831130000_purge_schedule_pending_dedup_down.sql'
      expect(existsSync(down)).toBe(true)
      const downSql = readFileSync(down, 'utf8')
      // The ordering constraint must be an executable guard, not prose.
      expect(downSql).toContain('ROLLBACK REFUSED')
      expect(downSql).toContain('DROP INDEX IF EXISTS uq_team_member_purge_schedule_pending_user')
    })

    it('writes the deadline monotonically at both call sites', () => {
      // A plain `scheduled_purge_at = EXCLUDED.scheduled_purge_at` would let a
      // transaction that started earlier but commits later shorten a live grace
      // window — the same class of bug this migration exists to fix.
      const greatest = sql.match(
        /scheduled_purge_at = GREATEST\(\s*team_member_inventory_purge_schedule\.scheduled_purge_at,\s*EXCLUDED\.scheduled_purge_at\s*\)/g
      )
      expect(greatest).toHaveLength(2)
    })

    it('never lets departed_team_id drift away from the window it describes', () => {
      const guarded = sql.match(/departed_team_id = CASE\s+WHEN EXCLUDED\.scheduled_purge_at/g)
      expect(guarded).toHaveLength(2)
    })

    it('keeps the sweep out of the Wave-4 boundary tables', () => {
      const body = sql.slice(
        sql.indexOf('AS $expire_stale_sso_members$'),
        sql.lastIndexOf('$expire_stale_sso_members$')
      )
      for (const forbidden of [
        'auth.identities',
        'auth.users',
        'auth.jwt',
        'team_sso_domains',
        'team_sso_settings',
        'supabase_provider_id',
      ]) {
        expect(body).not.toContain(forbidden)
      }
      // Positive control: the exempt readers are still reached.
      expect(body).toContain('sso_expiry_eligible')
      expect(body).toContain('sso_reverify_days')
    })

    it('re-issues an anon REVOKE for every redefined SECURITY DEFINER function', () => {
      // audit:standards Check 52 (SMI-5526): a REVOKE naming `anon` is required per
      // redefined secdef signature, and `FROM PUBLIC` alone does not satisfy it.
      expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.remove_team_member(TEXT) FROM anon;')
      expect(sql).toContain(
        'REVOKE EXECUTE ON FUNCTION public.expire_stale_sso_members() FROM anon, authenticated;'
      )
    })
  }
)
