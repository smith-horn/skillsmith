/**
 * SMI-7114 R2-1/R2-2: the advisory xact locks of harvest_refresh_dispatch_results() and
 * check_refresh_observer_heartbeat(), proven with TWO real sessions. Registered from
 * ./skills-refresh-metadata-pg-cron.pg.test.ts.
 *
 * WHY NOT THE SINGLE-TRANSACTION PATTERN. Every other arm seeds and calls inside one rolled-back
 * transaction, which cannot express "session B runs while session A's transaction is open". Here the
 * seed is COMMITTED (autocommit on the control session) and `fixtureSql()` (which the suite's
 * beforeEach also runs) clears it afterwards.
 *
 * WHAT THE RACE LOOKS LIKE. Session A opens a transaction, calls the function and keeps the
 * transaction open: its lock is held and its rows are uncommitted. Under READ COMMITTED, session B
 * cannot see A's uncommitted rows, so a `NOT EXISTS` dedup or a "no alert yet" lookup says "nothing
 * done" -- only the advisory lock stops B. Every assertion about B is taken from B's OWN session
 * (B sees its own writes and nothing of A's), so a B that did work shows up as a non-zero count there.
 *
 * @module scripts/tests/supabase/skills-refresh-metadata-pg-cron.pg-concurrency
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  PsqlSession,
  alertRow,
  count,
  dispatchRow,
  fixtureSql,
  heartbeatRow,
  requireTestConn,
  responseRow,
  standardSecrets,
  type Ctx,
} from './skills-refresh-metadata-pg-cron.test-helpers.ts'

const DEADMAN = 'SELECT public.check_refresh_observer_heartbeat();'
const HARVEST = 'SELECT public.harvest_refresh_dispatch_results();'
const SENT = '{"data":{"sent":true}}'

const posts = count('posts', 'net.calls')
const alerts = count('alerts', "audit_logs WHERE event_type = 'refresh:observer_dead_alert'")
const dispatchResults = count(
  'dispatch_results',
  "audit_logs WHERE event_type = 'refresh:dispatch_result'"
)
const alertResults = count(
  'alert_results',
  "audit_logs WHERE event_type = 'refresh:observer_dead_alert_result'"
)

const lines = (r: { stdout: string }): string[] => r.stdout.split('\n').filter((l) => l.length > 0)

export function registerConcurrencyTests(ctx: Ctx): void {
  describe('R2-1/R2-2: advisory locks, two real sessions', () => {
    let a: PsqlSession
    let b: PsqlSession

    beforeAll(() => {
      a = new PsqlSession(requireTestConn(), 'A')
      b = new PsqlSession(requireTestConn(), 'B')
    })

    afterEach(async () => {
      // Never leave A's or B's transaction (and its lock) open for the next test.
      await a.send('ROLLBACK;')
      await b.send('ROLLBACK;')
      await ctx.ctl().send(fixtureSql())
    })

    afterAll(async () => {
      await a?.close()
      await b?.close()
    })

    /** Committed seed for a dead-man that must alert: secrets and a heartbeat 16h30m old. */
    const seedDeadman = (): Promise<{ stderr: string }> =>
      ctx.ctl().send([standardSecrets(), heartbeatRow('16 hours 30 minutes')].join('\n'))

    it('dead-man: B called while A holds the lock sends nothing; after A commits there is exactly one POST and one alert row', async () => {
      const seed = await seedDeadman()
      expect(seed.stderr).not.toMatch(/ERROR/)

      const aRun = await a.send(`BEGIN;\n${DEADMAN}`)
      expect(aRun.stderr, 'A ran').not.toMatch(/ERROR/)

      // B, with A's transaction still open: its own view must show zero POSTs and zero alerts.
      const bRun = await b.send(`BEGIN;\n${DEADMAN}\n${posts}\n${alerts}\nCOMMIT;`)
      expect(bRun.stderr).not.toMatch(/ERROR/)
      expect(lines(bRun), 'B did no work while A held the lock').toEqual(['posts=0', 'alerts=0'])

      await a.send('COMMIT;')
      const total = await ctx.ctl().send(`${posts}\n${alerts}`)
      expect(lines(total), 'exactly one alert in total').toEqual(['posts=1', 'alerts=1'])
    })

    it('dead-man: once A has committed its alert, a later call is deduplicated (the pending alert is visible)', async () => {
      await seedDeadman()
      await a.send(`BEGIN;\n${DEADMAN}\nCOMMIT;`)
      const bRun = await b.send(`${DEADMAN}\n${posts}\n${alerts}`)
      expect(lines(bRun)).toEqual(['posts=1', 'alerts=1'])
    })

    it('dead-man: A rolling back releases the lock; B then alerts (the lock does not strand the alert)', async () => {
      await seedDeadman()
      await a.send(`BEGIN;\n${DEADMAN}`)
      await a.send('ROLLBACK;')
      const bRun = await b.send(`${DEADMAN}\n${posts}\n${alerts}`)
      expect(lines(bRun)).toEqual(['posts=1', 'alerts=1'])
    })

    it('harvester: B called while A holds the lock inserts nothing; after A commits there is one row per response', async () => {
      // Committed seed: one dispatch response and one dead-alert response, both unharvested.
      const seed = await ctx
        .ctl()
        .send(
          [
            dispatchRow('30 minutes', 7301),
            responseRow(7301, 500),
            alertRow('30 minutes', 7302),
            responseRow(7302, 200, { content: SENT }),
          ].join('\n')
        )
      expect(seed.stderr).not.toMatch(/ERROR/)

      const aRun = await a.send(`BEGIN;\n${HARVEST}`)
      expect(aRun.stderr, 'A ran').not.toMatch(/ERROR/)

      const bRun = await b.send(`BEGIN;\n${HARVEST}\n${dispatchResults}\n${alertResults}\nCOMMIT;`)
      expect(bRun.stderr).not.toMatch(/ERROR/)
      expect(lines(bRun), 'B harvested nothing while A held the lock').toEqual([
        'dispatch_results=0',
        'alert_results=0',
      ])

      await a.send('COMMIT;')
      const total = await ctx.ctl().send(`${dispatchResults}\n${alertResults}`)
      expect(lines(total), 'one durable row per response in total').toEqual([
        'dispatch_results=1',
        'alert_results=1',
      ])
    })

    it('the two locks use different keys: with A holding the harvester lock, B still sends the dead-man alert', async () => {
      await seedDeadman()
      await a.send(`BEGIN;\n${HARVEST}`)
      const bRun = await b.send(`BEGIN;\n${DEADMAN}\n${posts}\n${alerts}\nCOMMIT;`)
      expect(bRun.stderr).not.toMatch(/ERROR/)
      expect(lines(bRun), 'the dead-man was not blocked by the harvester lock').toEqual([
        'posts=1',
        'alerts=1',
      ])
    })
  })
}
