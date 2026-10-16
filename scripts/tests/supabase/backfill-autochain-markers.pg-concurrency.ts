/**
 * SMI-7121 plan Verification 5 (races) and 6b (two concurrent watcher calls), proven with TWO real
 * sessions. Registered from ./backfill-autochain-markers.pg.test.ts.
 *
 * WHY NOT THE SINGLE-TRANSACTION PATTERN. The other arms seed and call inside one rolled-back
 * transaction, which cannot express "session B runs while session A's transaction is open". Here the
 * seed is COMMITTED (autocommit on the control session) and `fixtureSql()` (which the suite's
 * beforeEach also runs) clears it afterwards.
 *
 * THE TRANSITION RACE. Session A runs a transition inside an open transaction, so it holds the
 * marker's row lock and its write is uncommitted. Session B's UPDATE matches the old row version
 * (state still 'open' in its snapshot) and BLOCKS on that row lock. When A commits, READ COMMITTED
 * re-evaluates B's WHERE against the new version: if A changed the state, B matches zero rows and
 * returns false. Each race arm first PROVES B is blocked (a lock waiter in pg_stat_activity) before
 * A commits; without that, B could simply run after A and the arm would prove nothing about a race.
 *
 * @module scripts/tests/supabase/backfill-autochain-markers.pg-concurrency
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  ALERT,
  PsqlSession,
  WATCH,
  count,
  fixtureSql,
  lines,
  markerRow,
  requireTestConn,
  standardSecrets,
  transition,
  type Ctx,
} from './backfill-autochain-markers.test-helpers.ts'

const posts = count('posts', 'net.calls')
const alerts = count('alerts', `audit_logs WHERE event_type = '${ALERT}'`)
const meta = (id: string) => `SELECT metadata::text FROM audit_logs WHERE id = '${id}';`

/** Poll until some other backend waits on a lock while running `needle`; throw if none appears. */
async function waitForLockWaiter(ctl: PsqlSession, needle: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await ctl.send(
      `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' ` +
        `AND pid <> pg_backend_pid() AND query LIKE '%${needle}%';`
    )
    if (Number(r.stdout.trim()) >= 1) return
    if (Date.now() > deadline) throw new Error(`no session blocked on a lock running ${needle}`)
    await new Promise((res) => setTimeout(res, 50))
  }
}

