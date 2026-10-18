/**
 * SMI-7142 plan D5: the watcher's "no response from pg_net" arm -- a resume_dispatch row still without
 * a status_code after 1 hour (inside the 2 hour lookback) is a failure, so a dispatch pg_net never
 * answered cannot stay silent. Registered from ./backfill-autochain-resume.pg.test.ts; the other
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

    it('the unanswered arm shares the 2 hour lookback: 2h01m old does not alert', async () => {
      const r = await inTxn(ctx.ctl(), [
        standardSecrets(),
        dispatchRow('2 hours 1 minute', 101),
        WATCH,
        posts,
      ])
      expect(r.lines).toEqual(['posts=0'])
    })
  })
}
