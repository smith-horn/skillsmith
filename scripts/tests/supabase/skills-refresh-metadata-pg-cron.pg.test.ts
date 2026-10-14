/**
 * SMI-7114 -- live-Postgres suite for the skills-refresh-metadata pg_cron migration
 * (20261013000000): apply/rollback, privilege model, dispatcher, response harvester, observer read
 * RPC and observer dead-man. Harness, env vars and the real-vs-stubbed inventory:
 * ./skills-refresh-metadata-pg-cron.test-helpers.ts. The health and dead-man arms live in
 * ./skills-refresh-metadata-pg-cron.pg-health.ts and ...pg-deadman.ts (500-line limit).
 *
 * CI SKIPS THIS FILE (no workflow sets SMI7114_TEST_PG*), so it is the implementing session's job
 * to run it and record the output on SMI-7114. The PG-free assertions about the migration's text
 * live in ./skills-refresh-metadata-pg-cron.structural.test.ts.
 *
 * Every arm that depends on time runs its seed and its calls in ONE transaction (helpers:
 * `inTxn`), so `now()` is the same instant for both and every boundary is exact.
 */

import { describe, it, beforeAll, beforeEach, afterAll, expect } from 'vitest'
import {
  ALL_FNS,
  AS,
  BASE_URL,
  FNS,
  FN_SIGS,
  JOBS,
  PsqlSession,
  SERVICE_KEY,
  buildSql,
  count,
  alertRow,
  dispatchRow,
  fixtureSql,
  inTxn,
  inTxnRaw,
  migrationForHarness,
  noLiveTestPg,
  requireTestConn,
  responseRow,
  rollbackSql,
  scalarQuery,
  sqlstate,
  standardSecrets,
  vault,
} from './skills-refresh-metadata-pg-cron.test-helpers.ts'
import { registerHealthTests } from './skills-refresh-metadata-pg-cron.pg-health.ts'
import { registerDeadmanTests } from './skills-refresh-metadata-pg-cron.pg-deadman.ts'
import { registerConcurrencyTests } from './skills-refresh-metadata-pg-cron.pg-concurrency.ts'

const CALLS: Record<(typeof ALL_FNS)[number], string> = {
  [FNS.invoke]: 'SELECT public.invoke_skills_refresh_metadata();',
  [FNS.health]: 'SELECT public.refresh_metadata_health();',
  [FNS.harvest]: 'SELECT public.harvest_refresh_dispatch_results();',
  [FNS.deadman]: 'SELECT public.check_refresh_observer_heartbeat();',
}
const DISPATCHED = "audit_logs WHERE event_type = 'refresh:dispatch'"
const HARVESTED = "audit_logs WHERE event_type = 'refresh:dispatch_result'"
const HARVESTED_ALERT = "audit_logs WHERE event_type = 'refresh:observer_dead_alert_result'"

