/**
 * SMI-7114 -- PG-FREE structural suite for 20261013000000_skills_refresh_metadata_pg_cron.sql. It
 * reads migration text only and runs everywhere. Gate: git-crypt lock state (SMI-5984) -- a DECLARED
 * lock skips, an undeclared one throws.
 *
 * THIS IS A TRIPWIRE, NOT A PROOF. The repo has no live-Postgres harness for this migration, so the
 * RPC's SQL behaviour is red-tested on staging. Each text predicate is paired with a known-negative:
 * the same predicate run on a deliberately broken copy of the text must FAIL.
 *
 * @module scripts/tests/supabase/skills-refresh-metadata-pg-cron.structural
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../lib/sql-statement-guards.ts'
import { readMigrationText } from '../lib/migration-text-guards.ts'

const MIG = '20261013000000_skills_refresh_metadata_pg_cron.sql'
const ROLLBACK = 'supabase/rollbacks/20261013000000_skills_refresh_metadata_pg_cron_down.sql'

const raw = readMigrationText(MIG)
const locked = raw === null
const sql = stripComments(raw ?? '')

const FNS = {
  dispatch: 'invoke_skills_refresh_metadata',
  health: 'refresh_metadata_health',
  deadman: 'check_refresh_observer_heartbeat',
} as const
const SIG: Record<keyof typeof FNS, string> = {
  dispatch: '',
  health: 'interval',
  deadman: 'interval',
}

/** Body of `public.<name>`: from its CREATE to the closing `$$;`. Throws when absent. */
function body(text: string, name: string): string {
  const start = text.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`))
  if (start < 0) throw new Error(`function ${name} not found`)
  const end = text.indexOf('$$;', text.indexOf('$$', start) + 2)
  // stripComments leaves comments inside dollar-quoted bodies; the bodies hold no '--' literal.
  return text.slice(start, end + 3).replace(/--.*$/gm, '')
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Predicates, each reused on a broken copy as its known-negative. */
const passesTimeout = (t: string) =>
  /v_timeout_ms\s+CONSTANT\s+integer\s*:=\s*\d+;/.test(t) &&
  /timeout_milliseconds\s*:=\s*v_timeout_ms/.test(t)
const insertsDispatchRow = (t: string) =>
  /INSERT INTO audit_logs[\s\S]*?'refresh:dispatch'[\s\S]*?'net_request_id'/.test(t)
const scheduled = (t: string) =>
  /cron\.schedule\(\s*'skills-refresh-metadata',\s*'32 2-22\/4 \* \* \*',\s*\$\$SELECT public\.invoke_skills_refresh_metadata\(\)\$\$\s*\)/.test(
    t
  )
const deadmanScheduled = (t: string) =>
  /cron\.schedule\(\s*'refresh-observer-heartbeat',\s*'17 \* \* \* \*',\s*\$\$SELECT public\.check_refresh_observer_heartbeat\(\)\$\$\s*\)/.test(
    t
  )
const revokesAll3 = (t: string, fn: string, sig: string) =>
  new RegExp(
    `REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(${esc(sig)}\\) FROM PUBLIC, anon, authenticated;`
  ).test(t)
const grantsService = (t: string, fn: string, sig: string) =>
  new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(${esc(sig)}\\) TO service_role;`).test(t)

/** Milliseconds of `T` and the minutes of the no_response threshold, as the SQL spells them. */
const timeoutMs = (t: string) =>
  Number(/v_timeout_ms\s+CONSTANT\s+integer\s*:=\s*(\d+);/.exec(t)?.[1])
const noResponseMinutes = (t: string) =>
  Number(/v_no_response_after\s+CONSTANT\s+interval\s*:=\s*interval\s*'(\d+) minutes'/.exec(t)?.[1])

