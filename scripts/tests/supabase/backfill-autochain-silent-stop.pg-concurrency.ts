/**
 * SMI-7167: two concurrent detector callers, proven with TWO real sessions (as
 * ./backfill-autochain-markers.pg-concurrency.ts does for its watcher). Registered from
 * ./backfill-autochain-silent-stop.pg.test.ts.
 *
 * WHY NOT THE SINGLE-TRANSACTION PATTERN. The other arms seed and call inside one rolled-back
 * transaction, which cannot express "session B runs while session A's transaction is open". Here the
 * seed is COMMITTED (autocommit on the control session) and `fixtureSql()` (which the suite's
 * beforeEach also runs) clears it afterwards. The ledger is append-only, so the detector takes no row
 * lock: the only serialisation is its advisory transaction lock.
 *
 * @module scripts/tests/supabase/backfill-autochain-silent-stop.pg-concurrency
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  DETECT,
  EV,
  PsqlSession,
  count,
  dispatchedRow,
  fixtureSql,
  lines,
  requireTestConn,
  standardSecrets,
  type Ctx,
} from './backfill-autochain-silent-stop.test-helpers.ts'

const posts = count('posts', 'net.calls')
const alerts = count('alerts', `audit_logs WHERE event_type = '${EV.alert}'`)

export function registerConcurrencyTests(ctx: Ctx): void {
  describe('detector advisory lock: two real sessions', () => {
    let a: PsqlSession
    let b: PsqlSession

    beforeAll(() => {
      a = new PsqlSession(requireTestConn(), 'A')
      b = new PsqlSession(requireTestConn(), 'B')
    })

    afterEach(async () => {
      // Never leave A's or B's transaction (and its locks) open for the next test.
      await a.send('ROLLBACK;')
      await b.send('ROLLBACK;')
      await ctx.ctl().send(fixtureSql())
    })

    afterAll(async () => {
      await a?.close()
      await b?.close()
    })

    const seedDue = async () => {
      const s = await ctx
        .ctl()
        .send([standardSecrets(), dispatchedRow('1001', '13 hours')].join('\n'))
      expect(s.stderr, 'seed committed').not.toMatch(/ERROR/)
    }

    it('B called while A holds the lock sends nothing; after A commits there is exactly one POST and one alert row', async () => {
      await seedDue()
      const aRun = await a.send(`BEGIN;\n${DETECT}`)
      expect(aRun.stderr, 'A ran').not.toMatch(/ERROR/)

      // B, with A's transaction still open: its own view must show zero POSTs and zero alerts.
      const bRun = await b.send(`BEGIN;\n${DETECT}\n${posts}\n${alerts}\nCOMMIT;`)
      expect(bRun.stderr).not.toMatch(/ERROR/)
      expect(lines(bRun), 'B did no work while A held the lock').toEqual(['posts=0', 'alerts=0'])

      await a.send('COMMIT;')
      expect(lines(await ctx.ctl().send(`${posts}\n${alerts}`)), 'one alert in total').toEqual([
        'posts=1',
        'alerts=1',
      ])
    })

    it('once A has committed its alert, a later call is deduplicated (the pending alert is visible)', async () => {
      await seedDue()
      await a.send(`BEGIN;\n${DETECT}\nCOMMIT;`)
      expect(lines(await b.send(`${DETECT}\n${posts}\n${alerts}`))).toEqual(['posts=1', 'alerts=1'])
    })

    it('A rolling back releases the lock; B then alerts (the lock does not strand the alert)', async () => {
      await seedDue()
      await a.send(`BEGIN;\n${DETECT}`)
      await a.send('ROLLBACK;')
      expect(lines(await b.send(`${DETECT}\n${posts}\n${alerts}`))).toEqual(['posts=1', 'alerts=1'])
    })

    it("the detector's key is its own function name: with A holding it directly, B sends nothing", async () => {
      await seedDue()
      await a.send(
        "BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('check_backfill_autochain_silent_stop', 0));"
      )
      const bRun = await b.send(`BEGIN;\n${DETECT}\n${posts}\n${alerts}\nCOMMIT;`)
      expect(bRun.stderr).not.toMatch(/ERROR/)
      expect(lines(bRun)).toEqual(['posts=0', 'alerts=0'])
    })

    it("another monitor's key does not block it: with A holding the SMI-7121 watcher key, B still alerts", async () => {
      await seedDue()
      await a.send(
        "BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('check_backfill_autochain_markers', 0));"
      )
      const bRun = await b.send(`BEGIN;\n${DETECT}\n${posts}\n${alerts}\nCOMMIT;`)
      expect(bRun.stderr).not.toMatch(/ERROR/)
      expect(lines(bRun)).toEqual(['posts=1', 'alerts=1'])
    })
  })
}
