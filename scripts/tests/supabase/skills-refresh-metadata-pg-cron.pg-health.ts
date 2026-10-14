/**
 * SMI-7114 case 4: refresh_metadata_health() classification, precedence, attribution and window.
 * Registered from ./skills-refresh-metadata-pg-cron.pg.test.ts (inside its describe, so the build
 * and the per-test fixture reload apply). Its own module to hold both files under 500 lines.
 *
 * Every arm seeds and reads inside one transaction, so ages are exact multiples of the seeded
 * intervals.
 *
 * @module scripts/tests/supabase/skills-refresh-metadata-pg-cron.pg-health
 */

import { describe, it, expect } from 'vitest'
import {
  dispatchRow,
  durableRow,
  healthAfter,
  inTxn,
  responseRow,
  runRow,
  type Ctx,
} from './skills-refresh-metadata-pg-cron.test-helpers.ts'

const MIN = 60
const HOUR = 3600

export function registerHealthTests(ctx: Ctx): void {
  describe('case 4: refresh_metadata_health classification', () => {
    it('durable refresh:dispatch_result wins over a conflicting live response, in both directions', async () => {
      const durableFails = await healthAfter(ctx.ctl(), [
        dispatchRow('30 minutes', 1001),
        durableRow('20 minutes', 1001, 500, 'durable boom'),
        responseRow(1001, 200),
      ])
      expect(durableFails.failures, 'durable 500 beats live 200').toMatchObject([
        { kind: 'http_error', status_code: 500, error_msg: 'durable boom' },
      ])
      const durableOk = await healthAfter(ctx.ctl(), [
        dispatchRow('30 minutes', 1002),
        durableRow('20 minutes', 1002, 200),
        responseRow(1002, 500),
      ])
      expect(durableOk.failures, 'durable 200 beats live 500').toEqual([])
      expect(durableOk.unknown_count).toBe(0)
    })

    it('a live 2xx is not a failure', async () => {
      const h = await healthAfter(ctx.ctl(), [
        dispatchRow('30 minutes', 1003),
        responseRow(1003, 204),
      ])
      expect(h.failures).toEqual([])
      expect(h.unknown_count).toBe(0)
    })

    it('a live 500 is an http_error carrying status 500', async () => {
      const h = await healthAfter(ctx.ctl(), [
        dispatchRow('30 minutes', 1004),
        responseRow(1004, 500),
      ])
      expect(h.failures).toHaveLength(1)
      expect(h.failures[0]).toMatchObject({ kind: 'http_error', status_code: 500 })
    })

    it('a live NULL status with the timeout error_msg and timed_out NULL is a transport_error', async () => {
      const h = await healthAfter(ctx.ctl(), [
        dispatchRow('30 minutes', 1005),
        responseRow(1005, null, { errorMsg: 'Timeout of 300000 ms reached', timedOut: null }),
      ])
      expect(h.failures).toHaveLength(1)
      expect(h.failures[0]).toMatchObject({
        kind: 'transport_error',
        status_code: null,
        error_msg: 'Timeout of 300000 ms reached',
      })
    })

    it('no response: 20 min old is no_response; 7h old is unknown (counted, not a failure); 2 min old is neither', async () => {
      const old20 = await healthAfter(ctx.ctl(), [dispatchRow('20 minutes', 1006)])
      expect(old20.failures.map((f) => f.kind)).toEqual(['no_response'])
      expect(old20.unknown_count).toBe(0)

      const old7h = await healthAfter(ctx.ctl(), [dispatchRow('7 hours', 1007)])
      expect(old7h.failures, 'a purged unharvested response is never a failure').toEqual([])
      expect(old7h.unknown_count).toBe(1)

      const fresh = await healthAfter(ctx.ctl(), [dispatchRow('2 minutes', 1008)])
      expect(fresh.failures).toEqual([])
      expect(fresh.unknown_count).toBe(0)
    })

    it('a refresh:run with result failed is run_failed, error_msg truncated to 200 chars', async () => {
      const long = 'boom' + 'x'.repeat(296)
      const h = await healthAfter(ctx.ctl(), [runRow('1 hour', 'failed', [long, 'second error'])])
      expect(h.failures).toHaveLength(1)
      expect(h.failures[0].kind).toBe('run_failed')
      expect(h.failures[0].status_code).toBeNull()
      expect(h.failures[0].error_msg).toBe(long.slice(0, 200))
      expect(h.failures[0].error_msg).toHaveLength(200)
    })

    it('last_run ignores a newer failed run, last_attempt reports it', async () => {
      const h = await healthAfter(ctx.ctl(), [
        runRow('3 hours', 'ok'),
        runRow('1 hour', 'failed', ['boom']),
      ])
      expect(h.last_run_age_s, 'last_run is the older healthy run').toBe(3 * HOUR)
      expect(h.last_attempt_age_s, 'last_attempt is the newer failed run').toBe(1 * HOUR)
      expect(h.failures.map((f) => f.kind)).toEqual(['run_failed'])

      const only = await healthAfter(ctx.ctl(), [runRow('1 hour', 'failed', ['boom'])])
      expect(only.last_run_age_s, 'a lone failed run is not a healthy run').toBeNull()
      expect(only.last_attempt_age_s).toBe(1 * HOUR)
    })

    it('a non-pg_cron refresh:dispatch is ignored for attribution and for last_dispatch', async () => {
      const manual = [dispatchRow('30 minutes', 1009, 'manual'), responseRow(1009, 500)]
      const ignored = await healthAfter(ctx.ctl(), manual)
      expect(ignored.failures, 'a manual dispatch is not attributed to the job').toEqual([])
      expect(ignored.last_dispatch_age_s).toBeNull()

      // Control: the identical rows written by pg_cron ARE attributed, so the line above is not
      // an empty answer that any seed would give.
      const attributed = await healthAfter(ctx.ctl(), [
        dispatchRow('30 minutes', 1009),
        responseRow(1009, 500),
      ])
      expect(attributed.failures.map((f) => f.kind)).toEqual(['http_error'])
      expect(attributed.last_dispatch_age_s).toBe(30 * MIN)
    })

    it('an over-long or non-numeric net_request_id does not raise and is not attributed', async () => {
      const h = await healthAfter(ctx.ctl(), [
        dispatchRow('30 minutes', '9999999999999999999999'),
        dispatchRow('20 minutes', 'abc'),
        dispatchRow('25 minutes', 1010),
        responseRow(1010, 200),
      ])
      expect(
        h.failures.map((f) => f.kind),
        'only the two unattributable dispatches fail'
      ).toEqual(['no_response', 'no_response'])
      expect(h.unknown_count).toBe(0)
    })

    it('dispatches and failed runs outside p_window are excluded, inside it included', async () => {
      const seed = [
        dispatchRow('10 hours', 1011),
        runRow('10 hours', 'failed', ['old boom']),
        dispatchRow('30 minutes', 1012),
        responseRow(1012, 500),
      ]
      const narrow = await healthAfter(ctx.ctl(), seed)
      expect(
        narrow.failures.map((f) => f.kind),
        'default 9h window'
      ).toEqual(['http_error'])
      expect(narrow.unknown_count).toBe(0)
      expect(narrow.last_attempt_age_s, 'last_attempt is not window-limited').toBe(10 * HOUR)

      const wide = await healthAfter(ctx.ctl(), seed, '12 hours')
      expect(wide.failures.map((f) => f.kind).sort()).toEqual(['http_error', 'run_failed'])
      expect(wide.unknown_count, 'the 10h unanswered dispatch is past the 6h ttl').toBe(1)
    })

    it('with nothing seeded the shape is empty, not an error', async () => {
      const r = await inTxn(ctx.ctl(), ["SELECT 'raw=' || public.refresh_metadata_health()::text;"])
      expect(r.lines[0]).toMatch(/^raw=\{/)
      const h = await healthAfter(ctx.ctl(), [])
      expect(h).toMatchObject({ failures: [], unknown_count: 0, last_run_age_s: null })
    })
  })
}
