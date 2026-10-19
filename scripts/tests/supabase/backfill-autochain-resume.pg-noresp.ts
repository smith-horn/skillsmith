/**
 * SMI-7142 plan D5: the watcher's "no response from pg_net" arm -- a resume_dispatch row still without
 * a status_code after 1 hour (inside the 3 hour lookback) is a failure when pg_net has no response
 * row for it either, so a dispatch pg_net never answered cannot stay silent while a response that
 * arrived after the harvest is not misreported as missing. Registered from ./backfill-autochain-resume.pg.test.ts; the other
 * failure-arm cases are in ./backfill-autochain-resume.pg-watcher.ts.
 *
 * @module scripts/tests/supabase/backfill-autochain-resume.pg-noresp
 */

import { describe, it, expect } from 'vitest'
import {
  ALERT,
  DISPATCH,
  WATCH,
  WATCH_ERROR,
  count,
  inTxn,
  posts,
  responseRow,
  standardSecrets,
  type Ctx,
} from './backfill-autochain-resume.test-helpers.ts'
import { dispatchRow } from './backfill-autochain-resume.pg-watcher.ts'

const alerts = count('alerts', `audit_logs WHERE event_type = '${ALERT}'`)
const watchErrors = count('watch_errors', `audit_logs WHERE event_type = '${WATCH_ERROR}'`)
const KIND = 'resume_dispatch_failed'
const BAD_CREDS = '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}'
const summary = [posts, alerts, watchErrors]

export function registerNoResponseTests(ctx: Ctx): void {
  describe('case 9: watcher alerts on a dispatch pg_net never answered', () => {
    it('a dispatch unanswered by pg_net for 70 minutes alerts once, naming that there was no response', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('70 minutes', 101), // no response row and no status_code key
        WATCH,
        ...summary,
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
        `SELECT 'row=' || concat_ws(',', metadata->>'marker_id', metadata->>'kind', ` +
          `metadata->>'failure_event') FROM audit_logs WHERE event_type = '${ALERT}';`,
        `SELECT 'unharvested=' || count(*) FROM audit_logs WHERE event_type = '${DISPATCH}' ` +
          `AND NOT (metadata ? 'status_code');`,
      ])
      expect(r.lines.slice(0, 3)).toEqual(['posts=1', 'alerts=1', 'watch_errors=0'])
      expect(r.lines[3]).toContain('no response from pg_net after 1h')
      expect(r.lines[3]).not.toContain('HTTP')
      expect(r.lines.slice(4)).toEqual([`row=m1,${KIND},${DISPATCH}`, 'unharvested=1'])
    })

    it('a late response lands before the unanswered arm reads: it is judged by its status, not as unanswered', async () => {
      const ok = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('70 minutes', 101),
        responseRow(101, 200, { content: '{"workflow_run_id": 4242}' }),
        WATCH,
        posts,
      ])
      expect(ok.lines).toEqual(['posts=0'])
      const refused = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('70 minutes', 101),
        responseRow(101, 401, { content: BAD_CREDS }),
        WATCH,
        posts,
        "SELECT 'msg=' || (body->>'message') FROM net.calls;",
      ])
      expect(refused.lines[0]).toBe('posts=1')
      expect(refused.lines[1]).toContain('HTTP 401')
      expect(refused.lines[1]).not.toContain('no response from pg_net')
    })

    it('a harvested 2xx dispatch 70 minutes old does not alert', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('70 minutes', 101, { harvested: { status: 200 } }),
        WATCH,
        ...summary,
      ])
      expect(r.lines).toEqual(['posts=0', 'alerts=0', 'watch_errors=0'])
    })

    it('the unanswered arm shares the 3 hour lookback: 2h59m old alerts, 3h01m old does not', async () => {
      for (const [when, expected] of [
        ['2 hours 59 minutes', 1],
        ['3 hours 1 minute', 0],
      ] as const) {
        const r = await inTxn(ctx.ctl(), [standardSecrets(), dispatchRow(when, 101), WATCH, posts])
        expect(r.lines, `unanswered ${when} old`).toEqual([`posts=${expected}`])
      }
    })

    it('an answered dispatch the harvest did not record is not reported as missing', async () => {
      // Predicate-level, not a timing test: it does not commit a response between the watcher's
      // two statements (no hook exists to pause the function there). It reproduces the STATE that
      // window leaves: a trigger makes the harvest unable to record dispatch 101 (the audit row
      // stays without a status_code key) while its net._http_response row exists, so only the
      // scan's own NOT EXISTS can keep it from alerting. Dispatch 102 (marker m2) has no response
      // row at all and is the positive control: it must alert in the same run.
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        'CREATE FUNCTION pg_temp.hold_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
          'RETURN OLD; END $$;',
        'CREATE TRIGGER hold_row BEFORE UPDATE ON audit_logs FOR EACH ROW ' +
          "WHEN (OLD.metadata->>'net_request_id' = '101') EXECUTE FUNCTION pg_temp.hold_row();",
        dispatchRow('70 minutes', 101, { marker: 'm1' }),
        dispatchRow('70 minutes', 102, { marker: 'm2' }),
        responseRow(101, 401, { content: BAD_CREDS }),
        WATCH,
        posts,
        `SELECT 'm1_unharvested=' || count(*) FROM audit_logs WHERE event_type = '${DISPATCH}' ` +
          `AND metadata->>'marker_id' = 'm1' AND NOT (metadata ? 'status_code');`,
        `SELECT 'alerted=' || coalesce(string_agg(metadata->>'marker_id', ',' ` +
          `ORDER BY metadata->>'marker_id'), '') FROM audit_logs WHERE event_type = '${ALERT}';`,
        "SELECT 'm1_posts=' || count(*) FROM net.calls WHERE (body->>'message') LIKE '%marker m1%';",
        "SELECT 'm2_posts=' || count(*) FROM net.calls WHERE (body->>'message') LIKE '%marker m2%';",
      ])
      expect(r.lines).toEqual([
        'posts=1',
        'm1_unharvested=1',
        'alerted=m2',
        'm1_posts=0',
        'm2_posts=1',
      ])
    })
  })
}
