/**
 * SMI-7050 (ADR-178 property 5) -- live-Postgres suite for the volume monitor's claim protocol:
 * T-SQL-1 to T-SQL-10 of docs/internal/implementation/smi-7050-registry-audit-volume-monitor.md.
 * Harness, env vars and the real-vs-stubbed inventory: ./registry-audit-volume-claim.test-helpers.ts.
 *
 * CI SKIPS THIS FILE (no workflow sets SMI7050_TEST_PG*), so it is the implementing session's job
 * to run it and record the output on SMI-7050. The PG-free assertions about the migrations' text
 * live in ./registry-audit-volume-monitor.structural.test.ts.
 *
 * Every arm that depends on time runs its seed and its calls in ONE transaction (helpers:
 * `inTxn`), so `now()` is the same instant for both and the 24h boundary is exact.
 */

import { describe, it, beforeAll, beforeEach, afterAll, expect } from 'vitest'
import {
  A,
  B,
  PsqlSession,
  STATE_FNS,
  TOK1,
  TOK2,
  buildSql,
  claim,
  fixtureSql,
  healthClaim,
  healthSettle,
  inTxn,
  inTxnExpectingError,
  noLiveTestPg,
  offenders,
  q,
  requireTestConn,
  rowState,
  scalarQuery,
  seedAlerted,
  seedClaimed,
  settle,
  sqlstate,
} from './registry-audit-volume-claim.test-helpers.ts'
import { registerRoleTests } from './registry-audit-volume-claim.pg-roles.ts'

