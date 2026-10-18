/**
 * SMI-7142 -- live-Postgres suite for the backfill autochain resume migration (20261017000000):
 * apply/rollback and the privilege model here, the dispatcher arms in
 * ./backfill-autochain-resume.pg-dispatch.ts and the watcher arms in
 * ./backfill-autochain-resume.pg-watcher.ts (500-line limit). Harness, env vars and the
 * real-vs-stubbed inventory: ./backfill-autochain-resume.test-helpers.ts.
 *
 * CI SKIPS THIS FILE (no workflow sets SMI7142_TEST_PG*), so it is the implementing session's job to
 * run it and record the output on SMI-7142. The PG-free assertions about the migration's text live in
 * ./backfill-autochain-resume.structural.test.ts, and the cron/workflow parity (which must FAIL, not
 * skip, on an encrypted migration) in scripts/tests/indexer/backfill-autochain-resume-cron-parity.test.ts.
 */

import { describe, it, beforeAll, beforeEach, afterAll, expect } from 'vitest'
import {
  ALL_FNS,
  AS,
  FN_SIGS,
  JOB,
  JOB_SCHEDULE,
  PsqlSession,
  WATCH,
  WATCH_JOB,
  auditRow,
  buildSql,
  fixtureSql,
  inTxn,
  inTxnRaw,
  latestFunctionsSql,
  marker,
  migrationForHarness,
  noLiveTestPg,
  patSecret,
  posts,
  requireTestConn,
  rollbackSql,
  scalarQuery,
  sqlstate,
  standardSecrets,
} from './backfill-autochain-resume.test-helpers.ts'
import { registerDispatchTests } from './backfill-autochain-resume.pg-dispatch.ts'
import { registerResumeWatcherTests } from './backfill-autochain-resume.pg-watcher.ts'

const CALLS: Record<(typeof ALL_FNS)[number], string> = {
  invoke_backfill_autochain_resume: 'SELECT public.invoke_backfill_autochain_resume();',
  check_backfill_autochain_markers: 'SELECT public.check_backfill_autochain_markers();',
}
const JOB_ROWS = [
  `${WATCH_JOB}|29 * * * *|SELECT public.check_backfill_autochain_markers()`,
  `${JOB}|${JOB_SCHEDULE}|SELECT public.invoke_backfill_autochain_resume()`,
]
const SMOKE = /SMI-7142 smoke: passed/
const jobs = "SELECT jobname || '|' || schedule || '|' || command FROM cron.job ORDER BY jobname;"

describe.skipIf(noLiveTestPg)(
  'SMI-7142 -- backfill autochain resume dispatcher and extended watcher',
  { timeout: 120_000 },
  () => {
    let ctl: PsqlSession
    const ctx = { ctl: () => ctl }

    beforeAll(async () => {
      ctl = new PsqlSession(requireTestConn(), 'ctl')
      await ctl.send('\\set VERBOSITY verbose')
      const res = await ctl.send(buildSql())
      expect(res.stderr, `schema + migrations build failed:\n${res.stderr}`).not.toMatch(/ERROR/)
      // Presence: the build really applied the migration (its smoke NOTICE) and left both functions.
      expect(res.stderr).toMatch(SMOKE)
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
    })

    describe('case 1: apply', () => {
      it('the pg_net strip is real: the harness migration has no CREATE EXTENSION pg_net', () => {
        expect(migrationForHarness()).not.toMatch(/^CREATE EXTENSION IF NOT EXISTS pg_net/m)
      })

      it('re-applies cleanly (idempotent), passes its own smoke, and leaves the two jobs', async () => {
        const res = await ctl.send(migrationForHarness())
        expect(res.stderr, `re-apply failed:\n${res.stderr}`).not.toMatch(/ERROR/)
        expect(res.stderr).toMatch(SMOKE)
        expect((await ctl.send(jobs)).stdout.split('\n')).toEqual(JOB_ROWS)
      })

      it('the smoke never runs the dispatcher: re-applying with a due marker and a PAT sends nothing', async () => {
        const seed = await ctl.send(
          [
            patSecret(),
            standardSecrets(),
            marker('m1', { state: 'consumed', created: '2 hours' }),
          ].join('\n')
        )
        expect(seed.stderr).not.toMatch(/ERROR/)
        const res = await ctl.send(migrationForHarness())
        expect(res.stderr, `re-apply failed:\n${res.stderr}`).not.toMatch(/ERROR/)
        expect(await scalarQuery(ctl, 'SELECT count(*) FROM net.calls;')).toBe('0')
      })

      it('both functions are DEFINER with a pinned search_path', async () => {
        const r = await inTxn(
          ctl,
          FN_SIGS.map(
            (sig) =>
              `SELECT '${sig}=' || p.prosecdef || '|' || array_to_string(p.proconfig, ';') ` +
              `FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`
          )
        )
        const path = 'search_path=public, net, vault, extensions, pg_temp'
        expect(r.lines).toEqual(FN_SIGS.map((sig) => `${sig}=true|${path}`))
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
              `SELECT '${sig}=' || count(*) FROM pg_proc p, unnest(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl ` +
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
    })

    registerDispatchTests(ctx)
    registerResumeWatcherTests(ctx)

    // Rollback last: it drops the objects the arms above run against; the migration is re-applied
    // before the arm returns, success or failure.
    describe('case 9: rollback', () => {
      it('removes the resume job and dispatcher, restores the prior watcher, keeps rows and the marker-watch job, and re-applies', async () => {
        try {
          await ctl.send(
            auditRow(
              'indexer_backfill_autochain_resume_dispatch',
              '1 hour',
              "jsonb_build_object('marker_id', 'keep')",
              'keep-row'
            )
          )
          const down = await ctl.send(rollbackSql())
          expect(down.stderr, `rollback failed:\n${down.stderr}`).not.toMatch(/ERROR/)
          expect((await ctl.send(jobs)).stdout).toBe(JOB_ROWS[0])
          expect(
            await scalarQuery(
              ctl,
              `SELECT 'fns=' || string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${ALL_FNS.join("','")}');`
            )
          ).toBe('fns=check_backfill_autochain_markers')
          expect(
            await scalarQuery(
              ctl,
              "SELECT 'kept=' || count(*) FROM audit_logs WHERE id = 'keep-row';"
            )
          ).toBe('kept=1')

          // The restored watcher is the SMI-7121 one: it still alerts a stalled marker and is
          // blind to a failing resume dispatch.
          const old = await inTxn(ctl, [
            standardSecrets(),
            marker('m1', { created: '12 hours 30 minutes' }),
            auditRow(
              'indexer_backfill_autochain_resume_dispatch',
              '10 minutes',
              "jsonb_build_object('net_request_id', 7::bigint, 'marker_id', 'm2', 'status_code', 401)"
            ),
            WATCH,
            posts,
            "SELECT 'types=' || string_agg(body->>'type', ',') FROM net.calls;",
          ])
          expect(old.lines).toEqual(['posts=1', 'types=indexer_backfill_autochain_stalled'])

          const again = await ctl.send(migrationForHarness())
          expect(again.stderr, `re-apply after rollback failed:\n${again.stderr}`).not.toMatch(
            /ERROR/
          )
          expect(again.stderr).toMatch(SMOKE)
          expect((await ctl.send(jobs)).stdout.split('\n')).toEqual(JOB_ROWS)
        } finally {
          await ctl.send(migrationForHarness())
          await ctl.send(latestFunctionsSql())
          await ctl.send(fixtureSql())
        }
      })
    })
  }
)
