/**
 * SMI-7167: the detector's delivery behaviour -- dedup on delivery (24h / 1h pending), the pg_net
 * response harvest, the kill switch and missing Vault secrets. Registered from
 * ./backfill-autochain-silent-stop.pg.test.ts. Split from ./backfill-autochain-silent-stop.pg-detector.ts
 * (500-line limit); same single-transaction convention.
 *
 * @module scripts/tests/supabase/backfill-autochain-silent-stop.pg-delivery
 */

import { describe, it, expect } from 'vitest'
import {
  BASE_URL,
  DETECT,
  EV,
  KILL_SWITCH,
  SENT,
  SERVICE_KEY,
  alertRow,
  count,
  dispatchedRow,
  inTxn,
  preparedRow,
  responseRow,
  standardSecrets,
  vault,
  type Ctx,
} from './backfill-autochain-silent-stop.test-helpers.ts'

const posts = count('posts', 'net.calls')
const alerts = count('alerts', `audit_logs WHERE event_type = '${EV.alert}'`)
const errors = count('errors', `audit_logs WHERE event_type = '${EV.error}'`)
const SUMMARY = [posts, alerts, errors]

const R = '1001'
const TOK = 'ac-111'
const dueA = () => dispatchedRow(R, '13 hours')
const dueB = () => preparedRow(TOK, '1', '31 minutes')