describe.skipIf(noLiveTestPg)(
  'SMI-7050 -- registry-audit volume monitor claim protocol',
  { timeout: 120_000 },
  () => {
    let ctl: PsqlSession
    let s1: PsqlSession
    let s2: PsqlSession

    beforeAll(async () => {
      const conn = requireTestConn()
      ctl = new PsqlSession(conn, 'ctl')
      s1 = new PsqlSession(conn, 's1')
      s2 = new PsqlSession(conn, 's2')
      for (const s of [ctl, s1, s2]) await s.send('\\set VERBOSITY verbose')
      const res = await ctl.send(buildSql())
      expect(res.stderr, `schema + migrations build failed:\n${res.stderr}`).not.toMatch(/ERROR/)
      // Presence: the build really applied migration A (its NOTICE) and left six functions behind.
      expect(res.stderr).toMatch(/SMI-7050 smoke: passed/)
      const n = await scalarQuery(
        ctl,
        `SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${STATE_FNS.join("','")}');`
      )
      expect(n, 'the six state functions exist after the build').toBe('6')
    }, 90_000)

    afterAll(async () => {
      for (const s of [ctl, s1, s2]) await s?.close()
    })

    beforeEach(async () => {
      for (const s of [s1, s2]) await s.send('ROLLBACK;')
      const fx = await ctl.send(fixtureSql())
      expect(fx.stderr, `fixture reload failed:\n${fx.stderr}`).not.toMatch(/ERROR/)
    })

    // ------------------------------------------------------------------------
    // T-SQL-1: concurrent claim
    // ------------------------------------------------------------------------
    describe('T-SQL-1 concurrent claim', () => {
      it.each([
        ['the actor row already exists', true],
        ['the actor is absent beforehand (both insert)', false],
      ])('exactly one of two overlapping claims wins when %s', async (_label, preExisting) => {
        if (preExisting) {
          const seed = await ctl.send(
            `INSERT INTO registry_audit_volume_alert_state (actor, degraded_since) VALUES (${q(A)}, now());`
          )
          expect(seed.stderr).not.toMatch(/ERROR/)
        }
        const first = await s1.send(`BEGIN;\n${claim(offenders(A), TOK1)}`)
        expect(first.stderr).not.toMatch(/ERROR/)
        expect(first.stdout, 'presence: S1 won A').toContain(`claim=${A}`)

        let secondSettled = false
        const second = s2.fire(claim(offenders(A), TOK2)).then((r) => {
          secondSettled = true
          return r
        })
        await new Promise((r) => setTimeout(r, 600))
        expect(secondSettled, 'S2 must be BLOCKED on S1 row lock, not answered early').toBe(false)

        await s1.send('COMMIT;')
        const res = await second
        expect(res.stderr).not.toMatch(/ERROR/)
        expect(res.stdout, 'S2 must not also win').toBe('claim=')
        const owner = await scalarQuery(
          ctl,
          `SELECT claim_token FROM registry_audit_volume_alert_state WHERE actor = ${q(A)};`
        )
        expect(owner, 'the row holds the winner token').toBe(TOK1)
      })
    })

    // ------------------------------------------------------------------------
    // T-SQL-2: the 24h boundary on last_alerted_at
    // ------------------------------------------------------------------------
    it('T-SQL-2 exactly 24h is still suppressed; strictly more is claimable', async () => {
      const arm = (ago: string) =>
        inTxn(ctl, [
          claim(offenders(A), TOK1),
          settle(TOK1, 'sent'),
          seedAlerted(A, ago),
          claim(offenders(A), TOK2),
        ])
      const over = await arm('24 hours 1 microsecond')
      expect(over.stderr).not.toMatch(/ERROR/)
      expect(over.lines, 'presence: over-24h arm claims A').toEqual([
        `claim=${A}`,
        'settle=1',
        `claim=${A}`,
      ])
      const exact = await arm('24 hours')
      expect(exact.lines, 'exactly 24h is suppressed').toEqual([`claim=${A}`, 'settle=1', 'claim='])
    })

    // ------------------------------------------------------------------------
    // T-SQL-3: no lease on an unsettled claim
    // ------------------------------------------------------------------------
    it('T-SQL-3 an unsettled claim is not reclaimable before 24h (no lease)', async () => {
      const arm = (ago: string) =>
        inTxn(ctl, [claim(offenders(A), TOK1), seedClaimed(A, ago), claim(offenders(A), TOK2)])
      const reclaimed = await arm('24 hours 1 microsecond')
      expect(reclaimed.lines, 'presence: the oldest arm is reclaimed').toEqual([
        `claim=${A}`,
        `claim=${A}`,
      ])
      for (const ago of ['16 minutes', '23 hours', '24 hours']) {
        const r = await arm(ago)
        expect(r.lines, `a claim ${ago} old is still held`).toEqual([`claim=${A}`, 'claim='])
      }
    })

    // ------------------------------------------------------------------------
    // T-SQL-4: a definite failure stays retryable
    // ------------------------------------------------------------------------
    it('T-SQL-4 settle failed releases the claim and leaves last_alerted_at untouched', async () => {
      const fresh = await inTxn(ctl, [
        claim(offenders(A), TOK1),
        settle(TOK1, 'failed'),
        rowState(A),
        claim(offenders(A), TOK2),
      ])
      expect(fresh.stderr).not.toMatch(/ERROR/)
      expect(fresh.lines).toEqual([
        `claim=${A}`,
        'settle=1',
        `row[${A}]=token=null,alerted=false,outcome=failed`,
        `claim=${A}`,
      ])

      const aged = await inTxn(ctl, [
        claim(offenders(A), TOK1),
        settle(TOK1, 'sent'),
        seedAlerted(A, '25 hours'),
        claim(offenders(A), TOK2),
        settle(TOK2, 'failed'),
        `SELECT 'kept=' || (last_alerted_at = now() - interval '25 hours') ` +
          `FROM registry_audit_volume_alert_state WHERE actor = ${q(A)};`,
      ])
      expect(aged.lines.at(-1), 'failed did not move last_alerted_at').toBe('kept=true')
      expect(aged.lines.at(-2), 'presence: the failed settle matched a row').toBe('settle=1')
    })

    // ------------------------------------------------------------------------
    // T-SQL-5: health rows
    // ------------------------------------------------------------------------
    describe('T-SQL-5 health', () => {
      it('concurrent claim of one kind: one true, one false', async () => {
        const first = await s1.send(`BEGIN;\n${healthClaim('late', TOK1)}`)
        expect(first.stdout, 'presence: S1 won').toBe('hclaim=true')
        let secondSettled = false
        const second = s2.fire(healthClaim('late', TOK2)).then((r) => {
          secondSettled = true
          return r
        })
        await new Promise((r) => setTimeout(r, 600))
        expect(secondSettled, 'S2 must be blocked on the seeded row').toBe(false)
        await s1.send('COMMIT;')
        expect((await second).stdout).toBe('hclaim=false')
      })

      it('unknown kind or outcome raises 22023, never a silent false', async () => {
        const claimRes = await inTxnExpectingError(ctl, [healthClaim('lates', TOK1)])
        expect(claimRes.state).toBe('22023')
        const settleRes = await inTxnExpectingError(ctl, [healthSettle('lates', TOK1, 'sent')])
        expect(settleRes.state).toBe('22023')
        const outcomeRes = await inTxnExpectingError(ctl, [healthSettle('late', TOK1, 'bogus')])
        expect(outcomeRes.state).toBe('22023')
      })

      it('failed leaves the kind claimable; unconfirmed holds it for 24h', async () => {
        const failed = await inTxn(ctl, [
          healthClaim('error', TOK1),
          healthSettle('error', TOK1, 'failed'),
          healthClaim('error', TOK2),
        ])
        expect(failed.lines).toEqual(['hclaim=true', 'hsettle=1', 'hclaim=true'])
        const held = await inTxn(ctl, [
          healthClaim('error', TOK1),
          healthSettle('error', TOK1, 'unconfirmed'),
          healthClaim('error', TOK2),
          `UPDATE registry_audit_volume_monitor_health SET last_alerted_at = now() - interval '24 hours 1 microsecond' WHERE kind = 'error';`,
          healthClaim('error', TOK2),
        ])
        expect(held.lines).toEqual(['hclaim=true', 'hsettle=1', 'hclaim=false', 'hclaim=true'])
      })

      it('a settle with a stale token cannot touch a newer health claim', async () => {
        const r = await inTxn(ctl, [
          healthClaim('state_write', TOK1),
          `UPDATE registry_audit_volume_monitor_health SET claimed_at = now() - interval '24 hours 1 microsecond' WHERE kind = 'state_write';`,
          healthClaim('state_write', TOK2),
          healthSettle('state_write', TOK1, 'sent'),
          healthSettle('state_write', TOK2, 'sent'),
        ])
        expect(r.lines).toEqual(['hclaim=true', 'hclaim=true', 'hsettle=0', 'hsettle=1'])
      })
    })

    // ------------------------------------------------------------------------
    // T-SQL-6: clear
    // ------------------------------------------------------------------------
    describe('T-SQL-6 clear', () => {
      const clear = (actors: string) =>
        `SELECT 'cleared=' || public.clear_registry_audit_volume_alerts(${q(actors)}::jsonb);`
      const ins = (actor: string, alerted: string, claimed: string) =>
        `INSERT INTO registry_audit_volume_alert_state (actor, degraded_since, last_alerted_at, claim_token, claimed_at) ` +
        `VALUES (${q(actor)}, now(), ${alerted}, ${claimed === 'NULL' ? 'NULL' : q(TOK1) + '::uuid'}, ${claimed});`

      it.each([
        ['(a) absent, unclaimed, never alerted', 'NULL', 'NULL', 1],
        ['(b) absent, unclaimed, alerted 2h ago', "now() - interval '2 hours'", 'NULL', 0],
        ['(c) absent, alerted 25h ago', "now() - interval '25 hours'", 'NULL', 1],
        ['(d) absent, claim 1h old', 'NULL', "now() - interval '1 hour'", 0],
        ['(d2) absent, claim 24h+1us old', 'NULL', "now() - interval '24 hours 1 microsecond'", 1],
      ])('%s', async (_label, alerted, claimed, deleted) => {
        const r = await inTxn(ctl, [ins('x', alerted, claimed), clear('[]'), rowState('x')])
        expect(r.stderr).not.toMatch(/ERROR/)
        expect(r.lines[0], 'cleared count').toBe(`cleared=${deleted}`)
        if (deleted === 1) expect(r.lines[1], 'row is gone').toBe('row[x]=absent')
        else expect(r.lines[1], 'row survives').toMatch(/^row\[x\]=token=/)
      })

      it('(e) an actor present in this run is kept even when otherwise eligible', async () => {
        const r = await inTxn(ctl, [ins('x', 'NULL', 'NULL'), clear('["x"]'), rowState('x')])
        expect(r.lines[0]).toBe('cleared=0')
        expect(r.lines[1]).toMatch(/^row\[x\]=token=/)
      })

      it.each([
        ['SQL NULL', 'NULL'],
        ['JSON null', q('null') + '::jsonb'],
        ['object', q('{}') + '::jsonb'],
        ['scalar string', q('"x"') + '::jsonb'],
        ['array with a null element', q('[null]') + '::jsonb'],
        ['array with an empty-string element', q('[""]') + '::jsonb'],
        ['array with a non-string element', q('[5]') + '::jsonb'],
      ])('(f) %s raises 22023 and deletes nothing', async (_label, arg) => {
        await ctl.send(ins('x', 'NULL', 'NULL'))
        const res = await ctl.send(`SELECT public.clear_registry_audit_volume_alerts(${arg});`)
        expect(sqlstate(res), res.stderr).toBe('22023')
        const n = await scalarQuery(ctl, 'SELECT count(*) FROM registry_audit_volume_alert_state;')
        expect(n, 'presence: the eligible row survived the refused call').toBe('1')
      })
    })

    registerRoleTests({ ctl: () => ctl, s1: () => s1, s2: () => s2 })

    // ------------------------------------------------------------------------
    // T-SQL-8: the D5 bound, walked
    // ------------------------------------------------------------------------
    describe('T-SQL-8 the D5 bound', () => {
      it.each(['unconfirmed', 'sent', 'shadow'])(
        'after a %s settle, no claim until strictly more than 24h',
        async (outcome) => {
          const r = await inTxn(ctl, [
            claim(offenders(A), TOK1),
            settle(TOK1, outcome),
            claim(offenders(A), TOK2),
            seedAlerted(A, '1 hour'),
            claim(offenders(A), TOK2),
            seedAlerted(A, '24 hours'),
            claim(offenders(A), TOK2),
            seedAlerted(A, '24 hours 1 microsecond'),
            claim(offenders(A), TOK2),
          ])
          expect(r.stderr).not.toMatch(/ERROR/)
          expect(r.lines).toEqual([
            `claim=${A}`,
            'settle=1',
            'claim=',
            'claim=',
            'claim=',
            `claim=${A}`,
          ])
        }
      )

      it('a failed settle is retryable at once', async () => {
        const r = await inTxn(ctl, [
          claim(offenders(A), TOK1),
          settle(TOK1, 'failed'),
          claim(offenders(A), TOK2),
        ])
        expect(r.lines).toEqual([`claim=${A}`, 'settle=1', `claim=${A}`])
      })

      it('no settle: the claim itself counts as the delivery time', async () => {
        const r = await inTxn(ctl, [
          claim(offenders(A), TOK1),
          claim(offenders(A), TOK2),
          seedClaimed(A, '1 hour'),
          claim(offenders(A), TOK2),
          seedClaimed(A, '24 hours 1 microsecond'),
          claim(offenders(A), TOK2),
        ])
        expect(r.lines).toEqual([`claim=${A}`, 'claim=', 'claim=', `claim=${A}`])
      })
    })

    // ------------------------------------------------------------------------
    // T-SQL-9: a stale token cannot settle a newer claim
    // ------------------------------------------------------------------------
    it('T-SQL-9 an old token cannot settle over a newer reclaim', async () => {
      const r = await inTxn(ctl, [
        claim(offenders(A), TOK1),
        seedClaimed(A, '24 hours 1 microsecond'),
        claim(offenders(A), TOK2),
        settle(TOK1, 'failed'),
        rowState(A),
        settle(TOK2, 'sent'),
      ])
      expect(r.stderr).not.toMatch(/ERROR/)
      expect(r.lines).toEqual([
        `claim=${A}`,
        `claim=${A}`,
        'settle=0',
        `row[${A}]=token=${TOK2},alerted=false,outcome=null`,
        'settle=1',
      ])
    })

    // ------------------------------------------------------------------------
    // T-SQL-10: the p_offenders contract
    // ------------------------------------------------------------------------
    describe('T-SQL-10 p_offenders contract', () => {
      const el = (o: Record<string, unknown>) => JSON.stringify([o])
      const good = { actor: A, bucket: '2026-10-10T10:00:00Z', cnt: 201 }
      const refused: Array<[string, string]> = [
        ['SQL NULL', 'NULL'],
        ['JSON null', q('null')],
        ['object', q('{}')],
        ['scalar string', q('"x"')],
        ['scalar number', q('5')],
        ['array with a null element', q('[null]')],
        ['null actor', q(el({ ...good, actor: null }))],
        ['empty-string actor', q(el({ ...good, actor: '' }))],
        ['numeric actor', q(el({ ...good, actor: 5 }))],
        ['missing cnt', q(el({ actor: A, bucket: good.bucket }))],
        ['string cnt', q(el({ ...good, cnt: '201' }))],
        ['missing bucket', q(el({ actor: A, cnt: 201 }))],
        ['numeric bucket', q(el({ ...good, bucket: 5 }))],
        ['non-object element', q('[1]')],
        ['the same actor twice', q(JSON.stringify([good, { ...good, cnt: 300 }]))],
      ]

      it.each(refused)('%s raises 22023 and writes no row', async (_label, arg) => {
        const call = `SELECT * FROM public.claim_registry_audit_volume_alerts(${arg === 'NULL' ? 'NULL' : arg + '::jsonb'}, ${q(TOK1)}::uuid);`
        const res = await ctl.send(call)
        expect(sqlstate(res), res.stderr).toBe('22023')
        const n = await scalarQuery(ctl, 'SELECT count(*) FROM registry_audit_volume_alert_state;')
        expect(n, 'no row written by a refused call').toBe('0')
      })

      it('a NULL p_token raises 22023', async () => {
        const res = await ctl.send(
          `SELECT * FROM public.claim_registry_audit_volume_alerts(${q(offenders(A))}::jsonb, NULL);`
        )
        expect(sqlstate(res), res.stderr).toBe('22023')
      })

      it('an empty array is valid and claims nothing; a valid element is claimed', async () => {
        const empty = await inTxn(ctl, [claim('[]', TOK1)])
        expect(empty.stderr).not.toMatch(/ERROR/)
        expect(empty.lines).toEqual(['claim='])
        const ok = await inTxn(ctl, [claim(offenders(A, B), TOK1), rowState(A)])
        expect(ok.lines[0], 'both valid actors claimed').toBe(`claim=${A},${B}`)
        expect(ok.lines[1]).toBe(`row[${A}]=token=${TOK1},alerted=false,outcome=null`)
      })

      it('a bucket string that is not a timestamp fails with Postgres cast error 22007', async () => {
        const res = await ctl.send(
          `SELECT * FROM public.claim_registry_audit_volume_alerts(${q(
            el({ actor: A, bucket: 'not-a-time', cnt: 1 })
          )}::jsonb, ${q(TOK1)}::uuid);`
        )
        expect(sqlstate(res), res.stderr).toBe('22007')
      })
    })
  }
)
