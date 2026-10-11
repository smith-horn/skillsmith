/**
 * SMI-7050 -- the PG-FREE half of the registry-audit volume monitor's database suite. It reads
 * migration text only, carries no Postgres gate and runs everywhere. Its one gate is the
 * git-crypt lock state (SMI-5984): on a DECLARED locked checkout the migrations are ciphertext and
 * the suite skips; an UNDECLARED lock throws, so a real unlock failure cannot hide inside a skip.
 *
 * THIS IS A TRIPWIRE, NOT A SECURITY PROOF. Text checks are lexical stand-ins for properties only
 * the live-Postgres half (registry-audit-volume-claim.pg.test.ts) proves. Each check is paired with
 * a known-negative: the same predicate run on a deliberately broken copy of the text must FAIL, so
 * a predicate that cannot see the thing it guards cannot pass silently.
 *
 * @module scripts/tests/supabase/registry-audit-volume-monitor.structural
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractFunction } from './pg-session.ts'
import { stripComments } from '../lib/sql-statement-guards.ts'
import { readMigrationText } from '../lib/migration-text-guards.ts'
import { MIG_A, MIG_B, STATE_FNS } from './registry-audit-volume-claim.test-helpers.ts'

const SQL_A = readMigrationText(MIG_A)
const SQL_B = readMigrationText(MIG_B)
const locked = SQL_A === null || SQL_B === null
const a = stripComments(SQL_A ?? '')
const b = stripComments(SQL_B ?? '')

const ROLLBACK_A = 'supabase/rollbacks/20261010000000_registry_audit_volume_alert_state_down.sql'
const ROLLBACK_B =
  'supabase/rollbacks/20261010000001_registry_audit_volume_monitor_pg_cron_down.sql'
const TABLES = ['registry_audit_volume_alert_state', 'registry_audit_volume_monitor_health']
const JOB = 'registry-audit-volume-monitor'

/** Argument lists, exactly as the REVOKE / GRANT statements spell them. */
const SIGS: Record<(typeof STATE_FNS)[number], string> = {
  claim_registry_audit_volume_alerts: 'JSONB, UUID',
  settle_registry_audit_volume_alerts: 'UUID, TEXT',
  count_stale_registry_audit_volume_claims: '',
  clear_registry_audit_volume_alerts: 'JSONB',
  claim_registry_audit_volume_health: 'TEXT, UUID',
  settle_registry_audit_volume_health: 'TEXT, UUID, TEXT',
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const header = (sql: string) => sql.slice(0, sql.search(/\bRETURNS\b/))

/** True when `sql` has the named conflict target on the actor claim and no bare ON CONFLICT DO. */
const namedConflictTarget = (sql: string) =>
  /ON CONFLICT \(actor\) DO UPDATE/.test(sql) && !/ON CONFLICT\s+DO\b/.test(sql)

describe.skipIf(locked)(
  'SMI-7050 -- volume monitor state + dispatcher migrations (PG-free)',
  () => {
    it('the files, their paired rollbacks and the schema_version numbers', () => {
      for (const p of [ROLLBACK_A, ROLLBACK_B])
        expect(existsSync(join(process.cwd(), p)), `${p} exists`).toBe(true)
      expect(a).toMatch(
        /INSERT INTO schema_version \(version\) VALUES \(121\) ON CONFLICT \(version\) DO NOTHING;/
      )
      expect(b).toMatch(
        /INSERT INTO schema_version \(version\) VALUES \(122\) ON CONFLICT \(version\) DO NOTHING;/
      )
      expect(a, 'NOTICE names the collision outcome').toMatch(
        /numbering collision; the rollback must NOT delete it/
      )
      expect(b, 'NOTICE names the collision outcome').toMatch(
        /numbering collision; the rollback must NOT delete it/
      )
    })

    it('tables: RLS on, no policy, ALL revoked from every API role including service_role', () => {
      for (const t of TABLES) {
        expect(a).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY;`))
        expect(a).toMatch(
          new RegExp(
            `REVOKE ALL ON TABLE public\\.${t}\\s+FROM PUBLIC, anon, authenticated, service_role;`
          )
        )
      }
      expect(a).not.toMatch(/CREATE POLICY/)
      expect(a).not.toMatch(/GRANT [A-Z, ]+ ON (TABLE )?public\.registry_audit_volume/)
      const missingServiceRole = a.replace(
        /FROM PUBLIC, anon, authenticated, service_role;/g,
        'FROM PUBLIC, anon, authenticated;'
      )
      expect(
        missingServiceRole,
        'known-negative: dropping service_role from the REVOKE is visible'
      ).not.toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${TABLES[0]}\\s+FROM PUBLIC, anon, authenticated, service_role;`
        )
      )
    })

    it.each(STATE_FNS)(
      '%s: SECURITY DEFINER, pinned search_path, service_role only, no timestamp argument',
      (fn) => {
        const body = stripComments(extractFunction(MIG_A, `public.${fn}`))
        expect(body, 'positive control: the slice is the function').toContain(fn)
        expect(body).toMatch(/\bSECURITY DEFINER\b/)
        expect(body).toMatch(/SET search_path = public, pg_temp/)
        expect(body, 'reads the transaction timestamp itself').toMatch(/\bnow\(\)/)
        expect(header(body), 'no timestamp parameter (R3-1)').not.toMatch(/TIMESTAMP/i)
        const sig = esc(SIGS[fn])
        expect(a).toMatch(
          new RegExp(
            `REVOKE ALL ON FUNCTION public\\.${fn}\\(${sig}\\)\\s+FROM PUBLIC, anon, authenticated;`
          )
        )
        expect(a).toMatch(
          new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(${sig}\\)\\s+TO service_role;`)
        )
        expect(a).not.toMatch(
          new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[^;]*(anon|authenticated|PUBLIC)`)
        )
      }
    )

    it('known-negative: the timestamp-parameter predicate does see a p_now (the SMI-6114 predicate)', () => {
      const predicate = extractFunction(
        '20261008000000_private_registry_audit_attempt_rpc.sql',
        'public.registry_audit_volume_over_threshold'
      )
      expect(header(stripComments(predicate))).toMatch(/TIMESTAMP/i)
    })

    it('the claim: named conflict target, strict 24h comparisons, no lease', () => {
      const claim = stripComments(
        extractFunction(MIG_A, 'public.claim_registry_audit_volume_alerts')
      )
      expect(namedConflictTarget(claim)).toBe(true)
      expect(
        namedConflictTarget(
          claim.replace('ON CONFLICT (actor) DO UPDATE', 'ON CONFLICT DO UPDATE')
        ),
        'known-negative'
      ).toBe(false)
      expect(claim).toMatch(/s\.last_alerted_at < v_now - interval '24 hours'/)
      expect(claim).toMatch(/s\.claimed_at\s+< v_now - interval '24 hours'/)
      expect(claim, 'no <= and no lease interval').not.toMatch(/<=\s*v_now|15 minutes/)
      expect(claim).toMatch(/RAISE EXCEPTION[\s\S]*USING ERRCODE = '22023'/)
      expect(claim).toMatch(/names an actor more than once/)
    })

    it('settle: matches on the claim token only, and sent / unconfirmed / shadow set last_alerted_at', () => {
      const settle = stripComments(
        extractFunction(MIG_A, 'public.settle_registry_audit_volume_alerts')
      )
      expect(settle).toMatch(/WHERE s\.claim_token = p_token;/)
      expect(settle).toMatch(
        /CASE WHEN p_outcome IN \('sent', 'unconfirmed', 'shadow'\) THEN v_now/
      )
      expect(settle).toMatch(/ELSE s\.last_alerted_at END/)
      const health = stripComments(
        extractFunction(MIG_A, 'public.settle_registry_audit_volume_health')
      )
      expect(health).toMatch(/h\.kind = p_kind\s+AND h\.claim_token = p_token;/)
    })

    it('the health table is seeded with exactly the five kinds, in the CHECK and in both functions', () => {
      const kinds = [
        "'late'",
        "'error'",
        "'audit_write'",
        "'state_write'",
        "'delivery_unconfirmed'",
      ]
      for (const k of kinds)
        expect(
          a.split(k).length - 1,
          `${k} appears in the CHECK, seed and two functions`
        ).toBeGreaterThanOrEqual(4)
      expect(a).toMatch(
        /VALUES \('late'\), \('error'\), \('audit_write'\), \('state_write'\), \('delivery_unconfirmed'\)\s+ON CONFLICT \(kind\) DO NOTHING;/
      )
    })

    it('migration B: dispatcher locked to postgres + service_role (D3), hourly at :12, own Vault names', () => {
      expect(b).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.invoke_registry_audit_volume_monitor\(\) FROM PUBLIC, anon, authenticated;/
      )
      expect(b).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.invoke_registry_audit_volume_monitor\(\) TO service_role;/
      )
      expect(b).not.toMatch(/FROM anon;/)
      const scheduleCall =
        /cron\.schedule\(\s*'registry-audit-volume-monitor',\s*'12 \* \* \* \*',\s*\$\$SELECT public\.invoke_registry_audit_volume_monitor\(\)\$\$\s*\);/
      expect(b).toMatch(scheduleCall)
      expect(
        b.replace("'12 * * * *'", "'*/30 * * * *'"),
        'known-negative: the same predicate rejects a changed schedule'
      ).not.toMatch(scheduleCall)
      expect(b).toMatch(/SECURITY DEFINER/)
      expect(b).toMatch(/SET search_path = public, net, vault, extensions/)
      for (const s of [
        'registry_audit_volume_monitor_functions_base_url',
        'registry_audit_volume_monitor_service_role_key',
      ])
        expect(
          b.split(`'${s}'`).length - 1,
          `${s} is read and checked by name`
        ).toBeGreaterThanOrEqual(1)
      expect(b).toMatch(
        /RAISE EXCEPTION 'registry_audit_volume_monitor_functions_base_url not found in vault'/
      )
      expect(b).toMatch(
        /RAISE EXCEPTION 'registry_audit_volume_monitor_service_role_key not found in vault'/
      )
    })

    it('migration B: the POST path equals the job name, which is the edge function directory name', () => {
      const url = /v_base_url \|\| '(\/functions\/v1\/[a-z-]+)'/.exec(b)?.[1]
      expect(url, 'presence: the dispatcher builds a /functions/v1 URL').toBeDefined()
      expect(url).toBe(`/functions/v1/${JOB}`)
      expect(b).toContain(`cron.unschedule('${JOB}')`)
      expect(b.replace(`/functions/v1/${JOB}`, '/functions/v1/other')).not.toContain(
        `'/functions/v1/${JOB}'`
      )
    })

    it('rollback A drops the six functions before the two tables; the schema_version DELETE stays commented', () => {
      const raw = readFileSync(join(process.cwd(), ROLLBACK_A), 'utf8')
      const sql = stripComments(raw)
      const idx = (re: RegExp) => sql.search(re)
      for (const fn of STATE_FNS)
        expect(
          idx(new RegExp(`DROP FUNCTION IF EXISTS public\\.${fn}\\(`)),
          `drops ${fn}`
        ).toBeGreaterThanOrEqual(0)
      const lastFn = Math.max(
        ...STATE_FNS.map((fn) => idx(new RegExp(`DROP FUNCTION IF EXISTS public\\.${fn}\\(`)))
      )
      for (const t of TABLES)
        expect(
          idx(new RegExp(`DROP TABLE IF EXISTS public\\.${t};`)),
          `${t} dropped after every function`
        ).toBeGreaterThan(lastFn)
      expect(sql, 'the DELETE is not executable').not.toMatch(/DELETE FROM schema_version/)
      expect(raw).toMatch(/^-- DELETE FROM schema_version WHERE version = 121;/m)
    })

    it('rollback B unschedules then drops the dispatcher; the schema_version DELETE stays commented', () => {
      const raw = readFileSync(join(process.cwd(), ROLLBACK_B), 'utf8')
      const sql = stripComments(raw)
      const unsched = sql.search(new RegExp(`cron\\.unschedule\\('${JOB}'\\)`))
      const drop = sql.search(
        /DROP FUNCTION IF EXISTS public\.invoke_registry_audit_volume_monitor\(\);/
      )
      expect(unsched, 'unschedules').toBeGreaterThanOrEqual(0)
      expect(drop, 'drops the dispatcher after the unschedule').toBeGreaterThan(unsched)
      expect(sql).not.toMatch(/DELETE FROM schema_version/)
      expect(raw).toMatch(/^-- DELETE FROM schema_version WHERE version = 122;/m)
    })
  }
)
