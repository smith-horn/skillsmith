/**
 * SMI-7050 T-SQL-7: who may call what, and what no caller may pass in. Registered from
 * ./registry-audit-volume-claim.pg.test.ts (inside its describe, so its build and per-test fixture
 * reload apply). Kept in its own module to hold both files under the 500-line limit.
 *
 * The harness emulates hosted Supabase's default grants for functions AND tables, so a REVOKE that
 * is missing or too narrow shows up here as a successful call, not as a no-op.
 *
 * @module scripts/tests/supabase/registry-audit-volume-claim.pg-roles
 */

import { describe, it, expect } from 'vitest'
import {
  A,
  STATE_FNS,
  TOK1,
  claim,
  healthClaim,
  healthSettle,
  inTxn,
  inTxnExpectingError,
  offenders,
  q,
  rowState,
  scalarQuery,
  settle,
  sqlstate,
  type Ctx,
} from './registry-audit-volume-claim.test-helpers.ts'

const CALLS: Record<(typeof STATE_FNS)[number], string> = {
  claim_registry_audit_volume_alerts: claim(offenders(A), TOK1),
  settle_registry_audit_volume_alerts: settle(TOK1, 'sent'),
  count_stale_registry_audit_volume_claims:
    'SELECT public.count_stale_registry_audit_volume_claims();',
  clear_registry_audit_volume_alerts:
    "SELECT public.clear_registry_audit_volume_alerts('[]'::jsonb);",
  claim_registry_audit_volume_health: healthClaim('late', TOK1),
  settle_registry_audit_volume_health: healthSettle('late', TOK1, 'sent'),
}

const TABLES = ['registry_audit_volume_alert_state', 'registry_audit_volume_monitor_health']
const DISPATCHER = 'invoke_registry_audit_volume_monitor'
const AS = (role: string) => `SET LOCAL ROLE ${role};`