describe.skipIf(locked)('SMI-7114 -- skills-refresh-metadata pg_cron migration (PG-free)', () => {
  it('the paired rollback exists, unschedules both jobs and drops all three functions', () => {
    const p = join(process.cwd(), ROLLBACK)
    expect(existsSync(p), `${ROLLBACK} exists`).toBe(true)
    const rb = stripComments(readFileSync(p, 'utf8'))
    expect(rb).toMatch(/cron\.unschedule\('skills-refresh-metadata'\)/)
    expect(rb).toMatch(/cron\.unschedule\('refresh-observer-heartbeat'\)/)
    for (const k of Object.keys(FNS) as (keyof typeof FNS)[])
      expect(rb).toMatch(
        new RegExp(`DROP FUNCTION IF EXISTS public\\.${FNS[k]}\\(${esc(SIG[k])}\\);`)
      )
  })

  it('schedules skills-refresh-metadata at 32 2-22/4 * * * (known-negative: another minute)', () => {
    expect(scheduled(sql)).toBe(true)
    expect(scheduled(sql.replace("'32 2-22/4 * * *'", "'30 2-22/4 * * *'"))).toBe(false)
  })

  it('schedules the observer dead-man at 17 * * * * (known-negative: another minute)', () => {
    expect(deadmanScheduled(sql)).toBe(true)
    expect(deadmanScheduled(sql.replace("'17 * * * *'", "'12 * * * *'"))).toBe(false)
  })

  it('the dispatcher passes an explicit pg_net timeout (known-negative: argument dropped)', () => {
    const d = body(sql, FNS.dispatch)
    expect(passesTimeout(d)).toBe(true)
    expect(passesTimeout(d.replace(/,\s*timeout_milliseconds\s*:=\s*v_timeout_ms/, ''))).toBe(false)
  })

  it('the dispatcher inserts one refresh:dispatch row carrying net_request_id (known-negative)', () => {
    const d = body(sql, FNS.dispatch)
    expect(insertsDispatchRow(d)).toBe(true)
    expect(insertsDispatchRow(d.replace("'refresh:dispatch'", "'refresh:other'"))).toBe(false)
    expect(d, 'rid comes from http_post').toMatch(/v_rid\s*:=\s*net\.http_post\(/)
  })

  it('PROVISIONAL T: the no_response threshold is exactly T + 5 minutes', () => {
    // The two literals live in different functions; this ties them so editing one fails here.
    const ms = timeoutMs(body(sql, FNS.dispatch))
    const mins = noResponseMinutes(body(sql, FNS.health))
    expect(Number.isFinite(ms) && Number.isFinite(mins), 'both literals parsed').toBe(true)
    expect(mins).toBe(ms / 60000 + 5)
  })

  it('the dispatcher fails loud on a missing vault secret (precedent behaviour)', () => {
    const d = body(sql, FNS.dispatch)
    expect(d).toMatch(/RAISE EXCEPTION 'refresh_metadata_functions_base_url not found in vault'/)
    expect(d).toMatch(/RAISE EXCEPTION 'refresh_metadata_service_role_key not found in vault'/)
  })

  it('health RPC: four failure kinds, joined on the request id, error_msg truncated to 200', () => {
    const h = body(sql, FNS.health)
    for (const k of ['unknown', 'no_response', 'transport_error', 'http_error'])
      expect(h, `kind ${k}`).toContain(`'${k}'`)
    expect(h).toMatch(/LEFT JOIN net\._http_response r ON r\.id = d\.rid/)
    expect(h).toMatch(/left\(c\.error_msg, 200\)/)
    expect(h).toMatch(/r\.status_code IS NULL\s+THEN 'transport_error'/)
    expect(h, 'no timed_out reference (it is NULL on the measured timeout shape)').not.toMatch(
      /timed_out/
    )
    // 'unknown' must be decided before 'no_response' or a purged response reads as a failure.
    expect(h.indexOf("THEN 'unknown'")).toBeGreaterThan(-1)
    expect(h.indexOf("THEN 'unknown'")).toBeLessThan(h.indexOf("THEN 'no_response'"))
    expect(h).toMatch(/'unknown_count'/)
  })

  it('dead-man: SLA comparison, once-a-day dedup, early return, vault credentials, kill switch', () => {
    const m = body(sql, FNS.deadman)
    expect(m).toMatch(/IF v_age > p_sla AND v_over_h % 24 = 0 THEN/)
    expect(m).toMatch(/IF v_hb IS NULL THEN\s+RETURN;/)
    expect(m).toMatch(/'refresh_observer_dead'/)
    expect(m).toMatch(/\/functions\/v1\/alert-notify/)
    expect(m).toMatch(/FROM vault\.decrypted_secrets/)
    expect(m).toMatch(/'SKILLSMITH_REFRESH_OBSERVER_DEADMAN_DISABLE'/)
    // known-negatives for the two behavioural predicates the staging dead-man test 5 mutates
    expect(m.replace('v_age > p_sla AND ', '')).not.toMatch(/IF v_age > p_sla AND/)
    expect(m.replace(' AND v_over_h % 24 = 0', '')).not.toMatch(/v_over_h % 24 = 0/)
  })

  it('D3: all three functions are SECURITY DEFINER, fixed search_path, revoked from 3 roles, granted to service_role', () => {
    for (const k of Object.keys(FNS) as (keyof typeof FNS)[]) {
      const fn = FNS[k]
      const b = body(sql, fn)
      expect(b, `${fn} SECURITY DEFINER`).toMatch(/SECURITY DEFINER/)
      expect(b, `${fn} fixed search_path`).toMatch(/SET search_path = /)
      expect(revokesAll3(sql, fn, SIG[k]), `${fn} revoke`).toBe(true)
      expect(grantsService(sql, fn, SIG[k]), `${fn} grant`).toBe(true)
      // known-negative: an anon-only revoke is not the D3 shape
      expect(
        revokesAll3(sql.replaceAll('FROM PUBLIC, anon, authenticated;', 'FROM anon;'), fn, SIG[k]),
        `${fn} revoke known-negative`
      ).toBe(false)
    }
  })

  it('none of the three functions uses RETURNS TABLE (no implicit OUT columns to shadow)', () => {
    expect(sql).not.toMatch(/RETURNS\s+TABLE/i)
  })
})
