/**
 * SMI-7167: check_backfill_autochain_silent_stop(), the detector. Registered from
 * ./backfill-autochain-silent-stop.pg.test.ts. Every arm seeds and calls inside one transaction, so
 * every age boundary is exact. The two-session arms live in
 * ./backfill-autochain-silent-stop.pg-concurrency.ts.
 *
 * @module scripts/tests/supabase/backfill-autochain-silent-stop.pg-detector
 */

import { describe, it, expect } from 'vitest'
import {
  ALERT_TYPE,
  BASE_URL,
  DETECT,
  EV,
  SERVICE_KEY,
  ackRow,
  count,
  dispatchedRow,
  inTxn,
  linkFinishedRow,
  linkStartedRow,
  preparedRow,
  standardSecrets,
  type Ctx,
} from './backfill-autochain-silent-stop.test-helpers.ts'

const posts = count('posts', 'net.calls')
const alerts = count('alerts', `audit_logs WHERE event_type = '${EV.alert}'`)
const errors = count('errors', `audit_logs WHERE event_type = '${EV.error}'`)
const SUMMARY = [posts, alerts, errors]

const R = '1001'
const TOK = 'ac-111'
/** An Arm A candidate (13h old, 12h rule) and an Arm B one (31 min old). */
const dueA = () => dispatchedRow(R, '13 hours')
const dueB = () => preparedRow(TOK, '1', '31 minutes')
const msgHas = (label: string, needle: string) =>
  `SELECT '${label}=' || (body->>'message' LIKE '%' || '${needle}' || '%') FROM net.calls;`