export function registerRoleTests(ctx: Ctx): void {
  describe('T-SQL-7 privilege model (D14) and no caller-controlled time (R3-1)', () => {
    it('service_role reaches all six functions and each changes state', async () => {
      const stale =
        `INSERT INTO registry_audit_volume_alert_state (actor, degraded_since, claim_token, claimed_at) ` +
        `VALUES ('user:stale', now(), ${q(TOK1)}::uuid, now() - interval '20 minutes');`
      const eligible = `INSERT INTO registry_audit_volume_alert_state (actor, degraded_since) VALUES ('user:gone', now());`
      const r = await inTxn(ctx.ctl(), [
        AS('service_role'),
        CALLS.claim_registry_audit_volume_alerts, // claim=user:A
        'RESET ROLE;',
        rowState(A), // owner view: the claim wrote this token
        AS('service_role'),
        CALLS.settle_registry_audit_volume_alerts, // settle=1
        'RESET ROLE;',
        rowState(A), // owner view: alerted now
        stale,
        eligible,
        AS('service_role'),
        "SELECT 'stale=' || public.count_stale_registry_audit_volume_claims();",
        "SELECT 'cleared=' || public.clear_registry_audit_volume_alerts('[]'::jsonb);",
        CALLS.claim_registry_audit_volume_health, // hclaim=true
        'RESET ROLE;',
        `SELECT 'htoken=' || (claim_token = ${q(TOK1)}::uuid) FROM registry_audit_volume_monitor_health WHERE kind = 'late';`,
        AS('service_role'),
        CALLS.settle_registry_audit_volume_health, // hsettle=1
        'RESET ROLE;',
        `SELECT 'halerted=' || (last_alerted_at IS NOT NULL) FROM registry_audit_volume_monitor_health WHERE kind = 'late';`,
        `SELECT 'gone=' || NOT EXISTS (SELECT 1 FROM registry_audit_volume_alert_state WHERE actor = 'user:gone');`,
      ])
      expect(r.stderr).not.toMatch(/ERROR/)
      expect(r.lines).toEqual([
        `claim=${A}`,
        `row[${A}]=token=${TOK1},alerted=false,outcome=null`,
        'settle=1',
        `row[${A}]=token=null,alerted=true,outcome=sent`,
        'stale=1',
        'cleared=1',
        'hclaim=true',
        'htoken=true',
        'hsettle=1',
        'halerted=true',
        'gone=true',
      ])
    })

    // count_stale reports a claim held unsettled for 15 minutes up to 24 hours; each age is
    // seeded alone (own transaction), so the count is attributable to exactly that row.
    it.each([
      ['14 minutes', 0],
      ['15 minutes', 0],
      ['15 minutes 1 microsecond', 1],
      ['20 minutes', 1],
      ['23 hours', 1],
      ['24 hours', 1],
      ['24 hours 1 microsecond', 0],
      ['3 days', 0],
    ])('count_stale: a claim %s old counts %i', async (ago, expected) => {
      const r = await inTxn(ctx.ctl(), [
        `INSERT INTO registry_audit_volume_alert_state (actor, degraded_since, claim_token, claimed_at) ` +
          `VALUES ('user:aged', now(), ${q(TOK1)}::uuid, now() - interval ${q(ago)});`,
        "SELECT 'rows=' || count(*) FROM registry_audit_volume_alert_state WHERE claim_token IS NOT NULL;",
        "SELECT 'stale=' || public.count_stale_registry_audit_volume_claims();",
      ])
      expect(r.stderr).not.toMatch(/ERROR/)
      expect(r.lines, 'presence: the seeded claim exists, then the count').toEqual([
        'rows=1',
        `stale=${expected}`,
      ])
    })

    for (const role of ['anon', 'authenticated']) {
      it.each(STATE_FNS)(`${role} is refused EXECUTE on %s with 42501`, async (fn) => {
        const r = await inTxnExpectingError(ctx.ctl(), [AS(role), CALLS[fn]])
        expect(r.state, r.stderr).toBe('42501')
        expect(r.stderr, 'refused for lack of EXECUTE, not for another reason').toMatch(
          new RegExp(`permission denied for function ${fn}`)
        )
      })
    }

    for (const role of ['service_role', 'anon', 'authenticated']) {
      it.each(TABLES)(`${role} has no direct SELECT or UPDATE on %s`, async (table) => {
        for (const stmt of [
          `SELECT count(*) FROM ${table};`,
          `UPDATE ${table} SET updated_at = now();`,
        ]) {
          const r = await inTxnExpectingError(ctx.ctl(), [AS(role), stmt])
          expect(r.state, `${role}: ${stmt}\n${r.stderr}`).toBe('42501')
          expect(r.stderr).toMatch(new RegExp(`permission denied for table ${table}`))
        }
      })
    }

    it('no state function takes a timestamp argument; the predicate does (positive control)', async () => {
      const names = STATE_FNS.map((f) => `'${f}'`).join(', ')
      const count = (extra: string) =>
        scalarQuery(
          ctx.ctl(),
          `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ` +
            `WHERE n.nspname = 'public' AND ${extra};`
        )
      const hasTs =
        `EXISTS (SELECT 1 FROM unnest(p.proargtypes::oid[]) AS t(typ) ` +
        `WHERE t.typ IN ('timestamptz'::regtype, 'timestamp'::regtype))`
      expect(await count(`p.proname IN (${names})`), 'presence: all six exist').toBe('6')
      expect(await count(`p.proname IN (${names}) AND ${hasTs}`), 'none takes a timestamp').toBe(
        '0'
      )
      expect(
        await count(`p.proname = 'registry_audit_volume_over_threshold' AND ${hasTs}`),
        'control: the check CAN see a timestamp argument (the predicate p_now)'
      ).toBe('1')
    })

    describe('dispatcher invoke_registry_audit_volume_monitor() (migration B)', () => {
      it.each(['anon', 'authenticated'])('%s is refused EXECUTE with 42501 (D3)', async (role) => {
        const r = await inTxnExpectingError(ctx.ctl(), [AS(role), `SELECT public.${DISPATCHER}();`])
        expect(r.state, r.stderr).toBe('42501')
        expect(r.stderr).toMatch(new RegExp(`permission denied for function ${DISPATCHER}`))
      })

      it('service_role may call it; it POSTs once to the function path with the bearer key', async () => {
        await ctx
          .ctl()
          .send(
            `INSERT INTO vault.decrypted_secrets VALUES ` +
              `('registry_audit_volume_monitor_functions_base_url', 'https://x.example'), ` +
              `('registry_audit_volume_monitor_service_role_key', 'key-123');`
          )
        const r = await inTxn(ctx.ctl(), [
          AS('service_role'),
          `SELECT public.${DISPATCHER}();`,
          'RESET ROLE;',
          `SELECT 'calls=' || count(*) FROM net.calls;`,
          `SELECT 'url=' || url FROM net.calls;`,
          `SELECT 'auth=' || (headers->>'Authorization') FROM net.calls;`,
        ])
        expect(r.stderr).not.toMatch(/ERROR/)
        expect(r.lines.slice(-3)).toEqual([
          'calls=1',
          'url=https://x.example/functions/v1/registry-audit-volume-monitor',
          'auth=Bearer key-123',
        ])
      })

      it.each([
        ['no secrets at all', [], 'registry_audit_volume_monitor_functions_base_url not found'],
        [
          'base url but no key',
          ["('registry_audit_volume_monitor_functions_base_url', 'https://x.example')"],
          'registry_audit_volume_monitor_service_role_key not found',
        ],
      ])('RAISES when %s are in Vault', async (_label, rows, message) => {
        if (rows.length)
          await ctx.ctl().send(`INSERT INTO vault.decrypted_secrets VALUES ${rows.join(', ')};`)
        const res = await ctx.ctl().send(`SELECT public.${DISPATCHER}();`)
        expect(sqlstate(res), res.stderr).toBe('P0001')
        expect(res.stderr).toContain(message)
        expect(await scalarQuery(ctx.ctl(), 'SELECT count(*) FROM net.calls;')).toBe('0')
      })

      it('is scheduled hourly at :12 and the job calls only the dispatcher', async () => {
        const row = await scalarQuery(
          ctx.ctl(),
          `SELECT schedule || '|' || command FROM cron.job WHERE jobname = 'registry-audit-volume-monitor';`
        )
        expect(row).toBe(`12 * * * *|SELECT public.${DISPATCHER}()`)
      })
    })
  })
}
