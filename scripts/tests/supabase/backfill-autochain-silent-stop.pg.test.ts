/**
 * SMI-7167 -- live-Postgres suite for the backfill autochain silent-stop detector migration
 * (20261025000000): apply/rollback and the privilege model. The candidates case table lives in
 * ./backfill-autochain-silent-stop.pg-candidates.ts, the detector arms in
 * ./backfill-autochain-silent-stop.pg-detector.ts and the two-session lock arms in
 * ./backfill-autochain-silent-stop.pg-concurrency.ts (500-line limit).
 * Harness, env vars and the real-vs-stubbed inventory: ./backfill-autochain-silent-stop.test-helpers.ts.
 *
 * CI SKIPS THIS FILE (no workflow sets SMI7121_TEST_PG*), so it is the implementing session's job
 * to run it and record the output on SMI-7167. The PG-free assertions about the migration's text
 * live in ./backfill-autochain-silent-stop.structural.test.ts.
 */

import { describe, it, beforeAll, beforeEach, afterAll, expect } from 'vitest'
import {
  ALL_FNS,
  AS,
  FN_SIGS,
  JOB,
  JOB_SCHEDULE,
  PsqlSession,
  buildSql,
  dispatchedRow,
  fixtureSql,
  inTxn,
  inTxnRaw,
  latestFunctionsSql,
  migrationForHarness,
  noLiveTestPg,
  requireTestConn,
  rollbackSql,
  scalarQuery,
  sqlstate,
} from './backfill-autochain-silent-stop.test-helpers.ts'
import { registerCandidateTests } from './backfill-autochain-silent-stop.pg-candidates.ts'
import { registerDetectorTests } from './backfill-autochain-silent-stop.pg-detector.ts'
import { registerDeliveryTests } from './backfill-autochain-silent-stop.pg-delivery.ts'
import { registerConcurrencyTests } from './backfill-autochain-silent-stop.pg-concurrency.ts'
import { registerVolumeTests } from './backfill-autochain-silent-stop.pg-volume.ts'

const CALLS: Record<(typeof ALL_FNS)[number], string> = {
  backfill_autochain_silent_stop_candidates:
    'SELECT * FROM public.backfill_autochain_silent_stop_candidates();',
  check_backfill_autochain_silent_stop: 'SELECT public.check_backfill_autochain_silent_stop();',
}