export function registerDeliveryTests(ctx: Ctx): void {
  describe('case 7: detector delivery -- dedup, harvest, kill switch, secrets', () => {
    // [label, prior response (null = none), prior harvested result (undefined = not harvested),
    //  prior alert age, expected NEW posts]. A "response" row is harvested by the same tick before
    // dedup runs; dedup itself reads only the alert rows.
    type Outcome = [
      string,
      [number | null, string | null] | null,
      { status: number | null; sent: string | null } | undefined,
      string,
      number,
    ]
    const outcomes: Outcome[] = [
      ['response delivered (2xx, sent true)', [200, SENT], undefined, '2 hours', 0],
      [
        'harvested delivered, 23h old (inside the 24h dedup)',
        null,
        { status: 200, sent: 'true' },
        '23 hours',
        0,
      ],
      [
        'harvested delivered, 25h old: outside the 24h dedup (the daily re-page)',
        null,
        { status: 200, sent: 'true' },
        '25 hours',
        1,
      ],
      ['response 2xx but sent false', [200, '{"data":{"sent":false}}'], undefined, '2 hours', 1],
      ['response 2xx with no data.sent', [200, '{"ok":true}'], undefined, '2 hours', 1],
      ['response non-2xx even if the body says sent', [500, SENT], undefined, '2 hours', 1],
      ['response transport failure (NULL status)', [null, null], undefined, '2 hours', 1],
      ['response 2xx with a non-JSON body', [200, 'not json <html>'], undefined, '2 hours', 1],
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
      ['no response, 61 minutes old: no longer pending', null, undefined, '61 minutes', 1],
      ['no response, 2 hours old', null, undefined, '2 hours', 1],
    ]
    it.each(
      outcomes.map((o) => [`prior alert ${o[0]} -> ${o[4]} new POST`, ...o.slice(1)] as Outcome)
    )('dedup (Arm A): %s', async (_label, resp, harvested, alertAge, expected) => {
      const RID = 9001
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dueA(),
        alertRow('A', R, alertAge, RID, harvested ? { harvested } : {}),
        ...(resp ? [responseRow(RID, resp[0], resp[1])] : []),
        DETECT,
        ...SUMMARY,
      ])
      expect(r.lines).toEqual([`posts=${expected}`, `alerts=${1 + expected}`, 'errors=0'])
    })

    it('dedup (Arm B): the same table applies to a prepared candidate keyed token:attempt', async () => {
      const KEY = `${TOK}:1`
      const delivered = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dueB(),
        alertRow('B', KEY, '2 hours', 9301, { harvested: { status: 200, sent: 'true' } }),
        DETECT,
        posts,
      ])
      expect(delivered.lines).toEqual(['posts=0'])
      const stale = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dueB(),
        alertRow('B', KEY, '25 hours', 9302, { harvested: { status: 200, sent: 'true' } }),
        DETECT,
        posts,
      ])
      expect(stale.lines).toEqual(['posts=1'])
    })

    it('dedup is per (arm, key): a delivered alert for another key, or the same key under the other arm, does not suppress', async () => {
      const ok = { harvested: { status: 200, sent: 'true' } }
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dueA(),
        alertRow('A', '999', '2 hours', 9401, ok),
        alertRow('B', R, '2 hours', 9402, ok),
        DETECT,
        posts,
      ])
      expect(r.lines).toEqual(['posts=1'])
    })

    it('a full cycle: send, suppressed while pending, suppressed once delivered, re-sent 25h later', async () => {
      const respond = `INSERT INTO net._http_response (id, status_code, content) SELECT id, 200, '${SENT}' FROM net.calls;`
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dueA(),
        DETECT,
        posts, // 1: first page
        DETECT,
        posts, // 1: pending, suppressed
        respond,
        DETECT,
        posts, // 1: harvested as delivered, suppressed
        "UPDATE audit_logs SET created_at = now() - interval '25 hours' WHERE event_type = '" +
          EV.alert +
          "';",
        DETECT,
        posts, // 2: the daily re-page
        alerts,
      ])
      expect(r.lines).toEqual(['posts=1', 'posts=1', 'posts=1', 'posts=2', 'alerts=2'])
    })

    describe('harvest: a delivered alert keeps suppressing after pg_net purges its response', () => {
      const PURGE = 'DELETE FROM net._http_response;' // pg_net's 6h TTL purge

      it('the tick copies status_code and sent into the alert row, once', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          dueA(),
          alertRow('A', R, '2 hours', 9201),
          responseRow(9201, 200, SENT),
          DETECT,
          `SELECT 'harvested=' || (metadata->>'status_code') || ',' || (metadata->>'sent') FROM audit_logs WHERE event_type = '${EV.alert}';`,
          posts,
        ])
        expect(r.lines).toEqual(['harvested=200,true', 'posts=0'])
      })

      it('delivered, harvested by one tick, then purged: the next tick still does not re-alert', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          dueA(),
          alertRow('A', R, '2 hours', 9202),
          responseRow(9202, 200, SENT),
          DETECT,
          PURGE,
          DETECT,
          posts,
        ])
        expect(r.lines).toEqual(['posts=0'])
      })

      it('control: delivered but purged BEFORE any tick harvested it: the next tick re-alerts', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          dueA(),
          alertRow('A', R, '2 hours', 9203),
          responseRow(9203, 200, SENT),
          PURGE,
          DETECT,
          posts,
        ])
        expect(r.lines).toEqual(['posts=1'])
      })

      it('parses sent per row: a non-JSON body harvests as not delivered and does not abort the other rows', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          alertRow('A', 'a', '2 hours', 9210),
          responseRow(9210, 200, 'not json <html>'),
          alertRow('A', 'b', '2 hours', 9211),
          responseRow(9211, 200, SENT),
          alertRow('A', 'c', '2 hours', 9212),
          responseRow(9212, null),
          DETECT,
          `SELECT (metadata->>'key') || ':' || coalesce(metadata->>'status_code', 'NULL') || ':' || ` +
            `coalesce(metadata->>'sent', 'NULL') || ':' || (metadata ? 'status_code') ` +
            `FROM audit_logs WHERE event_type = '${EV.alert}' ORDER BY 1;`,
        ])
        expect(r.lines).toEqual(['a:200:NULL:true', 'b:200:true:true', 'c:NULL:NULL:true'])
      })

      it('a non-JSON body harvested as not delivered re-sends on the same tick', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          dueA(),
          alertRow('A', R, '2 hours', 9213),
          responseRow(9213, 200, 'not json <html>'),
          DETECT,
          posts,
        ])
        expect(r.lines).toEqual(['posts=1'])
      })

      it('a harvested "not delivered" result is not overridden by a "delivered" response appearing later', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          dueA(),
          alertRow('A', R, '2 hours', 9220, { harvested: { status: 500, sent: null } }),
          responseRow(9220, 200, SENT),
          DETECT,
          posts,
        ])
        expect(r.lines).toEqual(['posts=1'])
      })

      it('ignores alerts older than 24h and alerts with an unparseable request id, without raising', async () => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          alertRow('A', 'a', '25 hours', 9230),
          responseRow(9230, 200, SENT),
          alertRow('A', 'b', '2 hours', 'abc'),
          DETECT,
          `SELECT 'harvested=' || count(*) FROM audit_logs WHERE event_type = '${EV.alert}' AND metadata ? 'status_code';`,
        ])
        expect(r.lines).toEqual(['harvested=0'])
      })
    })

    it('with the kill switch set, a pending response is still harvested and nothing is sent', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        vault([KILL_SWITCH, '1']),
        dueA(),
        alertRow('A', R, '2 hours', 9240),
        responseRow(9240, 200, SENT),
        DETECT,
        `SELECT 'harvested=' || coalesce(metadata->>'status_code', 'NULL') || ',' || coalesce(metadata->>'sent', 'NULL') ` +
          `FROM audit_logs WHERE event_type = '${EV.alert}';`,
        ...SUMMARY,
      ])
      expect(r.lines).toEqual(['harvested=200,true', 'posts=0', 'alerts=1', 'errors=0'])
    })

    it('the vault kill switch silences the detector; any other value leaves it enabled', async () => {
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
          dueA(),
          DETECT,
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
      'missing %s: ONE error row naming it and the first candidate, no POST, no exception',
      async (_label, secrets, missing) => {
        const r = await inTxn(ctx.ctl(), [
          ...(secrets.length ? [vault(...secrets)] : []),
          dispatchedRow('1001', '13 hours'),
          dispatchedRow('1002', '14 hours'),
          dueB(),
          DETECT,
          ...SUMMARY,
          `SELECT 'missing=' || (metadata->>'missing_secret') FROM audit_logs WHERE event_type = '${EV.error}';`,
          `SELECT 'first=' || (metadata->>'arm') || ':' || (metadata->>'key') FROM audit_logs WHERE event_type = '${EV.error}';`,
        ])
        // The earliest candidate by ref_at is dispatched run 1002 (14h).
        expect(r.lines).toEqual([
          'posts=0',
          'alerts=0',
          'errors=1',
          `missing=${missing}`,
          'first=A:1002',
        ])
        expect(r.stderr, 'warned, did not raise').toMatch(/cannot alert/)
      }
    )

    it('missing secrets with nothing to send: no error row (the secrets are read only when an alert is due)', async () => {
      const r = await inTxn(ctx.ctl(), [dispatchedRow(R, '11 hours'), DETECT, ...SUMMARY])
      expect(r.lines).toEqual(['posts=0', 'alerts=0', 'errors=0'])
    })
  })
}
