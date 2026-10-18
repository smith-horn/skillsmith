/**
 * SMI-7142 plan D5: the stale-marker watcher check_backfill_autochain_markers() as extended by
 * 20261017000000 -- the harvest of the resume dispatcher's pg_net responses and the new
 * resume_dispatch_failed alert kind. Registered from ./backfill-autochain-resume.pg.test.ts. Every
 * arm seeds and calls inside one transaction. The SMI-7121 arms (stalled/unreconciled, locking,
 * dedup of those kinds) stay in backfill-autochain-markers.pg-watcher.ts and run against the same
 * latest body when that suite is pointed at this migration's database.
 *
 * @module scripts/tests/supabase/backfill-autochain-resume.pg-watcher
 */

import { describe, it, expect } from 'vitest'
import {
  ALERT,
  BASE_URL,
  DISPATCH,
  PAT_SECRET,
  RESUME_ERROR,
  SENT,
  WATCH,
  WATCH_ERROR,
  WATCH_KILL,
  auditRow,
  count,
  inTxn,
  marker,
  posts,
  q,
  responseRow,
  standardSecrets,
  vault,
  type Ctx,
} from './backfill-autochain-resume.test-helpers.ts'

const alerts = count('alerts', `audit_logs WHERE event_type = '${ALERT}'`)
const watchErrors = count('watch_errors', `audit_logs WHERE event_type = '${WATCH_ERROR}'`)
const TYPE_FAILED = 'indexer_backfill_autochain_resume_dispatch_failed'
const KIND = 'resume_dispatch_failed'
const BAD_CREDS = '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}'

interface Harvested {
  status: number | null
  body?: string | null
  error?: string | null
}

/** A dispatcher row. `harvested` present means the status_code KEY exists (null = transport failure). */
export const dispatchRow = (
  when: string,
  rid: number,
  o: { marker?: string; harvested?: Harvested } = {}
): string => {
  const h = o.harvested
  const extra = h
    ? `, 'status_code', ${h.status === null ? 'NULL::integer' : h.status}, ` +
      `'body', ${h.body == null ? 'NULL::text' : q(h.body)}, ` +
      `'error_msg', ${h.error == null ? 'NULL::text' : q(h.error)}`
    : ''
  return auditRow(
    DISPATCH,
    when,
    `jsonb_build_object('net_request_id', ${rid}::bigint, 'marker_id', ${q(o.marker ?? 'm1')}, ` +
      `'marker_state', 'open', 'resume_source', 'pg_cron-staging', 'gate', 'open_window_passed'${extra})`
  )
}

/** A dispatcher error row (missing PAT, or http_post raised). */
const errorRow = (
  when: string,
  o: { marker?: string; missing?: string; reason?: string }
): string =>
  auditRow(
    RESUME_ERROR,
    when,
    `jsonb_build_object('marker_id', ${q(o.marker ?? 'm1')}` +
      `${o.missing ? `, 'missing_secret', ${q(o.missing)}` : ''}` +
      `${o.reason ? `, 'reason', ${q(o.reason)}` : ''})`
  )

/** A prior watcher alert for (marker, kind); `harvested` adds the status_code/sent keys. */
const alertRow = (
  markerId: string,
  kind: string,
  when: string,
  rid: number,
  harvested?: { status: number | null; sent: string | null }
): string => {
  const extra = harvested
    ? `, 'status_code', ${harvested.status === null ? 'NULL::integer' : harvested.status}, ` +
      `'sent', ${harvested.sent === null ? 'NULL::text' : q(harvested.sent)}`
    : ''
  return auditRow(
    ALERT,
    when,
    `jsonb_build_object('marker_id', ${q(markerId)}, 'kind', ${q(kind)}, ` +
      `'net_request_id', ${rid}::bigint${extra})`
  )
}

const summary = [posts, alerts, watchErrors]
/** Per-dispatch-row harvest result, one line each, ordered by request id. */
const harvestLines =
  `SELECT 'r' || (metadata->>'net_request_id') || '=' || (metadata ? 'status_code') || '|' || ` +
  `coalesce(metadata->>'status_code', 'null') || '|' || coalesce(metadata->>'workflow_run_id', 'null') ` +
  `|| '|' || coalesce(metadata->>'error_msg', 'null') || '|' || coalesce(metadata->>'timed_out', 'null') ` +
  `FROM audit_logs WHERE event_type = '${DISPATCH}' ORDER BY (metadata->>'net_request_id')::bigint;`