describe.skipIf(noLiveTestPg)(
  'SMI-7167 -- backfill autochain silent-stop candidates and detector',
  { timeout: 120_000 },
  () => {
    let ctl: PsqlSession
    const ctx = { ctl: () => ctl }

    beforeAll(async () => {
      ctl = new PsqlSession(requireTestConn(), 'ctl')
      await ctl.send('\\set VERBOSITY verbose')
      const res = await ctl.send(buildSql())
      expect(res.stderr, `schema + migration build failed:\n${res.stderr}`).not.toMatch(/ERROR/)
      // Presence: the build really applied the migration (its smoke NOTICE) and left both functions.
      expect(res.stderr).toMatch(/SMI-7167 smoke: passed/)
      const n = await scalarQuery(
        ctl,
        `SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${ALL_FNS.join("','")}');`
      )
      expect(n, 'both functions exist after the build').toBe('2')
    }, 90_000)

    afterAll(async () => {
      await ctl?.close()
    })

    beforeEach(async () => {
      const fx = await ctl.send(fixtureSql())
      expect(fx.stderr, `fixture reload failed:\n${fx.stderr}`).not.toMatch(/ERROR/)
      // Case 1 re-sends the ORIGINAL migration (apply, re-apply, rollback round-trip), which puts
      // its own function bodies back. Without this, every case after it would test the 20261025000000
      // bodies instead of the latest migration's (found 2026-10-25 by the volume case).
      const latest = await ctl.send(latestFunctionsSql())
      expect(latest.stderr, `latest bodies failed:\n${latest.stderr}`).not.toMatch(/ERROR/)
    })

    describe('case 1: apply', () => {
      it('the pg_net strip is real: the harness migration has no CREATE EXTENSION pg_net', () => {
        expect(migrationForHarness()).not.toMatch(/^CREATE EXTENSION IF NOT EXISTS pg_net/m)
      })

      it('re-applies cleanly (idempotent), passes its own smoke, and leaves one job', async () => {
        const res = await ctl.send(migrationForHarness())
        expect(res.stderr, `re-apply failed:\n${res.stderr}`).not.toMatch(/ERROR/)
        expect(res.stderr).toMatch(/SMI-7167 smoke: passed \(0 open candidate\(s\)\)/)
        const rows = await ctl.send(
          "SELECT jobname || '|' || schedule || '|' || command FROM cron.job ORDER BY jobname;"
        )
        expect(rows.stdout.split('\n')).toEqual([
          `${JOB}|${JOB_SCHEDULE}|SELECT public.check_backfill_autochain_silent_stop()`,
        ])
      })

      it('the smoke reports an open candidate when the ledger holds one (it runs the real query)', async () => {
        try {
          await ctl.send(dispatchedRow('1001', '13 hours'))
          const res = await ctl.send(migrationForHarness())
          expect(res.stderr, `re-apply failed:\n${res.stderr}`).not.toMatch(/ERROR/)
          expect(res.stderr).toMatch(/SMI-7167 smoke: passed \(1 open candidate\(s\)\)/)
        } finally {
          await ctl.send(fixtureSql())
        }
      })

      it('security: the candidates function is INVOKER and STABLE, the detector DEFINER, both with a pinned search_path', async () => {
        const r = await inTxn(
          ctl,
          FN_SIGS.map(
            (sig) =>
              `SELECT '${sig}=' || p.prosecdef || '|' || p.provolatile::text || '|' || array_to_string(p.proconfig, ';') ` +
              `FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`
          )
        )
        expect(r.lines).toEqual([
          `${FN_SIGS[0]}=false|s|search_path=public, pg_temp;enable_nestloop=off`, // 20261025000001
          `${FN_SIGS[1]}=true|v|search_path=public, net, vault, extensions, pg_temp`,
        ])
      })
    })

    describe('case 2: privilege model (D3)', () => {
      it('service_role holds EXECUTE on both; anon and authenticated on neither (positive control)', async () => {
        const r = await inTxn(
          ctl,
          FN_SIGS.flatMap((sig) =>
            ['service_role', 'anon', 'authenticated'].map(
              (role) =>
                `SELECT '${role}:${sig}=' || has_function_privilege('${role}', '${sig}'::regprocedure, 'EXECUTE');`
            )
          )
        )
        expect(r.lines).toEqual(
          FN_SIGS.flatMap((sig) => [
            `service_role:${sig}=true`,
            `anon:${sig}=false`,
            `authenticated:${sig}=false`,
          ])
        )
      })

      it('PUBLIC holds EXECUTE on neither', async () => {
        const r = await inTxn(
          ctl,
          FN_SIGS.map(
            (sig) =>
              `SELECT '${sig}=' || count(*) FROM pg_proc p, ` +
              `unnest(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl ` +
              `WHERE p.oid = '${sig}'::regprocedure AND acl::text LIKE '=%';`
          )
        )
        expect(r.lines).toEqual(FN_SIGS.map((sig) => `${sig}=0`))
      })

      for (const role of ['anon', 'authenticated']) {
        it.each(ALL_FNS)(`${role} is refused EXECUTE on %s with 42501`, async (fn) => {
          const r = await inTxnRaw(ctl, [AS(role), CALLS[fn]])
          expect(sqlstate(r), r.stderr).toBe('42501')
          expect(r.stderr).toMatch(new RegExp(`permission denied for function ${fn}`))
        })
      }

      it('service_role can run both (the detector is DEFINER; the candidates function reads audit_logs as INVOKER)', async () => {
        const r = await inTxn(ctl, [
          dispatchedRow('1001', '13 hours'),
          AS('service_role'),
          "SELECT 'cands=' || count(*) FROM public.backfill_autochain_silent_stop_candidates();",
          'SELECT public.check_backfill_autochain_silent_stop();',
          'RESET ROLE;',
          // no vault secrets are seeded, so the detector leaves its error row (it ran to that point)
          "SELECT 'errors=' || count(*) FROM audit_logs WHERE event_type = 'indexer_backfill_autochain_silent_stop_error';",
        ])
        expect(r.lines).toEqual(['cands=1', 'errors=1'])
      })
    })

    registerCandidateTests(ctx)
    registerDetectorTests(ctx)
    registerDeliveryTests(ctx)
    registerConcurrencyTests(ctx)
    registerVolumeTests(ctx)

    // Rollback last: it drops the objects the arms above run against; the migration is re-applied
    // before the arm returns, success or failure.
    describe('case 1: rollback', () => {
      it('removes the job and both functions, leaves ledger rows, and the migration re-applies after it', async () => {
        try {
          await ctl.send(dispatchedRow('1001', '13 hours'))
          const down = await ctl.send(rollbackSql())
          expect(down.stderr, `rollback failed:\n${down.stderr}`).not.toMatch(/ERROR/)
          expect(await scalarQuery(ctl, "SELECT 'jobs=' || count(*) FROM cron.job;")).toBe('jobs=0')
          expect(
            await scalarQuery(
              ctl,
              `SELECT 'fns=' || count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${ALL_FNS.join("','")}');`
            )
          ).toBe('fns=0')
          expect(await scalarQuery(ctl, "SELECT 'rows=' || count(*) FROM audit_logs;")).toBe(
            'rows=1'
          )

          const again = await ctl.send(migrationForHarness())
          expect(again.stderr, `re-apply after rollback failed:\n${again.stderr}`).not.toMatch(
            /ERROR/
          )
          expect(again.stderr).toMatch(/SMI-7167 smoke: passed/)
          expect(await scalarQuery(ctl, "SELECT 'jobs=' || count(*) FROM cron.job;")).toBe('jobs=1')
        } finally {
          await ctl.send(migrationForHarness())
          await ctl.send(fixtureSql())
        }
      })

      it('the rollback is idempotent: a second run on the already-rolled-back schema succeeds', async () => {
        try {
          await ctl.send(rollbackSql())
          const second = await ctl.send(rollbackSql())
          expect(second.stderr, `second rollback failed:\n${second.stderr}`).not.toMatch(/ERROR/)
        } finally {
          await ctl.send(migrationForHarness())
          await ctl.send(fixtureSql())
        }
      })
    })
  }
)
