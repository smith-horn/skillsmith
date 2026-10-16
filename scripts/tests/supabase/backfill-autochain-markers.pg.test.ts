/**
 * SMI-7121 -- live-Postgres suite for the backfill autochain marker migration (20261016000000):
 * apply/rollback, privilege model and the transition function (plan Verification 5, single-session
 * arms). The watcher arms (Verification 6b) live in ./backfill-autochain-markers.pg-watcher.ts and
 * the two-session races in ./backfill-autochain-markers.pg-concurrency.ts (500-line limit).
 * Harness, env vars and the real-vs-stubbed inventory: ./backfill-autochain-markers.test-helpers.ts.
 *
 * CI SKIPS THIS FILE (no workflow sets SMI7121_TEST_PG*), so it is the implementing session's job
 * to run it and record the output on SMI-7121. The PG-free assertions about the migration's text
 * live in ./backfill-autochain-markers.structural.test.ts.
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
  fixtureSql,
  inTxn,
  inTxnRaw,
  markerMeta,
  markerRow,
  migrationForHarness,
  noLiveTestPg,
  requireTestConn,
  rollbackSql,
  scalarQuery,
  sqlstate,
  transition,
} from './backfill-autochain-markers.test-helpers.ts'
import { registerWatcherTests } from './backfill-autochain-markers.pg-watcher.ts'
import { registerConcurrencyTests } from './backfill-autochain-markers.pg-concurrency.ts'

const CALLS: Record<(typeof ALL_FNS)[number], string> = {
  backfill_autochain_marker_transition:
    "SELECT public.backfill_autochain_marker_transition('m', 'open', 'consumed', '{}'::jsonb);",
  check_backfill_autochain_markers: 'SELECT public.check_backfill_autochain_markers();',
}

const ALLOWED: Array<[string, string]> = [
  ['open', 'consumed'],
  ['open', 'needs_intervention'],
  ['consumed', 'dispatched'],
  ['consumed', 'needs_intervention'],
]
const STATES = ['open', 'consumed', 'dispatched', 'needs_intervention']

describe.skipIf(noLiveTestPg)(
  'SMI-7121 -- backfill autochain marker transition and stale-marker watcher',
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
      expect(res.stderr).toMatch(/SMI-7121 smoke: passed/)
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

      it('re-applies cleanly (idempotent), passes its own smoke, and leaves one job', async () => {
        const res = await ctl.send(migrationForHarness())
        expect(res.stderr, `re-apply failed:\n${res.stderr}`).not.toMatch(/ERROR/)
        expect(res.stderr).toMatch(/SMI-7121 smoke: passed/)
        const rows = await ctl.send(
          "SELECT jobname || '|' || schedule || '|' || command FROM cron.job ORDER BY jobname;"
        )
        expect(rows.stdout.split('\n')).toEqual([
          `${JOB}|${JOB_SCHEDULE}|SELECT public.check_backfill_autochain_markers()`,
        ])
      })

      it('security: the transition function is INVOKER, the watcher DEFINER, both with a pinned search_path', async () => {
        const r = await inTxn(
          ctl,
          FN_SIGS.map(
            (sig) =>
              `SELECT '${sig}=' || p.prosecdef || '|' || array_to_string(p.proconfig, ';') ` +
              `FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`
          )
        )
        expect(r.lines).toEqual([
          `${FN_SIGS[0]}=false|search_path=public, pg_temp`,
          `${FN_SIGS[1]}=true|search_path=public, net, vault, extensions, pg_temp`,
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

      for (const role of ['anon', 'authenticated']) {
        it.each(ALL_FNS)(`${role} is refused EXECUTE on %s with 42501`, async (fn) => {
          const r = await inTxnRaw(ctl, [AS(role), CALLS[fn]])
          expect(sqlstate(r), r.stderr).toBe('42501')
          expect(r.stderr).toMatch(new RegExp(`permission denied for function ${fn}`))
        })
      }

      it('service_role can run a claim (it holds UPDATE on audit_logs; the function is INVOKER)', async () => {
        const r = await inTxn(ctl, [
          markerRow('m1', '1 hour'),
          AS('service_role'),
          transition('claimed', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"42"}'),
          'RESET ROLE;',
          "SELECT 'state=' || (metadata->>'state') FROM audit_logs WHERE id = 'm1';",
        ])
        expect(r.lines).toEqual(['claimed=true', 'state=consumed'])
      })
    })

    describe('case 3: backfill_autochain_marker_transition() -- single session', () => {
      it.each(ALLOWED)('allowed %s -> %s moves the marker and returns true', async (from, to) => {
        const r = await inTxn(ctl, [
          markerRow('m1', '1 hour', { state: from }),
          transition('moved', 'm1', from, to, '{}'),
          "SELECT 'state=' || (metadata->>'state') FROM audit_logs WHERE id = 'm1';",
        ])
        expect(r.lines).toEqual(['moved=true', `state=${to}`])
      })

      const disallowed = STATES.flatMap((f) =>
        STATES.map((t) => [f, t] as [string, string])
      ).filter(([f, t]) => !ALLOWED.some(([af, at]) => af === f && at === t))
      it.each([...disallowed, ['open', 'bogus'], ['bogus', 'open']] as Array<[string, string]>)(
        'disallowed %s -> %s RAISES P0001 and leaves the marker unchanged',
        async (from, to) => {
          const r = await inTxnRaw(ctl, [
            markerRow('m1', '1 hour', { state: from }),
            'SAVEPOINT s;',
            transition('moved', 'm1', from, to, '{}'),
            'ROLLBACK TO s;',
            "SELECT 'state=' || (metadata->>'state') FROM audit_logs WHERE id = 'm1';",
          ])
          expect(sqlstate(r), r.stderr).toBe('P0001')
          expect(r.stderr).toContain('is not allowed')
          expect(r.lines).toEqual([`state=${from}`])
        }
      )

      it.each([
        ['a NULL from', null, 'consumed'],
        ['a NULL to', 'open', null],
      ] as Array<[string, string | null, string | null]>)(
        '%s RAISES P0001 (a NULL pair is refused, not silently allowed)',
        async (_label, from, to) => {
          const r = await inTxnRaw(ctl, [
            markerRow('m1', '1 hour'),
            transition('moved', 'm1', from, to, '{}'),
          ])
          expect(sqlstate(r), r.stderr).toBe('P0001')
          expect(r.stderr).toContain('is not allowed')
        }
      )

      it.each([
        ['an array', '[1]'],
        ['a string', '"x"'],
        ['a number', '3'],
        ['JSON null', 'null'],
        ['SQL NULL', null],
      ] as Array<[string, string | null]>)(
        'a patch that is %s RAISES P0001',
        async (_label, patch) => {
          const r = await inTxnRaw(ctl, [
            markerRow('m1', '1 hour'),
            transition('moved', 'm1', 'open', 'consumed', patch),
          ])
          expect(sqlstate(r), r.stderr).toBe('P0001')
          expect(r.stderr).toContain('p_patch must be a JSON object')
        }
      )

      it('a patch carrying its own state cannot override p_to; its other fields are merged', async () => {
        const r = await inTxn(ctl, [
          markerRow('m1', '1 hour'),
          transition('moved', 'm1', 'open', 'consumed', '{"state":"open","consumed_at":"T1"}'),
          "SELECT 'state=' || (metadata->>'state') || ',at=' || (metadata->>'consumed_at') FROM audit_logs WHERE id = 'm1';",
          // The override attempt did not leave the marker claimable again.
          transition('again', 'm1', 'open', 'consumed', '{}'),
        ])
        expect(r.lines).toEqual(['moved=true', 'state=consumed,at=T1', 'again=false'])
      })

      it('the patch merges onto the existing metadata: earlier fields survive, the patch wins on conflict', async () => {
        const r = await inTxn(ctl, [
          markerRow('m1', '1 hour', { deferred_by_autochain_run: 'd1' }),
          transition('c', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"c1"}'),
          transition('d', 'm1', 'consumed', 'dispatched', '{"dispatched_run_id":"r1"}'),
          "SELECT 'fields=' || concat_ws(',', metadata->>'completed_run_id', metadata->>'deferred_by_autochain_run', " +
            "metadata->>'consumed_by_autochain_run', metadata->>'dispatched_run_id', metadata->>'state') " +
            "FROM audit_logs WHERE id = 'm1';",
        ])
        expect(r.lines).toEqual(['c=true', 'd=true', 'fields=run-m1,d1,c1,r1,dispatched'])
      })

      it('wrong current state, wrong event_type and unknown id all return false and write nothing', async () => {
        const r = await inTxn(ctl, [
          markerRow('m1', '1 hour', { state: 'consumed' }),
          // A non-marker row with a marker-shaped state.
          "INSERT INTO audit_logs (id, event_type, metadata) VALUES ('x1', 'indexer:run', '{\"state\":\"open\"}');",
          transition('wrong_state', 'm1', 'open', 'consumed', '{"k":1}'),
          transition('wrong_type', 'x1', 'open', 'consumed', '{"k":1}'),
          transition('no_such', 'nope', 'open', 'consumed', '{"k":1}'),
          "SELECT 'touched=' || count(*) FROM audit_logs WHERE metadata ? 'k';",
          // Control: the same call on a matching marker does write.
          markerRow('m2', '1 hour'),
          transition('control', 'm2', 'open', 'consumed', '{"k":1}'),
          "SELECT 'touched_after=' || count(*) FROM audit_logs WHERE metadata ? 'k';",
        ])
        expect(r.lines).toEqual([
          'wrong_state=false',
          'wrong_type=false',
          'no_such=false',
          'touched=0',
          'control=true',
          'touched_after=1',
        ])
      })

      it('a second identical claim in sequence returns false (the claim is one-shot)', async () => {
        const r = await inTxn(ctl, [
          markerRow('m1', '1 hour'),
          transition('first', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"a"}'),
          transition('second', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"b"}'),
          markerMeta('meta', 'm1'),
        ])
        expect(r.lines.slice(0, 2)).toEqual(['first=true', 'second=false'])
        expect(JSON.parse(r.lines[2].slice('meta='.length)).consumed_by_autochain_run).toBe('a')
      })
    })

    registerWatcherTests(ctx)
    registerConcurrencyTests(ctx)

    // Rollback last: it drops the objects the arms above run against; the migration is re-applied
    // before the arm returns, success or failure.
    describe('case 1: rollback', () => {
      it('removes the job and both functions, leaves marker rows, and the migration re-applies after it', async () => {
        try {
          await ctl.send(markerRow('keep', '1 hour'))
          const down = await ctl.send(rollbackSql())
          expect(down.stderr, `rollback failed:\n${down.stderr}`).not.toMatch(/ERROR/)
          expect(await scalarQuery(ctl, "SELECT 'jobs=' || count(*) FROM cron.job;")).toBe('jobs=0')
          expect(
            await scalarQuery(
              ctl,
              `SELECT 'fns=' || count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${ALL_FNS.join("','")}');`
            )
          ).toBe('fns=0')
          expect(
            await scalarQuery(
              ctl,
              "SELECT 'markers=' || count(*) FROM audit_logs WHERE id = 'keep';"
            )
          ).toBe('markers=1')

          const again = await ctl.send(migrationForHarness())
          expect(again.stderr, `re-apply after rollback failed:\n${again.stderr}`).not.toMatch(
            /ERROR/
          )
          expect(again.stderr).toMatch(/SMI-7121 smoke: passed/)
          expect(await scalarQuery(ctl, "SELECT 'jobs=' || count(*) FROM cron.job;")).toBe('jobs=1')
        } finally {
          await ctl.send(migrationForHarness())
          await ctl.send(fixtureSql())
        }
      })
    })
  }
)
