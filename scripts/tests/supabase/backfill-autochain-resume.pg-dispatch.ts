/**
 * SMI-7142 plan "Tests and red-test plan": invoke_backfill_autochain_resume(), the pg_cron resume
 * dispatcher. Registered from ./backfill-autochain-resume.pg.test.ts. Every arm seeds and calls
 * inside one transaction, so every age boundary is exact; the lock arm uses two real sessions.
 *
 * @module scripts/tests/supabase/backfill-autochain-resume.pg-dispatch
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  AS,
  DISPATCH,
  DISPATCH_URL,
  MARKER,
  PAT,
  PAT_SECRET,
  PsqlSession,
  RESUME,
  RESUME_ERROR,
  RESUME_KILL,
  SUMMARY,
  consumedAgo,
  dispatches,
  fixtureSql,
  inTxn,
  lines,
  marker,
  openAt,
  patSecret,
  posts,
  q,
  requireTestConn,
  tsText,
  vault,
  type Ctx,
} from './backfill-autochain-resume.test-helpers.ts'

const DUE = '-1 minute'
const LOCK_KEY = "hashtextextended('invoke_backfill_autochain_resume', 0)"

/** Run one due-or-not scenario and return the three summary counts. */
async function counts(ctx: Ctx, seed: string[]): Promise<string[]> {
  const r = await inTxn(ctx.ctl(), [patSecret(), ...seed, RESUME, ...SUMMARY])
  return r.lines
}
const NONE = ['posts=0', 'dispatches=0', 'errors=0']
const ONE = ['posts=1', 'dispatches=1', 'errors=0']

/** The marker table's content fingerprint: the dispatcher must never write a marker. */
const markerHash = (label: string) =>
  `SELECT '${label}=' || coalesce(md5(string_agg(id || metadata::text, ',' ORDER BY id)), 'none') ` +
  `FROM audit_logs WHERE event_type = '${MARKER}';`

