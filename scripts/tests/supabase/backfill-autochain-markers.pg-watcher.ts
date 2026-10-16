/**
 * SMI-7121 plan Verification 6b: check_backfill_autochain_markers(), the stale-marker watcher.
 * Registered from ./backfill-autochain-markers.pg.test.ts. Every arm seeds and calls inside one
 * transaction, so every age boundary is exact. The two-session lock arm lives in
 * ./backfill-autochain-markers.pg-concurrency.ts.
 *
 * @module scripts/tests/supabase/backfill-autochain-markers.pg-watcher
 */

import { describe, it, expect } from 'vitest'
import {
  ALERT,
  BASE_URL,
  KILL_SWITCH,
  SENT,
  SERVICE_KEY,
  WATCH,
  WATCH_ERROR,
  alertRow,
  count,
  inTxn,
  markerRow,
  responseRow,
  standardSecrets,
  vault,
  type Ctx,
} from './backfill-autochain-markers.test-helpers.ts'

const posts = count('posts', 'net.calls')
const alerts = count('alerts', `audit_logs WHERE event_type = '${ALERT}'`)
const errors = count('errors', `audit_logs WHERE event_type = '${WATCH_ERROR}'`)
const SUMMARY = [posts, alerts, errors]

const STALLED = '12 hours 30 minutes'
/** An unreconciled consumed marker: consumed 2h ago, never dispatched. */
const consumedMeta = (consumedAt: string) => ({ state: 'consumed', consumed_at: consumedAt })