export function registerDetectorTests(ctx: Ctx): void {
  describe('case 6: check_backfill_autochain_silent_stop() detector', () => {
    it('no ledger rows: no POST, no rows', async () => {
      const r = await inTxn(ctx.ctl(), [standardSecrets(), DETECT, ...SUMMARY])
      expect(r.lines).toEqual(['posts=0', 'alerts=0', 'errors=0'])
    })

    it('Arm A: one POST with the right URL, type, auth, timeout, message, and an alert row tied to the call', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchedRow(R, '13 hours', { dispatch_token: 'ac-9', link_run_id: '4242' }),
        DETECT,
        posts,
        "SELECT 'url=' || url FROM net.calls;",
        "SELECT 'type=' || (body->>'type') FROM net.calls;",
        "SELECT 'auth=' || (headers->>'Authorization') FROM net.calls;",
        "SELECT 'timeout=' || timeout_milliseconds FROM net.calls;",
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
        // deadline = dispatch + 12h = 1h ago, rendered in UTC to the minute
        `SELECT 'deadline=' || (body->>'message' LIKE '%past its deadline ' || ` +
          `to_char((now() - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"') || ' (12 h after the dispatch%') FROM net.calls;`,
        alerts,
        `SELECT 'row=' || concat_ws(',', metadata->>'arm', metadata->>'key', metadata->>'sub_kind', ` +
          `metadata->>'supabase_env', actor) FROM audit_logs WHERE event_type = '${EV.alert}';`,
        `SELECT 'idmatch=' || count(*) FROM audit_logs a JOIN net.calls c ` +
          `ON (a.metadata->>'net_request_id')::bigint = c.id WHERE a.event_type = '${EV.alert}';`,
        `SELECT 'idjson=' || jsonb_typeof(metadata->'net_request_id') FROM audit_logs WHERE event_type = '${EV.alert}';`,
      ])
      expect(r.lines.slice(0, 5)).toEqual([
        'posts=1',
        `url=${BASE_URL}/functions/v1/alert-notify`,
        `type=${ALERT_TYPE.A}`,
        `auth=Bearer ${SERVICE_KEY}`,
        'timeout=30000',
      ])
      for (const part of [
        R,
        '4242',
        'attempt 1',
        'token ac-9',
        'supabase_env production',
        'Kind: no_link',
        'backfill-autochain-handover.md',
        'A dispatched run got no link',
      ])
        expect(r.lines[5], `message names ${part}`).toContain(part)
      expect(r.lines.slice(6)).toEqual([
        'deadline=true',
        'alerts=1',
        `row=A,${R},no_link,production,pg_cron`,
        'idmatch=1',
        'idjson=number',
      ])
    })

    it('Arm A message states the checkpoint basis when a prod checkpoint set the deadline', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchedRow(R, '3 hours'),
        // checkpoint 31 min ago -> the run is due via the 30-min rule
        `INSERT INTO audit_logs (event_type, metadata, created_at) VALUES ('indexer_backfill_checkpoint', ` +
          `jsonb_build_object('run_id', '${R}', 'dry_run', false), now() - interval '31 minutes');`,
        DETECT,
        msgHas('basis', '(30 min after its checkpoint)'),
      ])
      expect(r.lines).toEqual(['basis=true'])
    })

    it.each([
      ['no_link', [], 'No link started for this run'],
      ['link_unfinished', [linkStartedRow(R)], 'never recorded a finish'],
      [
        'link_failed',
        [linkStartedRow(R), linkFinishedRow(R, '1 minute', 'failure')],
        'did not finish green',
      ],
    ] as Array<[string, string[], string]>)(
      'Arm A sub_kind %s carries its own explanation in the message and the alert row',
      async (sub, extra, phrase) => {
        const r = await inTxn(ctx.ctl(), [
          standardSecrets(),
          dueA(),
          ...extra,
          DETECT,
          msgHas('phrase', phrase),
          `SELECT 'sub=' || (metadata->>'sub_kind') FROM audit_logs WHERE event_type = '${EV.alert}';`,
        ])
        expect(r.lines).toEqual(['phrase=true', `sub=${sub}`])
      }
    )

    it('Arm B: one POST of type dispatch_ambiguous naming the token, and an alert row keyed token:attempt', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        preparedRow(TOK, '2', '31 minutes', { link_run_id: '4242' }),
        DETECT,
        posts,
        "SELECT 'type=' || (body->>'type') FROM net.calls;",
        msgHas('tok', '[tok=' + TOK + ']'),
        msgHas('run', 'link run 4242 (attempt 2, token ' + TOK + ','),
        msgHas('runbook', 'backfill-autochain-handover.md'),
        `SELECT 'row=' || concat_ws(',', metadata->>'arm', metadata->>'key', metadata->>'sub_kind') ` +
          `FROM audit_logs WHERE event_type = '${EV.alert}';`,
      ])
      expect(r.lines).toEqual([
        'posts=1',
        `type=${ALERT_TYPE.B}`,
        'tok=true',
        'run=true',
        'runbook=true',
        `row=B,${TOK}:2,unresolved`,
      ])
    })

    it('an A and a B candidate in one tick each get their own POST, type and alert row', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dueA(),
        dueB(),
        DETECT,
        posts,
        "SELECT 'types=' || string_agg(body->>'type', ',' ORDER BY body->>'type') FROM net.calls;",
        `SELECT 'rows=' || string_agg(metadata->>'arm' || ':' || (metadata->>'key'), ',' ORDER BY metadata->>'arm') ` +
          `FROM audit_logs WHERE event_type = '${EV.alert}';`,
      ])
      expect(r.lines).toEqual([
        'posts=2',
        `types=${ALERT_TYPE.B},${ALERT_TYPE.A}`,
        `rows=A:${R},B:${TOK}:1`,
      ])
    })

    it('resolved candidates (green link, acks, not yet due) send nothing; the due one beside them does', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchedRow('11', '13 hours'),
        linkFinishedRow('11', '1 minute', 'success'),
        dispatchedRow('12', '13 hours'),
        ackRow('A', '12'),
        dispatchedRow('13', '11 hours'),
        preparedRow('ac-21', '1', '29 minutes'),
        preparedRow('ac-22', '1', '31 minutes'),
        ackRow('B', 'ac-22:1'),
        DETECT,
        posts,
        dueA(),
        DETECT,
        posts,
        `SELECT 'key=' || (metadata->>'key') FROM audit_logs WHERE event_type = '${EV.alert}';`,
      ])
      expect(r.lines).toEqual(['posts=0', 'posts=1', `key=${R}`])
    })
  })
}