export function registerResumeWatcherTests(ctx: Ctx): void {
  describe('case 7: watcher harvest of resume_dispatch rows', () => {
    it('copies status, run id, error text and timeout per row; an unanswered row stays unharvested', async () => {
      const r = await inTxn(ctx.ctl(), [
        vault([WATCH_KILL, '1']), // the harvest runs ahead of the switch
        dispatchRow('10 minutes', 101),
        dispatchRow('10 minutes', 102),
        dispatchRow('10 minutes', 103),
        dispatchRow('10 minutes', 104),
        dispatchRow('10 minutes', 105),
        responseRow(101, 401, { content: BAD_CREDS }),
        responseRow(102, 204, { content: '' }),
        responseRow(103, 200, { content: '{"workflow_run_id": 4242}' }),
        responseRow(105, null, { error: 'Timeout of 30000 ms reached', timedOut: true }),
        WATCH,
        harvestLines,
        `SELECT 'body101=' || (metadata->>'body') FROM audit_logs WHERE metadata->>'net_request_id' = '101';`,
        `SELECT 'sent_keys=' || count(*) FROM audit_logs WHERE event_type = '${DISPATCH}' AND metadata ? 'sent';`,
        posts,
      ])
      expect(r.lines).toEqual([
        'r101=true|401|null|null|false',
        'r102=true|204|null|null|false',
        'r103=true|200|4242|null|false',
        'r104=false|null|null|null|null',
        'r105=true|null|null|Timeout of 30000 ms reached|true',
        `body101=${BAD_CREDS}`,
        'sent_keys=0',
        'posts=0',
      ])
    })

    it('truncates the stored body to 300 characters and the error text to 200', async () => {
      const r = await inTxn(ctx.ctl(), [
        vault([WATCH_KILL, '1']),
        dispatchRow('10 minutes', 101),
        responseRow(101, 502, { content: 'x'.repeat(1000), error: 'e'.repeat(500) }),
        WATCH,
        "SELECT 'lens=' || length(metadata->>'body') || ',' || length(metadata->>'error_msg') FROM audit_logs WHERE event_type = '" +
          `${DISPATCH}';`,
      ])
      expect(r.lines).toEqual(['lens=300,200'])
    })

    it('harvests a row once: a later change to the pg_net response does not overwrite it', async () => {
      const r = await inTxn(ctx.ctl(), [
        vault([WATCH_KILL, '1']),
        dispatchRow('10 minutes', 101),
        responseRow(101, 401, { content: BAD_CREDS }),
        WATCH,
        'UPDATE net._http_response SET status_code = 200 WHERE id = 101;',
        WATCH,
        harvestLines,
      ])
      expect(r.lines).toEqual(['r101=true|401|null|null|false'])
    })

    it('still harvests an alert row exactly as before: status_code and sent, no body', async () => {
      const r = await inTxn(ctx.ctl(), [
        vault([WATCH_KILL, '1']),
        alertRow('m1', 'stalled', '10 minutes', 201),
        responseRow(201, 200, { content: SENT }),
        WATCH,
        `SELECT 'alert=' || (metadata->>'status_code') || ',' || (metadata->>'sent') || ',' || ` +
          `(metadata ? 'body') FROM audit_logs WHERE event_type = '${ALERT}';`,
      ])
      expect(r.lines).toEqual(['alert=200,true,false'])
    })
  })

  describe('case 8: watcher kind resume_dispatch_failed', () => {
    it('a refused dispatch is harvested and alerted in one tick, with the right URL, type, auth, message and row', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        marker('m1', { created: '30 minutes' }),
        dispatchRow('10 minutes', 101),
        responseRow(101, 401, { content: BAD_CREDS }),
        WATCH,
        posts,
        "SELECT 'url=' || url FROM net.calls;",
        "SELECT 'type=' || (body->>'type') FROM net.calls;",
        "SELECT 'auth=' || (headers->>'Authorization') FROM net.calls;",
        "SELECT 'timeout=' || timeout_milliseconds FROM net.calls;",
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
        `SELECT 'row=' || concat_ws(',', metadata->>'marker_id', metadata->>'kind', ` +
          `metadata->>'completed_run_id', metadata->>'row_locked', metadata->>'failure_event') ` +
          `FROM audit_logs WHERE event_type = '${ALERT}';`,
        `SELECT 'idmatch=' || count(*) FROM audit_logs a JOIN net.calls c ` +
          `ON (a.metadata->>'net_request_id')::bigint = c.id WHERE a.event_type = '${ALERT}';`,
      ])
      expect(r.lines.slice(0, 5)).toEqual([
        'posts=1',
        `url=${BASE_URL}/functions/v1/alert-notify`,
        `type=${TYPE_FAILED}`,
        'auth=Bearer key-123',
        'timeout=30000',
      ])
      const msg = r.lines[5]
      for (const part of [
        'm1',
        'HTTP 401',
        'Bad credentials',
        'backfill-autochain-handover.md',
        'section "`resume_dispatch_failed`"',
      ])
        expect(msg, `message names ${part}`).toContain(part)
      expect(r.lines.slice(6)).toEqual([`row=m1,${KIND},run-m1,false,${DISPATCH}`, 'idmatch=1'])
    })

    it.each([
      [200, 0],
      [202, 0],
      [204, 0],
      [299, 0],
      [199, 1],
      [300, 1],
      [404, 1],
      [422, 1],
      [500, 1],
    ])('harvested status %i: %i alert(s)', async (status, expected) => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('10 minutes', 101, { harvested: { status } }),
        WATCH,
        posts,
      ])
      expect(r.lines).toEqual([`posts=${expected}`])
    })

    it('a dispatch with no response yet is not a failure while under 1 hour old', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('30 minutes', 101), // no response row and no status_code key
        WATCH,
        ...summary,
      ])
      expect(r.lines).toEqual(['posts=0', 'alerts=0', 'watch_errors=0'])
    })

    it('a null status (transport failure or timeout) alerts and names the error text, or says there is none', async () => {
      const withError = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('10 minutes', 101, {
          harvested: { status: null, error: 'Timeout of 30000 ms reached' },
        }),
        WATCH,
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
      ])
      expect(withError.lines[0]).toContain('no HTTP status (Timeout of 30000 ms reached)')
      const without = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('10 minutes', 101, { harvested: { status: null } }),
        WATCH,
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
      ])
      expect(without.lines[0]).toContain('no HTTP status (no error text)')
    })

    it('the lookback is 2 hours: a failure 1h59m old alerts, one 2h01m old does not', async () => {
      for (const [when, expected] of [
        ['1 hour 59 minutes', 1],
        ['2 hours 1 minute', 0],
      ] as const) {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          dispatchRow(when, 101, { harvested: { status: 401 } }),
          WATCH,
          posts,
        ])
        expect(r.lines, `failure ${when} old`).toEqual([`posts=${expected}`])
      }
    })

    it('a dispatcher error row alerts, naming the missing secret or the reason', async () => {
      const missing = await inTxn(ctx.ctl(), [
        standardSecrets(),
        errorRow('10 minutes', { missing: PAT_SECRET }),
        WATCH,
        posts,
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
      ])
      expect(missing.lines[0]).toBe('posts=1')
      expect(missing.lines[1]).toContain(`Vault secret ${PAT_SECRET} is missing`)
      const raised = await inTxn(ctx.ctl(), [
        standardSecrets(),
        errorRow('10 minutes', { reason: 'http_post failed: pg_net is unavailable' }),
        WATCH,
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
      ])
      expect(raised.lines[0]).toContain('http_post failed: pg_net is unavailable')
    })

    it('one alert per marker per tick however many failures it has; two markers, two alerts', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('50 minutes', 101, { marker: 'm1', harvested: { status: 401 } }),
        dispatchRow('30 minutes', 102, { marker: 'm1', harvested: { status: 401 } }),
        errorRow('10 minutes', { marker: 'm1', missing: PAT_SECRET }),
        dispatchRow('20 minutes', 103, { marker: 'm2', harvested: { status: 500 } }),
        WATCH,
        posts,
        "SELECT 'markers=' || string_agg(metadata->>'marker_id', ',' ORDER BY metadata->>'marker_id') " +
          `FROM audit_logs WHERE event_type = '${ALERT}';`,
      ])
      expect(r.lines).toEqual(['posts=2', 'markers=m1,m2'])
    })

    it('one marker with several failures: one alert, and it reports the NEWEST failing event', async () => {
      // Older 401 (50 min) and newer 503 (20 min), same marker, different statuses.
      const sameKind = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('50 minutes', 101, { harvested: { status: 401, body: BAD_CREDS } }),
        dispatchRow('20 minutes', 102, { harvested: { status: 503 } }),
        WATCH,
        posts,
        alerts,
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
      ])
      expect(sameKind.lines.slice(0, 2)).toEqual(['posts=1', 'alerts=1'])
      const msg = sameKind.lines[2]
      expect(msg, 'names the newer failure').toContain('HTTP 503')
      expect(msg, 'does not name the older failure').not.toContain('HTTP 401')
      expect(msg, 'does not quote the older body').not.toContain('Bad credentials')

      // Older dispatch failure, newer dispatcher error: the recorded failure_event is the newer kind.
      const crossKind = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('50 minutes', 101, { harvested: { status: 401 } }),
        errorRow('20 minutes', { missing: PAT_SECRET }),
        WATCH,
        posts,
        `SELECT 'fe=' || (metadata->>'failure_event') FROM audit_logs WHERE event_type = '${ALERT}';`,
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
      ])
      expect(crossKind.lines[0]).toBe('posts=1')
      expect(crossKind.lines[1]).toBe(`fe=${RESUME_ERROR}`)
      expect(crossKind.lines[2]).toContain(`Vault secret ${PAT_SECRET} is missing`)
      expect(crossKind.lines[2]).not.toContain('HTTP 401')

      // And the reverse order: older error, newer dispatch failure.
      const reverse = await inTxn(ctx.ctl(), [
        standardSecrets(),
        errorRow('50 minutes', { missing: PAT_SECRET }),
        dispatchRow('20 minutes', 102, { harvested: { status: 503 } }),
        WATCH,
        posts,
        `SELECT 'fe=' || (metadata->>'failure_event') FROM audit_logs WHERE event_type = '${ALERT}';`,
      ])
      expect(reverse.lines).toEqual(['posts=1', `fe=${DISPATCH}`])
    })

    it.each([
      [
        'a delivered alert 3h ago',
        alertRow('m1', KIND, '3 hours', 301, { status: 200, sent: 'true' }),
        0,
      ],
      [
        'a pending alert 30 minutes old (no result yet)',
        alertRow('m1', KIND, '30 minutes', 301),
        0,
      ],
      ['an unanswered alert 90 minutes old', alertRow('m1', KIND, '90 minutes', 301), 1],
      [
        'an alert whose send reported sent=false',
        alertRow('m1', KIND, '3 hours', 301, { status: 200, sent: 'false' }),
        1,
      ],
      [
        'an alert whose delivery returned 500',
        alertRow('m1', KIND, '3 hours', 301, { status: 500, sent: null }),
        1,
      ],
      [
        'a delivered alert 25h ago',
        alertRow('m1', KIND, '25 hours', 301, { status: 200, sent: 'true' }),
        1,
      ],
      [
        'a delivered alert of ANOTHER kind for this marker',
        alertRow('m1', 'stalled', '3 hours', 301, { status: 200, sent: 'true' }),
        1,
      ],
      [
        'a delivered alert for ANOTHER marker',
        alertRow('m2', KIND, '3 hours', 301, { status: 200, sent: 'true' }),
        1,
      ],
    ] as Array<[string, string, number]>)(
      'dedup on delivery: %s -> %i alert(s)',
      async (_label, prior, expected) => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          prior,
          dispatchRow('10 minutes', 101, { harvested: { status: 401 } }),
          WATCH,
          posts,
        ])
        expect(r.lines).toEqual([`posts=${expected}`])
      }
    )

    it('a later successful dispatch does not suppress the earlier failure (plan D5: any harvested non-2xx alerts)', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('40 minutes', 101, { harvested: { status: 401 } }),
        dispatchRow('20 minutes', 102, { harvested: { status: 200 } }),
        WATCH,
        posts,
      ])
      expect(r.lines).toEqual(['posts=1'])
    })

    it('the watcher kill switch silences the alert but not the harvest', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        vault([WATCH_KILL, '1']),
        dispatchRow('10 minutes', 101),
        responseRow(101, 401, { content: BAD_CREDS }),
        WATCH,
        posts,
        harvestLines,
      ])
      expect(r.lines).toEqual(['posts=0', 'r101=true|401|null|null|false'])
    })

    it('missing watcher credentials: one watch_error row naming the kind, no request, a WARNING, no exception', async () => {
      const r = await inTxn(ctx.ctl(), [
        errorRow('10 minutes', { missing: PAT_SECRET }),
        WATCH,
        ...summary,
        `SELECT 'row=' || concat_ws(',', metadata->>'marker_id', metadata->>'kind', ` +
          `metadata->>'missing_secret') FROM audit_logs WHERE event_type = '${WATCH_ERROR}';`,
      ])
      expect(r.lines).toEqual([
        'posts=0',
        'alerts=0',
        'watch_errors=1',
        'row=m1,resume_dispatch_failed,refresh_metadata_functions_base_url, refresh_metadata_service_role_key',
      ])
      expect(r.stderr).toMatch(/WARNING:.*vault secret\(s\) missing/)
    })

    it('regression: the SMI-7121 kinds still alert in the same tick, with their own types', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        marker('m9', { created: '12 hours 30 minutes' }),
        dispatchRow('10 minutes', 101, { marker: 'm1', harvested: { status: 401 } }),
        WATCH,
        posts,
        "SELECT 'types=' || string_agg(body->>'type', ',' ORDER BY body->>'type') FROM net.calls;",
      ])
      expect(r.lines).toEqual([
        'posts=2',
        `types=indexer_backfill_autochain_resume_dispatch_failed,indexer_backfill_autochain_stalled`,
      ])
    })
  })
}