export function registerWatcherTests(ctx: Ctx): void {
  describe('case 4: check_backfill_autochain_markers() watcher', () => {
    it('no markers: no POST, no rows', async () => {
      const r = await inTxn(ctx.ctl(), [standardSecrets(), WATCH, ...SUMMARY])
      expect(r.lines).toEqual(['posts=0', 'alerts=0', 'errors=0'])
    })

    it('stalled: an open marker older than 12h sends one alert with the right URL, type, auth, message and row', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        markerRow('m1', STALLED, { completed_run_id: '38926290288', supabase_env: 'production' }),
        WATCH,
        posts,
        "SELECT 'url=' || url FROM net.calls;",
        "SELECT 'type=' || (body->>'type') FROM net.calls;",
        "SELECT 'auth=' || (headers->>'Authorization') FROM net.calls;",
        "SELECT 'timeout=' || timeout_milliseconds FROM net.calls;",
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
        alerts,
        `SELECT 'row=' || concat_ws(',', metadata->>'marker_id', metadata->>'kind', ` +
          `metadata->>'completed_run_id', actor) FROM audit_logs WHERE event_type = '${ALERT}';`,
        `SELECT 'idmatch=' || count(*) FROM audit_logs a JOIN net.calls c ` +
          `ON (a.metadata->>'net_request_id')::bigint = c.id WHERE a.event_type = '${ALERT}';`,
      ])
      expect(r.lines.slice(0, 4)).toEqual([
        'posts=1',
        `url=${BASE_URL}/functions/v1/alert-notify`,
        'type=indexer_backfill_autochain_stalled',
        `auth=Bearer ${SERVICE_KEY}`,
      ])
      expect(r.lines[4]).toBe('timeout=30000')
      const msg = r.lines[5]
      for (const part of [
        'm1',
        '38926290288',
        'production',
        'state open',
        '12:30:00',
        'backfill-autochain-handover.md',
        'A deferred chain did not resume',
      ])
        expect(msg, `message names ${part}`).toContain(part)
      expect(r.lines.slice(6)).toEqual([
        'alerts=1',
        'row=m1,stalled,38926290288,pg_cron',
        'idmatch=1',
      ])
    })

    it('stalled boundary: 12h exactly is silent, 1 microsecond over alerts', async () => {
      for (const [when, expected] of [
        ['2 hours', 0],
        ['12 hours', 0],
        ['12 hours 1 microsecond', 1],
      ] as const) {
        const r = await inTxn(ctx.ctl(), [standardSecrets(), markerRow('m1', when), WATCH, posts])
        expect(r.lines, `open marker ${when} old`).toEqual([`posts=${expected}`])
      }
    })

    it('unreconciled: a consumed marker with no dispatched_run_id, consumed over 1h ago, alerts', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        // consumed_at (2h ago) decides; the next arm shows created_at does not.
        "INSERT INTO audit_logs (id, event_type, metadata, created_at) VALUES ('m1', " +
          "'indexer_backfill_autochain_deferred', jsonb_build_object('state', 'consumed', " +
          "'completed_run_id', 'r1', 'supabase_env', 'staging', 'consumed_at', " +
          "(now() - interval '2 hours')::text), now() - interval '3 hours');",
        WATCH,
        posts,
        "SELECT 'type=' || (body->>'type') FROM net.calls;",
        "SELECT 'section=' || (body->>'message' LIKE '%Resume after a failed resume dispatch%') FROM net.calls;",
        `SELECT 'kind=' || (metadata->>'kind') FROM audit_logs WHERE event_type = '${ALERT}';`,
      ])
      expect(r.lines).toEqual([
        'posts=1',
        'type=indexer_backfill_autochain_unreconciled',
        'section=true',
        'kind=unreconciled',
      ])
    })

    it('unreconciled is keyed on consumed_at, not created_at: an old marker consumed 10 minutes ago is silent', async () => {
      const seed = (consumedAgo: string) =>
        "INSERT INTO audit_logs (id, event_type, metadata, created_at) VALUES ('m1', " +
        "'indexer_backfill_autochain_deferred', jsonb_build_object('state', 'consumed', " +
        `'consumed_at', (now() - interval '${consumedAgo}')::text), now() - interval '20 hours');`
      for (const [consumedAgo, expected] of [
        ['10 minutes', 0],
        ['1 hour', 0],
        ['1 hour 1 second', 1],
      ] as const) {
        const r = await inTxn(ctx.ctl(), [standardSecrets(), seed(consumedAgo), WATCH, posts])
        expect(r.lines, `consumed ${consumedAgo} ago`).toEqual([`posts=${expected}`])
      }
    })

    it.each([
      ['missing', {}],
      ['unparseable', { consumed_at: 'not a time' }],
      ['JSON null', { consumed_at: null }],
    ] as Array<[string, Record<string, unknown>]>)(
      'consumed_at %s falls back to created_at (fail toward alerting) and does not raise',
      async (_label, meta) => {
        const old = await inTxn(ctx.ctl(), [
          standardSecrets(),
          markerRow('m1', '2 hours', { state: 'consumed', ...meta }),
          WATCH,
          posts,
        ])
        expect(old.lines, 'created 2h ago: alerts').toEqual(['posts=1'])
        const fresh = await inTxn(ctx.ctl(), [
          standardSecrets(),
          markerRow('m1', '30 minutes', { state: 'consumed', ...meta }),
          WATCH,
          posts,
        ])
        expect(fresh.lines, 'created 30m ago: silent').toEqual(['posts=0'])
      }
    )

    it('not watched: a dispatched or needs_intervention marker, a consumed marker with a dispatched_run_id, and a fresh open one', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        markerRow('d1', '30 hours', { state: 'dispatched' }),
        markerRow('n1', '30 hours', { state: 'needs_intervention' }),
        markerRow('c1', '30 hours', {
          ...consumedMeta('2020-01-01T00:00:00Z'),
          dispatched_run_id: '9',
        }),
        markerRow('o1', '1 hour'),
        WATCH,
        posts,
        // Control: one stale open marker beside them is alerted, so the 0 is not a dead watcher.
        markerRow('o2', STALLED),
        WATCH,
        posts,
        `SELECT 'marker=' || (metadata->>'marker_id') FROM audit_logs WHERE event_type = '${ALERT}';`,
      ])
      expect(r.lines).toEqual(['posts=0', 'posts=1', 'marker=o2'])
    })

    it('an empty dispatched_run_id counts as missing (fail toward alerting)', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        markerRow('c1', '3 hours', {
          ...consumedMeta('2020-01-01T00:00:00Z'),
          dispatched_run_id: '',
        }),
        WATCH,
        posts,
      ])
      expect(r.lines).toEqual(['posts=1'])
    })

    it('two stale markers each get their own alert in one tick', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        markerRow('m1', STALLED),
        markerRow('m2', '13 hours'),
        WATCH,
        posts,
        `SELECT string_agg(metadata->>'marker_id', ',' ORDER BY metadata->>'marker_id') FROM audit_logs WHERE event_type = '${ALERT}';`,
      ])
      expect(r.lines).toEqual(['posts=2', 'm1,m2'])
    })

    // [label, prior alert response (null = none), prior harvested result (undefined = not harvested),
    //  prior alert age, expected NEW posts]. A "response" row is harvested by the same tick before
    // dedup runs, so these arms drive the harvested-result branch end to end; the live-response
    // branch is reached only when a response lands between the harvest and the dedup read, which a
    // single session cannot stage (it is pinned structurally instead).
    type Outcome = [
      string,
      [number | null, string | null] | null,
      { status: number | null; sent: string | null } | undefined,
      string,
      number,
    ]
    const outcomes: Outcome[] = [
      ['response delivered (2xx, sent true)', [200, SENT], undefined, '2 hours', 0],
      ['harvested delivered, 23h old', null, { status: 200, sent: 'true' }, '23 hours', 0],
      [
        'harvested delivered, 25h old: outside the 24h dedup',
        null,
        { status: 200, sent: 'true' },
        '25 hours',
        1,
      ],
      ['response 2xx but sent false', [200, '{"data":{"sent":false}}'], undefined, '2 hours', 1],
      ['response 2xx with no data.sent', [200, '{"ok":true}'], undefined, '2 hours', 1],
      ['response non-2xx even if the body says sent', [500, SENT], undefined, '2 hours', 1],
      ['response transport failure (NULL status)', [null, null], undefined, '2 hours', 1],
      [
        'response 2xx with a non-JSON body (no error)',
        [200, 'not json <html>'],
        undefined,
        '2 hours',
        1,
      ],
      ['harvested non-2xx', null, { status: 500, sent: 'true' }, '2 hours', 1],
      ['harvested sent false', null, { status: 200, sent: 'false' }, '2 hours', 1],
      [
        'harvested transport failure (null status, key present)',
        null,
        { status: null, sent: null },
        '2 hours',
        1,
      ],
      ['no response, 30 minutes old: pending', null, undefined, '30 minutes', 0],
      ['no response, 59 minutes old: still pending', null, undefined, '59 minutes', 0],
      ['no response, exactly 1 hour old: not pending', null, undefined, '1 hour', 1],
      ['no response, 2 hours old', null, undefined, '2 hours', 1],
    ]
    it.each(
      outcomes.map((o) => [`prior alert ${o[0]} -> ${o[4]} new POST`, ...o.slice(1)] as Outcome)
    )('dedup: %s', async (_label, resp, harvested, alertAge, expected) => {
      const RID = 9001
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        markerRow('m1', '30 hours'),
        alertRow('m1', 'stalled', alertAge, RID, harvested ? { harvested } : {}),
        ...(resp ? [responseRow(RID, resp[0], { content: resp[1] })] : []),
        WATCH,
        ...SUMMARY,
      ])
      expect(r.lines).toEqual([`posts=${expected}`, `alerts=${1 + expected}`, 'errors=0'])
    })

    it('dedup is per (marker, kind): a delivered alert for another marker or another kind does not suppress', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        markerRow('m1', '30 hours'),
        alertRow('other', 'stalled', '2 hours', 9101, { harvested: { status: 200, sent: 'true' } }),
        alertRow('m1', 'unreconciled', '2 hours', 9102, {
          harvested: { status: 200, sent: 'true' },
        }),
        WATCH,
        posts,
      ])
      expect(r.lines).toEqual(['posts=1'])
    })

    describe('harvest: a delivered alert keeps suppressing after pg_net purges its response', () => {
      const PURGE = 'DELETE FROM net._http_response;' // pg_net's 6h TTL purge

      it('the tick copies status_code and sent into the alert row, once', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          markerRow('m1', '30 hours'),
          alertRow('m1', 'stalled', '2 hours', 9201),
          responseRow(9201, 200, { content: SENT }),
          WATCH,
          `SELECT 'harvested=' || (metadata->>'status_code') || ',' || (metadata->>'sent') FROM audit_logs WHERE event_type = '${ALERT}';`,
          posts,
        ])
        expect(r.lines).toEqual(['harvested=200,true', 'posts=0'])
      })

      it('delivered, harvested by one tick, then purged: the next tick still does not re-alert', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          markerRow('m1', '30 hours'),
          alertRow('m1', 'stalled', '2 hours', 9202),
          responseRow(9202, 200, { content: SENT }),
          WATCH,
          PURGE,
          WATCH,
          posts,
        ])
        expect(r.lines).toEqual(['posts=0'])
      })

      it('control: delivered but purged BEFORE any tick harvested it: the next tick re-alerts', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          markerRow('m1', '30 hours'),
          alertRow('m1', 'stalled', '2 hours', 9203),
          responseRow(9203, 200, { content: SENT }),
          PURGE,
          WATCH,
          posts,
        ])
        expect(r.lines).toEqual(['posts=1'])
      })

      it('parses sent per row: a non-JSON body harvests as null and does not abort the other rows', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          alertRow('a', 'stalled', '2 hours', 9210),
          responseRow(9210, 200, { content: 'not json <html>' }),
          alertRow('b', 'stalled', '2 hours', 9211),
          responseRow(9211, 200, { content: SENT }),
          alertRow('c', 'stalled', '2 hours', 9212),
          responseRow(9212, null),
          WATCH,
          `SELECT (metadata->>'marker_id') || ':' || coalesce(metadata->>'status_code', 'NULL') || ':' || ` +
            `coalesce(metadata->>'sent', 'NULL') || ':' || (metadata ? 'status_code') ` +
            `FROM audit_logs WHERE event_type = '${ALERT}' ORDER BY 1;`,
        ])
        expect(r.lines).toEqual(['a:200:NULL:true', 'b:200:true:true', 'c:NULL:NULL:true'])
      })

      it('a harvested "not delivered" result is authoritative over a later live "delivered" response', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          markerRow('m1', '30 hours'),
          alertRow('m1', 'stalled', '2 hours', 9220, { harvested: { status: 500, sent: null } }),
          responseRow(9220, 200, { content: SENT }),
          WATCH,
          posts,
        ])
        expect(r.lines).toEqual(['posts=1'])
      })

      it('ignores alerts older than 24h and alerts with an unparseable request id, without raising', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          alertRow('a', 'stalled', '25 hours', 9230),
          responseRow(9230, 200, { content: SENT }),
          alertRow('b', 'stalled', '2 hours', 'abc'),
          WATCH,
          `SELECT 'harvested=' || count(*) FROM audit_logs WHERE event_type = '${ALERT}' AND metadata ? 'status_code';`,
        ])
        expect(r.lines).toEqual(['harvested=0'])
      })
    })

    it('the vault kill switch silences the watcher; any other value leaves it enabled', async () => {
      for (const [value, expected] of [
        ['1', 0],
        ['true', 0],
        ['TRUE', 0],
        [' 1 ', 0],
        ['0', 1],
        ['false', 1],
        ['', 1],
      ] as const) {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          vault([KILL_SWITCH, value]),
          markerRow('m1', STALLED),
          WATCH,
          ...SUMMARY,
        ])
        expect(r.lines, `kill switch = ${JSON.stringify(value)}`).toEqual([
          `posts=${expected}`,
          `alerts=${expected}`,
          'errors=0',
        ])
      }
    })

    it.each([
      [
        'both alert secrets',
        [],
        'refresh_metadata_functions_base_url, refresh_metadata_service_role_key',
      ],
      [
        'the service-role key',
        [['refresh_metadata_functions_base_url', BASE_URL]],
        'refresh_metadata_service_role_key',
      ],
      [
        'the base url',
        [['refresh_metadata_service_role_key', SERVICE_KEY]],
        'refresh_metadata_functions_base_url',
      ],
      [
        'a blank key',
        [
          ['refresh_metadata_functions_base_url', BASE_URL],
          ['refresh_metadata_service_role_key', '   '],
        ],
        'refresh_metadata_service_role_key',
      ],
    ] as Array<[string, Array<[string, string]>, string]>)(
      'missing %s: one error row naming it, no POST, no exception',
      async (_label, secrets, missing) => {
        const r = await inTxn(ctx.ctl(), [
          ...(secrets.length ? [vault(...secrets)] : []),
          markerRow('m1', STALLED),
          markerRow('m2', STALLED),
          WATCH,
          ...SUMMARY,
          `SELECT 'missing=' || (metadata->>'missing_secret') FROM audit_logs WHERE event_type = '${WATCH_ERROR}';`,
        ])
        expect(r.lines).toEqual(['posts=0', 'alerts=0', 'errors=1', `missing=${missing}`])
        expect(r.stderr, 'warned, did not raise').toMatch(/cannot alert/)
      }
    )

    it('missing secrets with nothing to send: no error row (the secrets are read only when an alert is due)', async () => {
      const r = await inTxn(ctx.ctl(), [markerRow('m1', '1 hour'), WATCH, ...SUMMARY])
      expect(r.lines).toEqual(['posts=0', 'alerts=0', 'errors=0'])
    })
  })
}