describe.skipIf(noLiveTestPg)(
  'SMI-7114 -- skills-refresh-metadata pg_cron trigger, health RPC, harvester and dead-man',
  { timeout: 120_000 },
  () => {
    let ctl: PsqlSession
    const ctx = { ctl: () => ctl }

    beforeAll(async () => {
      ctl = new PsqlSession(requireTestConn(), 'ctl')
      await ctl.send('\\set VERBOSITY verbose')
      const res = await ctl.send(buildSql())
      expect(res.stderr, `schema + migration build failed:\n${res.stderr}`).not.toMatch(/ERROR/)
      // Presence: the build really applied the migration (its smoke NOTICE) and left four functions.
      expect(res.stderr).toMatch(/SMI-7114 smoke: passed/)
      const n = await scalarQuery(
        ctl,
        `SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${ALL_FNS.join("','")}');`
      )
      expect(n, 'the four functions exist after the build').toBe('4')
    }, 90_000)

    afterAll(async () => {
      await ctl?.close()
    })

    beforeEach(async () => {
      const fx = await ctl.send(fixtureSql())
      expect(fx.stderr, `fixture reload failed:\n${fx.stderr}`).not.toMatch(/ERROR/)
    })

    // ------------------------------------------------------------------------
    // Case 1: apply
    // ------------------------------------------------------------------------
    describe('case 1: apply', () => {
      it('the pg_net strip is real: the harness migration has no CREATE EXTENSION pg_net', () => {
        expect(migrationForHarness()).not.toMatch(/^CREATE EXTENSION IF NOT EXISTS pg_net/m)
      })

      it('re-applies cleanly (idempotent), passes its own smoke, and leaves three jobs', async () => {
        const res = await ctl.send(migrationForHarness())
        expect(res.stderr, `re-apply failed:\n${res.stderr}`).not.toMatch(/ERROR/)
        expect(res.stderr).toMatch(/SMI-7114 smoke: passed/)
        const rows = await ctl.send(
          "SELECT jobname || '|' || schedule || '|' || command FROM cron.job ORDER BY jobname;"
        )
        expect(rows.stdout.split('\n')).toEqual([
          'refresh-dispatch-harvest|43 * * * *|SELECT public.harvest_refresh_dispatch_results()',
          'refresh-observer-heartbeat|17 * * * *|SELECT public.check_refresh_observer_heartbeat()',
          'skills-refresh-metadata|32 2-22/4 * * *|SELECT public.invoke_skills_refresh_metadata()',
        ])
        for (const [name, schedule] of Object.entries(JOBS)) {
          expect(rows.stdout).toContain(`${name}|${schedule}|`)
        }
      })
    })

    // ------------------------------------------------------------------------
    // Case 2: grants
    // ------------------------------------------------------------------------
    describe('case 2: privilege model (D3)', () => {
      it('service_role holds EXECUTE on all four; anon and authenticated on none (positive control)', async () => {
        const r = await inTxn(
          ctl,
          FN_SIGS.flatMap((sig) =>
            ['service_role', 'anon', 'authenticated'].map(
              (role) =>
                `SELECT '${role}:${sig}=' || has_function_privilege('${role}', '${sig}'::regprocedure, 'EXECUTE');`
            )
          )
        )
        const expected = FN_SIGS.flatMap((sig) => [
          `service_role:${sig}=true`,
          `anon:${sig}=false`,
          `authenticated:${sig}=false`,
        ])
        expect(r.lines).toEqual(expected)
      })

      for (const role of ['anon', 'authenticated']) {
        it.each(ALL_FNS)(`${role} is refused EXECUTE on %s with 42501`, async (fn) => {
          const r = await inTxnRaw(ctl, [AS(role), CALLS[fn]])
          expect(sqlstate(r), r.stderr).toBe('42501')
          expect(r.stderr).toMatch(new RegExp(`permission denied for function ${fn}`))
        })
      }

      it.each([FNS.health, FNS.harvest])('service_role can call %s', async (fn) => {
        const r = await inTxn(ctl, [AS('service_role'), CALLS[fn]])
        expect(r.stderr).not.toMatch(/ERROR/)
      })
    })

    // ------------------------------------------------------------------------
    // Case 3: dispatcher
    // ------------------------------------------------------------------------
    describe('case 3: dispatcher invoke_skills_refresh_metadata()', () => {
      it('POSTs once with URL, body, bearer key and a 300000 ms timeout, and writes one dispatch row', async () => {
        const r = await inTxn(ctl, [
          standardSecrets(),
          AS('service_role'),
          CALLS[FNS.invoke],
          'RESET ROLE;',
          count('calls', 'net.calls'),
          "SELECT 'url=' || url FROM net.calls;",
          'SELECT \'body=\' || (body = \'{"batchSize":200,"staleDays":1,"dryRun":false}\'::jsonb) FROM net.calls;',
          "SELECT 'auth=' || (headers->>'Authorization') FROM net.calls;",
          "SELECT 'ctype=' || (headers->>'Content-Type') FROM net.calls;",
          "SELECT 'timeout=' || timeout_milliseconds FROM net.calls;",
          count('rows', DISPATCHED),
          `SELECT 'actor=' || actor FROM ${DISPATCHED};`,
          "SELECT 'idmatch=' || count(*) FROM audit_logs a JOIN net.calls c " +
            "ON (a.metadata->>'net_request_id')::bigint = c.id WHERE a.event_type = 'refresh:dispatch';",
        ])
        expect(r.lines).toEqual([
          'calls=1',
          `url=${BASE_URL}/functions/v1/skills-refresh-metadata`,
          'body=true',
          `auth=Bearer ${SERVICE_KEY}`,
          'ctype=application/json',
          'timeout=300000',
          'rows=1',
          'actor=pg_cron',
          'idmatch=1',
        ])
      })

      it.each([
        ['no secrets', [], 'refresh_metadata_functions_base_url not found in vault'],
        [
          'the key missing',
          [['refresh_metadata_functions_base_url', BASE_URL]],
          'refresh_metadata_service_role_key not found in vault',
        ],
        [
          'the base url missing',
          [['refresh_metadata_service_role_key', SERVICE_KEY]],
          'refresh_metadata_functions_base_url not found in vault',
        ],
        [
          'a blank base url',
          [
            ['refresh_metadata_functions_base_url', '  '],
            ['refresh_metadata_service_role_key', SERVICE_KEY],
          ],
          'refresh_metadata_functions_base_url not found in vault',
        ],
      ] as Array<[string, Array<[string, string]>, string]>)(
        'RAISES P0001 with %s, POSTs nothing and leaves no dispatch row',
        async (_label, secrets, message) => {
          const r = await inTxnRaw(ctl, [
            ...(secrets.length ? [vault(...secrets)] : []),
            'SAVEPOINT before_invoke;',
            CALLS[FNS.invoke],
            'ROLLBACK TO before_invoke;',
            count('calls', 'net.calls'),
            count('rows', DISPATCHED),
          ])
          expect(sqlstate(r), r.stderr).toBe('P0001')
          expect(r.stderr).toContain(message)
          expect(r.lines).toEqual(['calls=0', 'rows=0'])
        }
      )
    })

    // ------------------------------------------------------------------------
    // Case 5: harvester
    // ------------------------------------------------------------------------
    describe('case 5: harvest_refresh_dispatch_results()', () => {
      const HARVEST = CALLS[FNS.harvest]

      it('copies one live response into one dispatch_result row with the right metadata', async () => {
        const r = await inTxn(ctl, [
          dispatchRow('30 minutes', 2001),
          responseRow(2001, 500, { content: 'x', errorMsg: 'upstream said no', timedOut: false }),
          HARVEST,
          count('rows', HARVESTED),
          `SELECT 'rid=' || (metadata->>'net_request_id') FROM ${HARVESTED};`,
          `SELECT 'status=' || (metadata->>'status_code') FROM ${HARVESTED};`,
          `SELECT 'timed_out=' || (metadata->>'timed_out') FROM ${HARVESTED};`,
          `SELECT 'error_msg=' || (metadata->>'error_msg') FROM ${HARVESTED};`,
          `SELECT 'actor=' || actor || ',result=' || result FROM ${HARVESTED};`,
        ])
        expect(r.lines).toEqual([
          'rows=1',
          'rid=2001',
          'status=500',
          'timed_out=false',
          'error_msg=upstream said no',
          'actor=pg_cron,result=error',
        ])
      })

      it('a 2xx response is recorded with result ok', async () => {
        const r = await inTxn(ctl, [
          dispatchRow('30 minutes', 2002),
          responseRow(2002, 200),
          HARVEST,
          `SELECT 'result=' || result FROM ${HARVESTED};`,
        ])
        expect(r.lines).toEqual(['result=ok'])
      })

      it('a second call inserts nothing', async () => {
        const r = await inTxn(ctl, [
          dispatchRow('30 minutes', 2003),
          responseRow(2003, 500),
          HARVEST,
          count('after_first', HARVESTED),
          HARVEST,
          count('after_second', HARVESTED),
        ])
        expect(r.lines).toEqual(['after_first=1', 'after_second=1'])
      })

      it('a dispatch older than 6h, a non-pg_cron dispatch, and a dispatch without a response are not harvested', async () => {
        const r = await inTxn(ctl, [
          dispatchRow('6 hours 1 minute', 2004),
          responseRow(2004, 500),
          dispatchRow('30 minutes', 2005, 'manual'),
          responseRow(2005, 500),
          dispatchRow('30 minutes', 2006),
          HARVEST,
          count('rows', HARVESTED),
          // Control: a harvestable dispatch beside them IS harvested, so the 0 above is not a
          // harvester that never harvests.
          dispatchRow('30 minutes', 2007),
          responseRow(2007, 500),
          HARVEST,
          count('rows_after_control', HARVESTED),
          `SELECT 'rid=' || (metadata->>'net_request_id') FROM ${HARVESTED};`,
        ])
        expect(r.lines).toEqual(['rows=0', 'rows_after_control=1', 'rid=2007'])
      })

      it('after harvesting, deleting the live response leaves health classifying from the durable row', async () => {
        const health = (): string =>
          "SELECT 'kinds=' || coalesce((SELECT string_agg(f->>'kind', ',') " +
          "FROM jsonb_array_elements(public.refresh_metadata_health()->'failures') f), '');"
        const r = await inTxn(ctl, [
          dispatchRow('30 minutes', 2008),
          responseRow(2008, 500),
          HARVEST,
          'DELETE FROM net._http_response;', // pg_net's 6h TTL purge
          health(),
          "SELECT 'unknown=' || (public.refresh_metadata_health()->>'unknown_count');",
        ])
        expect(r.lines).toEqual(['kinds=http_error', 'unknown=0'])

        // Control: without the harvest the same purge leaves a dispatch with no response.
        const unharvested = await inTxn(ctl, [
          dispatchRow('7 hours', 2009),
          responseRow(2009, 500),
          'DELETE FROM net._http_response;',
          "SELECT 'unknown=' || (public.refresh_metadata_health()->>'unknown_count');",
        ])
        expect(unharvested.lines).toEqual(['unknown=1'])
      })
    })

    describe('case 5b: harvest_refresh_dispatch_results() -- dead-man alert responses (R2-1)', () => {
      const HARVEST = CALLS[FNS.harvest]

      it('copies one alert response into one durable row once, with the right metadata', async () => {
        const r = await inTxn(ctl, [
          alertRow('30 minutes', 7201),
          responseRow(7201, 200, { content: '{"data":{"sent":true}}' }),
          HARVEST,
          count('after_first', HARVESTED_ALERT),
          HARVEST,
          count('after_second', HARVESTED_ALERT),
          `SELECT 'rid=' || (metadata->>'net_request_id') FROM ${HARVESTED_ALERT};`,
          `SELECT 'status=' || (metadata->>'status_code') FROM ${HARVESTED_ALERT};`,
          `SELECT 'sent=' || (metadata->>'sent') FROM ${HARVESTED_ALERT};`,
          `SELECT 'actor=' || actor || ',result=' || result FROM ${HARVESTED_ALERT};`,
        ])
        expect(r.lines).toEqual([
          'after_first=1',
          'after_second=1',
          'rid=7201',
          'status=200',
          'sent=true',
          'actor=pg_cron,result=ok',
        ])
      })

      it('parses sent per row: true, false, and non-JSON / missing / NULL bodies as null, without aborting the rest', async () => {
        const bodies: Array<[number, number, string | null]> = [
          [7210, 200, 'not json <html>'],
          [7211, 200, '{"data":{"sent":true}}'],
          [7212, 200, '{"data":{"sent":false}}'],
          [7213, 200, '{"ok":true}'],
          [7214, 500, null],
        ]
        const r = await inTxn(ctl, [
          ...bodies.flatMap(([rid, status, content]) => [
            alertRow('30 minutes', rid),
            responseRow(rid, status, { content }),
          ]),
          HARVEST,
          count('rows', HARVESTED_ALERT),
          `SELECT (metadata->>'net_request_id') || ':' || coalesce(metadata->>'sent', 'NULL') || ':' || result ` +
            `FROM ${HARVESTED_ALERT} ORDER BY 1;`,
        ])
        expect(r.lines).toEqual([
          'rows=5',
          '7210:NULL:error',
          '7211:true:ok',
          '7212:false:error',
          '7213:NULL:error',
          '7214:NULL:error',
        ])
      })

      it('ignores an alert older than 6h and an alert without a response; a control beside them is harvested', async () => {
        const r = await inTxn(ctl, [
          alertRow('6 hours 1 minute', 7220),
          responseRow(7220, 200, { content: '{"data":{"sent":true}}' }),
          alertRow('30 minutes', 7221),
          HARVEST,
          count('rows', HARVESTED_ALERT),
          alertRow('30 minutes', 7222),
          responseRow(7222, 200, { content: '{"data":{"sent":true}}' }),
          HARVEST,
          count('rows_after_control', HARVESTED_ALERT),
          `SELECT 'rid=' || (metadata->>'net_request_id') FROM ${HARVESTED_ALERT};`,
        ])
        expect(r.lines).toEqual(['rows=0', 'rows_after_control=1', 'rid=7222'])
      })
    })

    registerHealthTests(ctx)
    registerDeadmanTests(ctx)
    registerConcurrencyTests(ctx)

    // ------------------------------------------------------------------------
    // Case 1 (continued): rollback. Last in the file because it drops the objects the arms above
    // run against; the migration is re-applied before the arm returns, success or failure.
    // ------------------------------------------------------------------------
    describe('case 1: rollback', () => {
      it('removes the jobs and functions, and the migration re-applies after it', async () => {
        try {
          const down = await ctl.send(rollbackSql())
          expect(down.stderr, `rollback failed:\n${down.stderr}`).not.toMatch(/ERROR/)
          expect(await scalarQuery(ctl, "SELECT 'jobs=' || count(*) FROM cron.job;")).toBe('jobs=0')
          expect(
            await scalarQuery(
              ctl,
              `SELECT 'fns=' || count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${ALL_FNS.join("','")}');`
            )
          ).toBe('fns=0')

          const again = await ctl.send(migrationForHarness())
          expect(again.stderr, `re-apply after rollback failed:\n${again.stderr}`).not.toMatch(
            /ERROR/
          )
          expect(again.stderr).toMatch(/SMI-7114 smoke: passed/)
          expect(await scalarQuery(ctl, "SELECT 'jobs=' || count(*) FROM cron.job;")).toBe('jobs=3')
        } finally {
          await ctl.send(migrationForHarness())
        }
      })
    })
  }
)