export function registerConcurrencyTests(ctx: Ctx): void {
  describe('races: two real sessions', () => {
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

    const seedMarker = async (id: string, when = '1 hour') => {
      const s = await ctx.ctl().send(markerRow(id, when))
      expect(s.stderr, 'seed committed').not.toMatch(/ERROR/)
    }

    /** A runs `aStmt` in an open transaction; B fires `bStmt`, which must block; A then commits. */
    async function race(aStmt: string, bStmt: string) {
      const aRun = await a.send(`BEGIN;\n${aStmt}`)
      expect(aRun.stderr, 'A ran').not.toMatch(/ERROR/)
      const bPending = b.fire(bStmt)
      await waitForLockWaiter(ctx.ctl(), 'backfill_autochain_marker_transition')
      await a.send('COMMIT;')
      const bRun = await bPending
      expect(bRun.stderr, 'B ran').not.toMatch(/ERROR/)
      return { a: lines(aRun), b: lines(bRun) }
    }

    it('two concurrent claims on one marker: exactly one returns true; the winner owns the marker', async () => {
      await seedMarker('m1')
      const r = await race(
        transition('a', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"A"}'),
        transition('b', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"B"}')
      )
      expect([...r.a, ...r.b]).toEqual(['a=true', 'b=false'])
      const m = JSON.parse((await ctx.ctl().send(meta('m1'))).stdout)
      expect(m.state).toBe('consumed')
      expect(m.consumed_by_autochain_run).toBe('A')
    })

    it.each([
      ['a claim held, needs_intervention racing it', 'consumed', 'needs_intervention', 'consumed'],
      [
        'needs_intervention held, a claim racing it',
        'needs_intervention',
        'consumed',
        'needs_intervention',
      ],
    ] as Array<[string, string, string, string]>)(
      '%s: exactly one winner, and the loser changes nothing',
      async (_label, aTo, bTo, finalState) => {
        await seedMarker('m1')
        const r = await race(
          transition('a', 'm1', 'open', aTo, '{"by":"A"}'),
          transition('b', 'm1', 'open', bTo, '{"by":"B"}')
        )
        expect([...r.a, ...r.b]).toEqual(['a=true', 'b=false'])
        const m = JSON.parse((await ctx.ctl().send(meta('m1'))).stdout)
        expect(m.state).toBe(finalState)
        expect(m.by).toBe('A')
      }
    )

    it('a concurrent writer that left the state alone: the blocked claim merges onto the NEW row and keeps both fields', async () => {
      // A is any other writer that adds a field without changing state. B's claim matched the old
      // version, blocks, and after A commits re-evaluates against the new one: state is still open,
      // so it applies, and because the merge is server-side it merges onto A's version. A client
      // that read the row before A and wrote back a full object would erase A's field (R2-7).
      await seedMarker('m1')
      const r = await race(
        'UPDATE audit_logs SET metadata = metadata || \'{"note":"from-A"}\' WHERE id = \'m1\';',
        transition('b', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"B"}')
      )
      expect(r.b).toEqual(['b=true'])
      const m = JSON.parse((await ctx.ctl().send(meta('m1'))).stdout)
      expect(m.note, "A's field survived").toBe('from-A')
      expect(m.consumed_by_autochain_run, "B's field landed").toBe('B')
      expect(m.state).toBe('consumed')
      expect(m.completed_run_id, 'the original fields survived').toBe('run-m1')
    })

    it('A rolling back releases the row: the blocked claim then wins (a lost claim never strands the marker)', async () => {
      await seedMarker('m1')
      await a.send(`BEGIN;\n${transition('a', 'm1', 'open', 'consumed', '{"by":"A"}')}`)
      const bPending = b.fire(transition('b', 'm1', 'open', 'consumed', '{"by":"B"}'))
      await waitForLockWaiter(ctx.ctl(), 'backfill_autochain_marker_transition')
      await a.send('ROLLBACK;')
      expect(lines(await bPending)).toEqual(['b=true'])
      expect(JSON.parse((await ctx.ctl().send(meta('m1'))).stdout).by).toBe('B')
    })

    describe('watcher revalidates each candidate under a row lock (gate fix 6)', () => {
      it('(a) a transition that commits after the watcher selected the marker, before it revalidates: no stalled alert for it', async () => {
        // Staging the interleaving without a test hook: two stale open markers, m0 older so the
        // watcher processes it first. B holds an ACCESS EXCLUSIVE lock on net.calls (the pg_net
        // stub's table), so the watcher's cursor has already selected BOTH markers when it blocks on
        // m0's send. While it waits, B moves m1 to consumed (m1 is not yet locked by the watcher)
        // and commits, which releases net.calls. The watcher then sends m0 and revalidates m1 on a
        // fresh snapshot: m1 is no longer open, so no stalled alert is sent for it.
        const seed = await ctx
          .ctl()
          .send(
            [standardSecrets(), markerRow('m0', '14 hours'), markerRow('m1', '13 hours')].join('\n')
          )
        expect(seed.stderr, 'seed committed').not.toMatch(/ERROR/)

        await b.send('BEGIN;\nLOCK TABLE net.calls IN ACCESS EXCLUSIVE MODE;')
        const aPending = a.fire(WATCH)
        await waitForLockWaiter(ctx.ctl(), 'check_backfill_autochain_markers')
        const bMove = await b.send(
          transition('b', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"B"}')
        )
        expect(lines(bMove)).toEqual(['b=true'])
        await b.send('COMMIT;')
        const aRun = await aPending
        expect(aRun.stderr, 'the watcher ran without error').not.toMatch(/ERROR/)

        const after = await ctx
          .ctl()
          .send(
            `${posts}\n${alerts}\n` +
              `SELECT string_agg(metadata->>'marker_id', ',' ORDER BY metadata->>'marker_id') FROM audit_logs WHERE event_type = '${ALERT}';`
          )
        expect(lines(after), 'only m0 was alerted; m1 was revalidated and skipped').toEqual([
          'posts=1',
          'alerts=1',
          'm0',
        ])
      })

      it('(b) a marker held by an uncommitted transition is skipped, without blocking or error, and the transition then commits', async () => {
        await ctx.ctl().send([standardSecrets(), markerRow('m1', '13 hours')].join('\n'))
        const bMove = await b.send(
          `BEGIN;\n${transition('b', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"B"}')}`
        )
        expect(lines(bMove)).toEqual(['b=true'])
        let aRun: { stdout: string; stderr: string }
        try {
          // A short timeout: a watcher that waited on B's row lock would hang here.
          aRun = await a.send(`${WATCH}\n${posts}\n${alerts}`, 5_000)
        } finally {
          await b.send('COMMIT;')
        }
        expect(aRun.stderr, 'no error').not.toMatch(/ERROR/)
        expect(lines(aRun), 'the held marker was skipped').toEqual(['posts=0', 'alerts=0'])
        const state = await ctx
          .ctl()
          .send("SELECT metadata->>'state' FROM audit_logs WHERE id = 'm1';")
        expect(lines(state), "B's transition committed normally").toEqual(['consumed'])
      })
    })

    describe('watcher falls back to the unlocked read past a 12h wider bound when a row is held (gate round 2)', () => {
      const alertSummary =
        `SELECT 'alert=' || (metadata->>'kind') || ',' || (metadata->>'marker_id') || ',row_locked=' || ` +
        `coalesce(metadata->>'row_locked', 'NULL') FROM audit_logs WHERE event_type = '${ALERT}' ORDER BY created_at;`
      const lockedMsg =
        "SELECT 'msg_locked=' || (body->>'message' LIKE '%locked by another session%') FROM net.calls;"

      /** B holds m1's row with an uncommitted transition; A runs `aSql` (5s cap); B then commits. */
      async function whileHeld(bTransition: string, aSql: string) {
        const bMove = await b.send(`BEGIN;\n${bTransition}`)
        expect(lines(bMove), 'B moved the marker (uncommitted)').toEqual(['b=true'])
        let aRun: { stdout: string; stderr: string }
        try {
          aRun = await a.send(aSql, 5_000)
        } finally {
          const commit = await b.send('COMMIT;')
          expect(commit.stderr, "B's transition committed normally").not.toMatch(/ERROR/)
        }
        expect(aRun.stderr, 'the watcher did not error').not.toMatch(/ERROR/)
        return lines(aRun)
      }

      /** A consumed marker whose consumed_at is `ago` old, created 20h ago. */
      const consumedSeed = (ago: string) =>
        "INSERT INTO audit_logs (id, event_type, metadata, created_at) VALUES ('m1', " +
        "'indexer_backfill_autochain_deferred', jsonb_build_object('state', 'consumed', " +
        `'completed_run_id', 'r1', 'consumed_at', (now() - interval '${ago}')::text), ` +
        "now() - interval '20 hours');"

      it('(c) stalled 25h, row held: the watcher does not block and sends one stalled alert marked row_locked; B commits', async () => {
        await ctx.ctl().send([standardSecrets(), markerRow('m1', '25 hours')].join('\n'))
        const out = await whileHeld(
          transition('b', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"B"}'),
          `${WATCH}\n${posts}\n${alertSummary}\n${lockedMsg}`
        )
        expect(out).toEqual(['posts=1', 'alert=stalled,m1,row_locked=true', 'msg_locked=true'])
        expect(JSON.parse((await ctx.ctl().send(meta('m1'))).stdout).state).toBe('consumed')
      })

      it('(d) stalled 13h (stale, but under the 24h bound), row held: no POST, no error', async () => {
        await ctx.ctl().send([standardSecrets(), markerRow('m1', '13 hours')].join('\n'))
        const out = await whileHeld(
          transition('b', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"B"}'),
          `${WATCH}\n${posts}\n${alerts}`
        )
        expect(out).toEqual(['posts=0', 'alerts=0'])
      })

      it.each([
        ['14 hours', ['posts=1', 'alert=unreconciled,m1,row_locked=true']],
        ['2 hours', ['posts=0']],
      ] as Array<[string, string[]]>)(
        '(e) unreconciled, consumed_at %s ago, row held -> %j',
        async (ago, expected) => {
          await ctx.ctl().send([standardSecrets(), consumedSeed(ago)].join('\n'))
          const out = await whileHeld(
            transition('b', 'm1', 'consumed', 'dispatched', '{"dispatched_run_id":"r9"}'),
            `${WATCH}\n${posts}\n${alertSummary}`
          )
          expect(out).toEqual(expected)
          expect(JSON.parse((await ctx.ctl().send(meta('m1'))).stdout).state).toBe('dispatched')
        }
      )

      it('(f) repeated ticks while B stays open: the second call does not re-send (the first alert is pending)', async () => {
        await ctx.ctl().send([standardSecrets(), markerRow('m1', '25 hours')].join('\n'))
        const out = await whileHeld(
          transition('b', 'm1', 'open', 'consumed', '{"consumed_by_autochain_run":"B"}'),
          `${WATCH}\n${WATCH}\n${posts}\n${alerts}`
        )
        expect(out).toEqual(['posts=1', 'alerts=1'])
      })
    })

    describe('watcher advisory lock', () => {
      const seedStale = async () => {
        const s = await ctx.ctl().send([standardSecrets(), markerRow('m1', '13 hours')].join('\n'))
        expect(s.stderr, 'seed committed').not.toMatch(/ERROR/)
      }

      it('B called while A holds the lock sends nothing; after A commits there is exactly one POST and one alert row', async () => {
        await seedStale()
        const aRun = await a.send(`BEGIN;\n${WATCH}`)
        expect(aRun.stderr, 'A ran').not.toMatch(/ERROR/)

        // B, with A's transaction still open: its own view must show zero POSTs and zero alerts.
        const bRun = await b.send(`BEGIN;\n${WATCH}\n${posts}\n${alerts}\nCOMMIT;`)
        expect(bRun.stderr).not.toMatch(/ERROR/)
        expect(lines(bRun), 'B did no work while A held the lock').toEqual(['posts=0', 'alerts=0'])

        await a.send('COMMIT;')
        expect(lines(await ctx.ctl().send(`${posts}\n${alerts}`)), 'one alert in total').toEqual([
          'posts=1',
          'alerts=1',
        ])
      })

      it('once A has committed its alert, a later call is deduplicated (the pending alert is visible)', async () => {
        await seedStale()
        await a.send(`BEGIN;\n${WATCH}\nCOMMIT;`)
        expect(lines(await b.send(`${WATCH}\n${posts}\n${alerts}`))).toEqual([
          'posts=1',
          'alerts=1',
        ])
      })

      it('A rolling back releases the lock; B then alerts (the lock does not strand the alert)', async () => {
        await seedStale()
        await a.send(`BEGIN;\n${WATCH}`)
        await a.send('ROLLBACK;')
        expect(lines(await b.send(`${WATCH}\n${posts}\n${alerts}`))).toEqual([
          'posts=1',
          'alerts=1',
        ])
      })

      it("the watcher's key is its own: with A holding the SMI-7114 dead-man key, B still alerts", async () => {
        await seedStale()
        await a.send(
          "BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('check_refresh_observer_heartbeat', 0));"
        )
        const bRun = await b.send(`BEGIN;\n${WATCH}\n${posts}\n${alerts}\nCOMMIT;`)
        expect(bRun.stderr).not.toMatch(/ERROR/)
        expect(lines(bRun)).toEqual(['posts=1', 'alerts=1'])
      })
    })
  })
}