export function registerDispatchTests(ctx: Ctx): void {
  describe('case 4: invoke_backfill_autochain_resume() dispatcher -- single session', () => {
    it('idle: no marker at all sends nothing and writes nothing, even with no PAT stored', async () => {
      const r = await inTxn(ctx.ctl(), [RESUME, ...SUMMARY])
      expect(r.lines).toEqual(NONE)
    })

    it('a marker that is not live is ignored: dispatched, needs_intervention, a dispatched consumed one, or another event type', async () => {
      const past = { next_window_utc: tsText("now() - interval '1 day'") }
      expect(
        await counts(ctx, [
          marker('d1', { state: 'dispatched', fields: past }),
          marker('n1', { state: 'needs_intervention', fields: past }),
          consumedAgo('c1', '1 hour', { fields: { dispatched_run_id: q('123') } }),
          "INSERT INTO audit_logs (id, event_type, metadata) VALUES ('x1', 'indexer:run', " +
            '\'{"state":"open","next_window_utc":"2000-01-01"}\'::jsonb);',
        ])
      ).toEqual(NONE)
    })

    it('open marker: a future window sends nothing; the instant it opens, and after, it dispatches', async () => {
      for (const [delta, expected] of [
        ['1 hour', NONE],
        ['1 microsecond', NONE],
        ['0 seconds', ONE],
        ['-1 microsecond', ONE],
        ['-3 hours', ONE],
      ] as const)
        expect(await counts(ctx, [openAt('m1', delta)]), `next_window ${delta} from now`).toEqual(
          expected
        )
    })

    it.each([
      ['missing', {}],
      ['unparseable', { next_window_utc: q('not a time') }],
      ['infinity', { next_window_utc: q('infinity') }],
      ['-infinity', { next_window_utc: q('-infinity') }],
    ] as Array<[string, Record<string, string>]>)(
      'open marker with a %s next_window_utc is due (fail toward resuming), gate open_window_unreadable',
      async (_label, fields) => {
        const r = await inTxn(ctx.ctl(), [
          patSecret(),
          marker('m1', { fields }),
          RESUME,
          ...SUMMARY,
          `SELECT 'gate=' || (metadata->>'gate') FROM audit_logs WHERE event_type = '${DISPATCH}';`,
        ])
        expect(r.lines).toEqual([...ONE, 'gate=open_window_unreadable'])
      }
    )

    it('a far-future finite window (9999-01-01) is NOT unreadable: it waits', async () => {
      expect(
        await counts(ctx, [marker('m1', { fields: { next_window_utc: q('9999-01-01') } })])
      ).toEqual(NONE)
    })

    it('consumed marker: dispatches only when consumed_at is MORE than 5 minutes old', async () => {
      for (const [age, expected] of [
        ['1 minute', NONE],
        ['4 minutes 59 seconds', NONE],
        ['5 minutes', NONE],
        ['5 minutes 1 second', ONE],
        ['2 hours', ONE],
      ] as const)
        expect(await counts(ctx, [consumedAgo('c1', age)]), `consumed ${age} ago`).toEqual(expected)
      const r = await inTxn(ctx.ctl(), [
        patSecret(),
        consumedAgo('c1', '10 minutes'),
        RESUME,
        `SELECT 'gate=' || (metadata->>'gate') || ',state=' || (metadata->>'marker_state') ` +
          `FROM audit_logs WHERE event_type = '${DISPATCH}';`,
      ])
      expect(r.lines).toEqual(['gate=consumed_over_5m,state=consumed'])
    })

    it.each([
      ['missing', {}],
      ['unparseable', { consumed_at: q('not a time') }],
      ['in the future', { consumed_at: q('9999-01-01') }],
      ['infinity', { consumed_at: q('infinity') }],
    ] as Array<[string, Record<string, string>]>)(
      'a %s consumed_at falls back to created_at: 10 minutes old dispatches, 1 minute old waits',
      async (_label, fields) => {
        expect(
          await counts(ctx, [marker('c1', { state: 'consumed', created: '10 minutes', fields })])
        ).toEqual(ONE)
        expect(
          await counts(ctx, [marker('c1', { state: 'consumed', created: '1 minute', fields })])
        ).toEqual(NONE)
      }
    )

    it('a consumed marker with an EMPTY or blank dispatched_run_id is still live; a real one is not', async () => {
      for (const [value, expected] of [
        ['', ONE],
        ['   ', ONE],
        ['987', NONE],
      ] as const)
        expect(
          await counts(ctx, [
            consumedAgo('c1', '1 hour', { fields: { dispatched_run_id: q(value) } }),
          ]),
          `dispatched_run_id ${JSON.stringify(value)}`
        ).toEqual(expected)
    })

    it('several live markers: one dispatch, naming the OLDEST one that is due', async () => {
      const r = await inTxn(ctx.ctl(), [
        patSecret(),
        openAt('m1', '1 hour', { created: '3 hours' }), // oldest, not due
        openAt('m2', DUE, { created: '2 hours' }), // oldest due
        openAt('m3', DUE, { created: '1 hour' }),
        RESUME,
        ...SUMMARY,
        `SELECT 'marker=' || (metadata->>'marker_id') FROM audit_logs WHERE event_type = '${DISPATCH}';`,
      ])
      expect(r.lines).toEqual([...ONE, 'marker=m2'])
    })

    it('sends exactly the dispatch the workflow validates: URL, ref, inputs, headers, timeout', async () => {
      const r = await inTxn(ctx.ctl(), [
        patSecret(),
        openAt('m1', DUE, { env: 'prod' }),
        RESUME,
        posts,
        "SELECT 'url=' || url FROM net.calls;",
        "SELECT 'toplevel=' || (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(body) k) FROM net.calls;",
        "SELECT 'ref=' || (body->>'ref') FROM net.calls;",
        "SELECT 'inputkeys=' || (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(body->'inputs') k) FROM net.calls;",
        "SELECT 'mode=' || (body->'inputs'->>'mode') FROM net.calls;",
        // the workflow requires the STRING 'false', not a JSON boolean
        "SELECT 'verify_only=' || (body->'inputs'->>'verify_only') || ':' || jsonb_typeof(body->'inputs'->'verify_only') FROM net.calls;",
        "SELECT 'source=' || (body->'inputs'->>'resume_source') FROM net.calls;",
        "SELECT 'auth=' || (headers->>'Authorization') FROM net.calls;",
        "SELECT 'accept=' || (headers->>'Accept') FROM net.calls;",
        "SELECT 'apiversion=' || (headers->>'X-GitHub-Api-Version') FROM net.calls;",
        "SELECT 'ua=' || (headers->>'User-Agent') FROM net.calls;",
        "SELECT 'ctype=' || (headers->>'Content-Type') FROM net.calls;",
        "SELECT 'timeout=' || timeout_milliseconds FROM net.calls;",
      ])
      expect(r.lines).toEqual([
        'posts=1',
        `url=${DISPATCH_URL}`,
        'toplevel=inputs,ref',
        'ref=main',
        'inputkeys=mode,resume_source,verify_only',
        'mode=resume',
        'verify_only=false:string',
        'source=pg_cron-prod',
        `auth=Bearer ${PAT}`,
        'accept=application/vnd.github+json',
        'apiversion=2022-11-28',
        'ua=skillsmith-pg-cron',
        'ctype=application/json',
        'timeout=30000',
      ])
    })

    it('writes one dispatch row tied to the request, and the PAT appears in no audit row', async () => {
      const r = await inTxn(ctx.ctl(), [
        patSecret(),
        openAt('m1', DUE),
        RESUME,
        `SELECT 'row=' || concat_ws(',', actor, action, result, metadata->>'marker_id', ` +
          `metadata->>'marker_state', metadata->>'resume_source', metadata->>'gate') ` +
          `FROM audit_logs WHERE event_type = '${DISPATCH}';`,
        `SELECT 'idmatch=' || count(*) FROM audit_logs a JOIN net.calls c ` +
          `ON (a.metadata->>'net_request_id')::bigint = c.id WHERE a.event_type = '${DISPATCH}';`,
        // positive control: the PAT IS in the request headers, so the next count can be non-zero
        `SELECT 'in_request=' || count(*) FROM net.calls WHERE headers::text LIKE '%${PAT}%';`,
        `SELECT 'in_audit=' || count(*) FROM audit_logs WHERE metadata::text LIKE '%${PAT}%';`,
      ])
      expect(r.lines).toEqual([
        'row=pg_cron,dispatch,queued,m1,open,pg_cron-staging,open_window_passed',
        'idmatch=1',
        'in_request=1',
        'in_audit=0',
      ])
    })

    it('never writes a marker: the marker rows are identical before and after, dispatched or not', async () => {
      for (const seed of [openAt('m1', DUE), openAt('m1', '1 hour'), consumedAgo('c1', '1 hour')]) {
        const r = await inTxn(ctx.ctl(), [
          patSecret(),
          seed,
          markerHash('before'),
          RESUME,
          markerHash('after'),
        ])
        expect(r.lines[0]).not.toBe('before=none')
        expect(r.lines[1]).toBe(r.lines[0].replace('before=', 'after='))
      }
    })

    it("resume_source is the project's own supabase_env, sanitised and capped inside the workflow charset", async () => {
      for (const [env, expected] of [
        ['prod', 'pg_cron-prod'],
        ['staging', 'pg_cron-staging'],
        [null, 'pg_cron-unknown'],
        ['', 'pg_cron-unknown'],
        ['a b/c$d;e', 'pg_cron-abcde'],
        ['x'.repeat(100), `pg_cron-${'x'.repeat(40)}`],
      ] as Array<[string | null, string]>) {
        const r = await inTxn(ctx.ctl(), [
          patSecret(),
          openAt('m1', DUE, { env }),
          RESUME,
          "SELECT 'source=' || (body->'inputs'->>'resume_source') FROM net.calls;",
          `SELECT 'row=' || (metadata->>'resume_source') FROM audit_logs WHERE event_type = '${DISPATCH}';`,
        ])
        const sent = r.lines[0].slice('source='.length)
        expect(sent, `env ${JSON.stringify(env)}`).toBe(expected)
        expect(r.lines[1]).toBe(`row=${expected}`)
        expect(sent).toMatch(/^[A-Za-z0-9._-]{0,64}$/)
      }
    })

    it('a PAT with surrounding whitespace or a trailing newline is trimmed in the header', async () => {
      const r = await inTxn(ctx.ctl(), [
        vault([PAT_SECRET, `  ${PAT}\n`]),
        openAt('m1', DUE),
        RESUME,
        "SELECT 'auth=' || (headers->>'Authorization') FROM net.calls;",
      ])
      expect(r.lines).toEqual([`auth=Bearer ${PAT}`])
    })

    it.each([
      ['missing', ''],
      ['empty', vault([PAT_SECRET, ''])],
      ['blank', vault([PAT_SECRET, '   '])],
    ])(
      'PAT %s: one resume_error row, no request, no dispatch row, a WARNING and no exception',
      async (_label, seed) => {
        const r = await inTxn(ctx.ctl(), [
          seed,
          openAt('m1', DUE),
          RESUME,
          ...SUMMARY,
          `SELECT 'row=' || concat_ws(',', actor, result, metadata->>'missing_secret', ` +
            `metadata->>'marker_id', metadata->>'marker_state', metadata->>'gate') ` +
            `FROM audit_logs WHERE event_type = '${RESUME_ERROR}';`,
        ])
        expect(r.lines).toEqual([
          'posts=0',
          'dispatches=0',
          'errors=1',
          `row=pg_cron,error,${PAT_SECRET},m1,open,open_window_passed`,
        ])
        expect(r.stderr).toMatch(new RegExp(`WARNING:.*${PAT_SECRET}`))
      }
    )

    it('an http_post that raises leaves a resume_error row (reason http_post failed), no dispatch row, no exception', async () => {
      const r = await inTxn(ctx.ctl(), [
        patSecret(),
        openAt('m1', DUE),
        // Same signature and defaults as the stub, so CREATE OR REPLACE is accepted; rolled back with the txn.
        `CREATE OR REPLACE FUNCTION net.http_post(url TEXT, body JSONB DEFAULT '{}'::jsonb,
           params JSONB DEFAULT '{}'::jsonb,
           headers JSONB DEFAULT '{"Content-Type": "application/json"}'::jsonb,
           timeout_milliseconds INTEGER DEFAULT 5000) RETURNS BIGINT
           LANGUAGE plpgsql AS $h$ BEGIN RAISE EXCEPTION 'pg_net is unavailable'; END $h$;`,
        RESUME,
        ...SUMMARY,
        `SELECT 'reason=' || (metadata->>'reason') FROM audit_logs WHERE event_type = '${RESUME_ERROR}';`,
        `SELECT 'leak=' || count(*) FROM audit_logs WHERE metadata::text LIKE '%${PAT}%';`,
      ])
      expect(r.lines).toEqual([
        'posts=0',
        'dispatches=0',
        'errors=1',
        'reason=http_post failed: pg_net is unavailable',
        'leak=0',
      ])
      expect(r.stderr).toMatch(/WARNING:.*net\.http_post failed/)
    })

    it.each([
      ['1', 0],
      ['true', 0],
      [' TRUE ', 0],
      ['0', 1],
      ['false', 1],
      ['', 1],
    ] as Array<[string, number]>)('kill switch %j: %i dispatch(es)', async (value, expected) => {
      const r = await inTxn(ctx.ctl(), [
        patSecret(),
        vault([RESUME_KILL, value]),
        openAt('m1', DUE),
        RESUME,
        posts,
      ])
      expect(r.lines).toEqual([`posts=${expected}`])
    })

    it('the kill switch is checked before the PAT: set with no PAT, it writes no error row either', async () => {
      const r = await inTxn(ctx.ctl(), [
        vault([RESUME_KILL, '1']),
        openAt('m1', DUE),
        RESUME,
        ...SUMMARY,
      ])
      expect(r.lines).toEqual(NONE)
    })

    it('service_role can run it (the function is DEFINER, so it needs no table grant of its own)', async () => {
      const r = await inTxn(ctx.ctl(), [
        patSecret(),
        openAt('m1', DUE),
        AS('service_role'),
        RESUME,
        'RESET ROLE;',
        posts,
      ])
      expect(r.lines).toEqual(['posts=1'])
    })

    it('a repeated call with the marker still open dispatches again (no debounce; the workflow claim decides)', async () => {
      const r = await inTxn(ctx.ctl(), [patSecret(), openAt('m1', DUE), RESUME, RESUME, posts])
      expect(r.lines).toEqual(['posts=2'])
    })
  })

  describe('case 5: the dispatcher advisory lock -- two real sessions', () => {
    let a: PsqlSession
    let b: PsqlSession
    beforeAll(() => {
      a = new PsqlSession(requireTestConn(), 'A')
      b = new PsqlSession(requireTestConn(), 'B')
    })
    afterEach(async () => {
      // Never leave A's lock-holding transaction open for the next test.
      await a.send('ROLLBACK;')
      await b.send('ROLLBACK;')
      await ctx.ctl().send(fixtureSql())
    })
    afterAll(async () => {
      await a?.close()
      await b?.close()
    })

    it('while another session holds the dispatcher lock a call does nothing; once released, exactly one dispatch', async () => {
      const seed = await ctx.ctl().send([patSecret(), openAt('m1', DUE)].join('\n'))
      expect(seed.stderr, 'seed committed').not.toMatch(/ERROR/)

      const hold = await a.send(`BEGIN;\nSELECT pg_advisory_xact_lock(${LOCK_KEY});`)
      expect(hold.stderr).not.toMatch(/ERROR/)

      // B returns promptly (a try-lock, not a wait) and sends nothing.
      const blocked = await b.send(`${RESUME}\n${posts}\n${dispatches}`)
      expect(blocked.stderr).not.toMatch(/ERROR/)
      expect(lines(blocked)).toEqual(['posts=0', 'dispatches=0'])

      // Positive control: the same call, lock released, DOES dispatch -- once.
      await a.send('ROLLBACK;')
      const free = await b.send(`${RESUME}\n${posts}\n${dispatches}`)
      expect(free.stderr).not.toMatch(/ERROR/)
      expect(lines(free)).toEqual(['posts=1', 'dispatches=1'])
    })

    it("the lock key is the dispatcher's own: holding the WATCHER's key does not block it", async () => {
      await ctx.ctl().send([patSecret(), openAt('m1', DUE)].join('\n'))
      await a.send(
        "BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('check_backfill_autochain_markers', 0));"
      )
      const r = await b.send(`${RESUME}\n${posts}`)
      expect(r.stderr).not.toMatch(/ERROR/)
      expect(lines(r)).toEqual(['posts=1'])
    })
  })
}
