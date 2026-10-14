/**
 * SMI-7114 case 6: check_refresh_observer_heartbeat(), the dead-man for the refresh observer.
 * Registered from ./skills-refresh-metadata-pg-cron.pg.test.ts. Every arm seeds and calls inside
 * one transaction, so every age boundary is exact.
 *
 * @module scripts/tests/supabase/skills-refresh-metadata-pg-cron.pg-deadman
 */

import { describe, it, expect } from 'vitest'
import {
  alertRow,
  count,
  heartbeatRow,
  inTxn,
  responseRow,
  standardSecrets,
  vault,
  BASE_URL,
  SERVICE_KEY,
  type Ctx,
} from './skills-refresh-metadata-pg-cron.test-helpers.ts'

const CALL = 'SELECT public.check_refresh_observer_heartbeat();'
const DEAD = '16 hours 30 minutes'
const SENT = '{"data":{"sent":true}}'

const posts = count('posts', 'net.calls')
const alerts = count('alerts', "audit_logs WHERE event_type = 'refresh:observer_dead_alert'")
const errors = count('errors', "audit_logs WHERE event_type = 'refresh:observer_deadman_error'")
const SUMMARY = [posts, alerts, errors]

export function registerDeadmanTests(ctx: Ctx): void {
  describe('case 6: check_refresh_observer_heartbeat dead-man', () => {
    it('no heartbeat ever: no POST, no rows', async () => {
      const r = await inTxn(ctx.ctl(), [standardSecrets(), CALL, ...SUMMARY])
      expect(r.lines).toEqual(['posts=0', 'alerts=0', 'errors=0'])
    })

    it('a fresh heartbeat is silent; the 16h boundary is inclusive-silent, 1 microsecond over alerts', async () => {
      for (const [when, expected] of [
        ['2 hours', 0],
        ['16 hours', 0],
        ['16 hours 1 microsecond', 1],
      ] as const) {
        const r = await inTxn(ctx.ctl(), [standardSecrets(), heartbeatRow(when), CALL, ...SUMMARY])
        expect(r.lines, `heartbeat ${when} old`).toEqual([
          `posts=${expected}`,
          `alerts=${expected}`,
          'errors=0',
        ])
      }
    })

    it('a 16h30m-old heartbeat sends exactly one alert-notify POST and one alert row carrying its id', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        heartbeatRow(DEAD),
        CALL,
        posts,
        "SELECT 'url=' || url FROM net.calls;",
        "SELECT 'type=' || (body->>'type') FROM net.calls;",
        "SELECT 'auth=' || (headers->>'Authorization') FROM net.calls;",
        alerts,
        "SELECT 'idmatch=' || count(*) FROM audit_logs a JOIN net.calls c " +
          "ON (a.metadata->>'net_request_id')::bigint = c.id " +
          "WHERE a.event_type = 'refresh:observer_dead_alert';",
      ])
      expect(r.lines).toEqual([
        'posts=1',
        `url=${BASE_URL}/functions/v1/alert-notify`,
        'type=refresh_observer_dead',
        `auth=Bearer ${SERVICE_KEY}`,
        'alerts=1',
        'idmatch=1',
      ])
    })

    it('state-based dedup across successive calls: pending, delivered, then sent=false re-alerts', async () => {
      const respond = (status: number, content: string): string =>
        'DELETE FROM net._http_response; ' +
        `INSERT INTO net._http_response (id, status_code, content) ` +
        `SELECT id, ${status}, '${content}' FROM net.calls ORDER BY id DESC LIMIT 1;`
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        heartbeatRow(DEAD),
        CALL, // first alert
        CALL, // no response yet, alert is 0 min old -> pending
        posts,
        respond(200, SENT),
        CALL, // delivered
        posts,
        respond(200, '{"data":{"sent":false}}'),
        CALL, // 2xx but not sent
        posts,
      ])
      expect(r.lines).toEqual(['posts=1', 'posts=1', 'posts=2'])
    })

    // [label, response to the earlier alert (null = none), alert age, expected NEW posts]
    const outcomes: Array<[string, [number | null, string | null] | null, string, number]> = [
      ['delivered 2xx and sent true', [200, SENT], '30 minutes', 0],
      ['delivered 23h ago, still inside the 24h dedup', [200, SENT], '23 hours', 0],
      ['delivered 25h ago, outside the 24h dedup', [200, SENT], '25 hours', 1],
      ['2xx but sent false', [200, '{"data":{"sent":false}}'], '30 minutes', 1],
      ['2xx with no data.sent', [200, '{"ok":true}'], '30 minutes', 1],
      ['non-2xx even if the body says sent', [500, SENT], '30 minutes', 1],
      ['transport failure (NULL status)', [null, null], '30 minutes', 1],
      ['2xx with a non-JSON body (no error)', [200, 'not json <html>'], '30 minutes', 1],
      ['no response, 30 minutes old: pending', null, '30 minutes', 0],
      ['no response, 59 minutes old: still pending', null, '59 minutes', 0],
      ['no response, exactly 1 hour old: not pending', null, '1 hour', 1],
      ['no response, 2 hours old', null, '2 hours', 1],
    ]
    it.each(
      outcomes.map((o) => [`earlier alert ${o[0]} -> ${o[3]} new POST`, ...o.slice(1)] as typeof o)
    )('%s', async (_label, resp, alertAge, expected) => {
      const RID = 7001
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        heartbeatRow(DEAD),
        alertRow(alertAge, RID),
        ...(resp ? [responseRow(RID, resp[0], { content: resp[1] })] : []),
        CALL,
        posts,
        alerts,
        errors,
      ])
      expect(r.lines).toEqual([`posts=${expected}`, `alerts=${1 + expected}`, 'errors=0'])
    })

    it('an unparseable request id on the earlier alert neither raises nor stops the pending window', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        heartbeatRow(DEAD),
        alertRow('30 minutes', 'abc'),
        CALL,
        posts,
      ])
      expect(r.lines).toEqual(['posts=0'])
    })

    it('any delivered or pending alert in the last 24h suppresses, whatever the newer ones did', async () => {
      const failedNewerDeliveredOlder = await inTxn(ctx.ctl(), [
        standardSecrets(),
        heartbeatRow(DEAD),
        alertRow('3 hours', 7002),
        responseRow(7002, 200, { content: SENT }),
        alertRow('2 hours', 7003),
        responseRow(7003, 500),
        CALL,
        posts,
      ])
      expect(failedNewerDeliveredOlder.lines).toEqual(['posts=0'])

      const pendingNewerFailedOlder = await inTxn(ctx.ctl(), [
        standardSecrets(),
        heartbeatRow(DEAD),
        alertRow('5 hours', 7004),
        responseRow(7004, 500),
        alertRow('10 minutes', 7005),
        CALL,
        posts,
      ])
      expect(pendingNewerFailedOlder.lines).toEqual(['posts=0'])

      const allFailed = await inTxn(ctx.ctl(), [
        standardSecrets(),
        heartbeatRow(DEAD),
        alertRow('5 hours', 7006),
        responseRow(7006, 500),
        alertRow('2 hours', 7007),
        responseRow(7007, 200, { content: '{"data":{"sent":false}}' }),
        CALL,
        posts,
      ])
      expect(allFailed.lines, 'control: only failed alerts do not suppress').toEqual(['posts=1'])
    })

    it('the vault kill switch silences the alert; any other value leaves it enabled', async () => {
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
          vault(['SKILLSMITH_REFRESH_OBSERVER_DEADMAN_DISABLE', value]),
          heartbeatRow(DEAD),
          CALL,
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
      'missing %s: an error row naming it, no POST, no exception',
      async (_label, secrets, missing) => {
        const r = await inTxn(ctx.ctl(), [
          ...(secrets.length ? [vault(...secrets)] : []),
          heartbeatRow(DEAD),
          CALL,
          ...SUMMARY,
          "SELECT 'missing=' || (metadata->>'missing_secret') FROM audit_logs WHERE event_type = 'refresh:observer_deadman_error';",
        ])
        expect(r.lines).toEqual(['posts=0', 'alerts=0', 'errors=1', `missing=${missing}`])
        expect(r.stderr, 'warned, did not raise').toMatch(/cannot alert/)
      }
    )
  })
}
