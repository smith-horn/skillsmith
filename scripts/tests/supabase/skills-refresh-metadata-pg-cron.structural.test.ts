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
  harvest: 'harvest_refresh_dispatch_results',
} as const
const SIG: Record<keyof typeof FNS, string> = {
  dispatch: '',
  health: 'interval',
  deadman: 'interval',
  harvest: '',
}

/** Body of `public.<name>`: from its CREATE to the closing `$$;`. Throws when absent. */
function body(text: string, name: string): string {
  const start = text.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`))
  if (start < 0) throw new Error(`function ${name} not found`)
  const end = text.indexOf('$$;', text.indexOf('$$', start) + 2)
  // stripComments leaves comments inside dollar-quoted bodies; the bodies hold no '--' literal.
  return text.slice(start, end + 3).replace(/--.*$/gm, '')
}

/**
 * Replace `from` with `to`, THROWING when `from` is absent: a known-negative whose mutation matched
 * nothing would assert against an unchanged copy and pass vacuously.
 */
function mutate(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to)
  if (out === text) throw new Error(`mutation matched nothing: ${String(from)}`)
  return out
}

/** Milliseconds of a simple `N <unit>` interval literal; NaN when it is anything else. */
function intervalMs(lit: string | undefined): number {
  const m = /^(\d+)\s+(minutes?|hours?)$/.exec(lit ?? '')
  if (!m) return Number.NaN
  return Number(m[1]) * (m[2].startsWith('hour') ? 3_600_000 : 60_000)
}
const ttlMs = (t: string) =>
  intervalMs(/v_ttl\s+CONSTANT\s+interval\s*:=\s*interval\s*'([^']+)'/.exec(t)?.[1])
const lookbackMs = (t: string) =>
  intervalMs(/v_lookback\s+CONSTANT\s+interval\s*:=\s*interval\s*'([^']+)'/.exec(t)?.[1])

/** The single statement `SELECT ... INTO <var> ... ;` that assigns `v`. */
const assignment = (t: string, v: string) =>
  new RegExp(`SELECT max\\(a\\.created_at\\) INTO ${v}[^;]*;`).exec(t)?.[0] ?? ''

/** net_request_id casts and the digit guards in front of them (M-D). */
const castCount = (t: string) => (t.match(/\)::bigint/g) ?? []).length
const guardCount = (t: string) =>
  (t.match(/net_request_id'\s*~\s*'\^\[0-9\]\{1,18\}\$'/g) ?? []).length

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
const harvestScheduled = (t: string) =>
  /cron\.schedule\(\s*'refresh-dispatch-harvest',\s*'43 \* \* \* \*',\s*\$\$SELECT public\.harvest_refresh_dispatch_results\(\)\$\$\s*\)/.test(
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
  it('the paired rollback exists, unschedules all three jobs and drops all four functions', () => {
    const p = join(process.cwd(), ROLLBACK)
    expect(existsSync(p), `${ROLLBACK} exists`).toBe(true)
    const rb = stripComments(readFileSync(p, 'utf8'))
    expect(rb).toMatch(/cron\.unschedule\('skills-refresh-metadata'\)/)
    expect(rb).toMatch(/cron\.unschedule\('refresh-observer-heartbeat'\)/)
    expect(rb).toMatch(/cron\.unschedule\('refresh-dispatch-harvest'\)/)
    // pg_net is a shared prerequisite: the rollback says so, and does not drop it (M-F)
    expect(readFileSync(p, 'utf8')).toMatch(/pg_net[^\n]*shared prerequisite/)
    expect(rb).not.toMatch(/DROP EXTENSION/i)
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

  it('T (confirmed by W0-1): the no_response threshold is exactly T + 5 minutes', () => {
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

  it('schedules the response harvester at 43 * * * * (known-negative: a minute another job holds)', () => {
    expect(harvestScheduled(sql)).toBe(true)
    expect(harvestScheduled(mutate(sql, "'43 * * * *'", "'12 * * * *'"))).toBe(false)
  })

  it('health RPC: five failure kinds, joined on the request id, error_msg truncated to 200', () => {
    const h = body(sql, FNS.health)
    for (const k of ['unknown', 'no_response', 'transport_error', 'http_error', 'run_failed'])
      expect(h, `kind ${k}`).toContain(`'${k}'`)
    expect(h).toMatch(/LEFT JOIN net\._http_response r ON r\.id = d\.rid/)
    expect(h).toMatch(/left\(c\.error_msg, 200\)/)
    expect(h).toMatch(/j\.status_code IS NULL\s+THEN 'transport_error'/)
    expect(h, 'no timed_out reference (it is NULL on the measured timeout shape)').not.toMatch(
      /timed_out/
    )
    // 'unknown' must be decided before 'no_response' or a purged response reads as a failure.
    expect(h.indexOf("THEN 'unknown'")).toBeGreaterThan(-1)
    expect(h.indexOf("THEN 'unknown'")).toBeLessThan(h.indexOf("THEN 'no_response'"))
    expect(h).toMatch(/'unknown_count'/)
  })

  it('M-G: v_ttl is exactly 6 hours, and the harvester looks back exactly as far', () => {
    const h = body(sql, FNS.health)
    const hv = body(sql, FNS.harvest)
    expect(ttlMs(h)).toBe(6 * 3_600_000)
    expect(lookbackMs(hv)).toBe(ttlMs(h))
    // known-negatives: a shorter ttl (the reviewer's escape mutation) and a shorter lookback both fail
    expect(ttlMs(mutate(h, /interval '6 hours'/, "interval '5 minutes'"))).not.toBe(6 * 3_600_000)
    expect(lookbackMs(mutate(hv, /interval '6 hours'/, "interval '1 hour'"))).not.toBe(ttlMs(h))
  })

  it('M-A: last_run skips failed runs, last_attempt does not, run_failed comes from failed rows', () => {
    const h = body(sql, FNS.health)
    const healthy = assignment(h, 'v_last_run')
    const attempt = assignment(h, 'v_last_attempt')
    expect(healthy, 'v_last_run query found').toMatch(/event_type = 'refresh:run'/)
    expect(healthy).toMatch(/result IS DISTINCT FROM 'failed'/)
    expect(attempt, 'v_last_attempt query found').toMatch(/event_type = 'refresh:run'/)
    expect(attempt, 'last_attempt counts every result').not.toMatch(/result/)
    expect(h).toMatch(/'last_attempt', v_last_attempt/)
    expect(h).toMatch(
      /'run_failed'[\s\S]*?event_type = 'refresh:run' AND a\.result = 'failed' AND a\.created_at >= now\(\) - p_window/
    )
    expect(h).toMatch(/a\.metadata->'errors'->>0/)
    // known-negative: with the filter removed the healthy predicate no longer holds
    expect(mutate(healthy, " AND a.result IS DISTINCT FROM 'failed'", '')).not.toMatch(
      /IS DISTINCT FROM 'failed'/
    )
  })

  it('M-B: the harvester writes one durable row per live response, serialised and idempotent', () => {
    const hv = body(sql, FNS.harvest)
    expect(hv).toMatch(/pg_try_advisory_xact_lock\(/)
    expect(hv).toMatch(/INSERT INTO audit_logs[\s\S]*?'refresh:dispatch_result'/)
    for (const k of ['net_request_id', 'status_code', 'timed_out', 'error_msg'])
      expect(hv, `records ${k}`).toContain(`'${k}'`)
    expect(hv).toMatch(/JOIN net\._http_response r ON r\.id = d\.rid/)
    expect(hv).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM audit_logs x\s+WHERE x\.event_type = 'refresh:dispatch_result'/
    )
    expect(hv).toMatch(/a\.actor = 'pg_cron'/)
    // known-negative: without the NOT EXISTS (both jobs) the same predicate fails
    expect(mutate(hv, /NOT EXISTS/g, 'EXISTS')).not.toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM audit_logs x/
    )
  })

  it('M-B: the health RPC prefers the durable row over the live one, and both over unknown', () => {
    const h = body(sql, FNS.health)
    expect(h).toMatch(/event_type = 'refresh:dispatch_result'/)
    // status/error come from the durable row first, then the live row
    expect(h.indexOf('WHEN dr.created_at IS NOT NULL')).toBeGreaterThan(-1)
    expect(h.indexOf('WHEN dr.created_at IS NOT NULL')).toBeLessThan(
      h.indexOf('ELSE r.status_code')
    )
    expect(h.indexOf('ELSE r.status_code')).toBeLessThan(h.indexOf('ELSE r.error_msg'))
    // a response (either source) is classified before the age arms
    expect(h.indexOf('j.has_durable OR j.has_live')).toBeGreaterThan(-1)
    expect(h.indexOf('j.has_durable OR j.has_live')).toBeLessThan(h.indexOf("THEN 'unknown'"))
    // known-negative: swapping the sources breaks the order predicate
    const swapped = mutate(h, 'ELSE r.status_code', 'ELSE dr.status_code')
    expect(swapped.indexOf('ELSE r.status_code')).toBe(-1)
  })

  it('M-D: every net_request_id cast is behind a 1-18 digit guard, and only pg_cron rows are attributed', () => {
    for (const k of ['health', 'harvest', 'deadman'] as const) {
      const b = body(sql, FNS[k])
      expect(castCount(b), `${FNS[k]} casts net_request_id`).toBeGreaterThan(0)
      expect(guardCount(b), `${FNS[k]} guards every cast`).toBe(castCount(b))
      expect(b, `${FNS[k]} has no unbounded digit guard`).not.toMatch(/\^\[0-9\]\+\$/)
    }
    for (const k of ['health', 'harvest'] as const)
      expect(body(sql, FNS[k])).toMatch(
        /event_type = 'refresh:dispatch'\s+AND a\.actor = 'pg_cron'/
      )
    // known-negatives
    const h = body(sql, FNS.health)
    expect(guardCount(mutate(h, '{1,18}', '+'))).toBeLessThan(castCount(h))
    expect(mutate(body(sql, FNS.harvest), "AND a.actor = 'pg_cron'", '')).not.toMatch(
      /a\.actor = 'pg_cron'/
    )
  })

  it('dead-man: SLA return before any vault read or POST, early return, vault credentials, kill switch', () => {
    const m = body(sql, FNS.deadman)
    expect(m).toMatch(/IF v_hb IS NULL THEN\s+RETURN;/)
    expect(m).toMatch(/IF v_age <= p_sla THEN\s+RETURN;/)
    expect(m).toMatch(/'refresh_observer_dead'/)
    expect(m).toMatch(/\/functions\/v1\/alert-notify/)
    expect(m).toMatch(/FROM vault\.decrypted_secrets/)
    expect(m).toMatch(/'SKILLSMITH_REFRESH_OBSERVER_DEADMAN_DISABLE'/)
    // M-E: with a huge SLA only the heartbeat lookup runs -- it precedes every vault read and the POST
    const ret = m.search(/IF v_age <= p_sla THEN/)
    expect(ret).toBeGreaterThan(m.search(/event_type = 'refresh:observer'/))
    expect(ret).toBeLessThan(m.indexOf('vault.decrypted_secrets'))
    expect(ret).toBeLessThan(m.indexOf('net.http_post'))
    // known-negatives
    expect(mutate(m, 'IF v_age <= p_sla THEN', 'IF false THEN')).not.toMatch(/IF v_age <= p_sla/)
    expect(m, 'the 24h modulo dedup is gone').not.toMatch(/v_over_h/)
  })

  it('M-C: dead-man dedup is state-based -- delivered (2xx + data.sent true) or pending (<1h), else re-alert', () => {
    const m = body(sql, FNS.deadman)
    expect(m).toMatch(/event_type = 'refresh:observer_dead_alert'/)
    expect(m).toMatch(/interval '24 hours'/)
    expect(m).toMatch(/v_status BETWEEN 200 AND 299/)
    expect(m).toMatch(/\(v_content::jsonb\)->'data'->>'sent'/)
    expect(m).toMatch(/IF v_sent = 'true' THEN\s+v_suppress := true;/)
    // pending: no response row AND younger than one hour
    expect(m).toMatch(/v_pending\s+CONSTANT\s+interval\s*:=\s*interval '1 hour'/)
    expect(m).toMatch(
      /IF NOT v_found THEN\s+IF v_alert\.created_at > now\(\) - v_pending THEN\s+v_suppress := true;/
    )
    // a non-JSON body must not raise
    expect(m).toMatch(/BEGIN\s+v_sent := \(v_content::jsonb\)[^;]*;\s+EXCEPTION WHEN OTHERS THEN/)
    // each alert is recorded with its request id, so the next tick can look its response up
    expect(m).toMatch(
      /INSERT INTO audit_logs[\s\S]*?'refresh:observer_dead_alert'[\s\S]*?'net_request_id', v_rid/
    )
    // missing secrets: a trace and a warning, never an exception
    expect(m).not.toMatch(/RAISE EXCEPTION/)
    expect(m).toMatch(/'refresh:observer_deadman_error'/)
    expect(m).toMatch(/RAISE WARNING/)
    // known-negatives: delivery judged on the status alone is not the predicate
    expect(mutate(m, "IF v_sent = 'true' THEN", 'IF true THEN')).not.toMatch(/IF v_sent = 'true'/)
    expect(mutate(m, /\s+EXCEPTION WHEN OTHERS THEN/, '')).not.toMatch(/EXCEPTION WHEN OTHERS/)
  })

  it('R2-1: the harvester also records each dead-alert response durably, parsed defensively, idempotently', () => {
    const hv = body(sql, FNS.harvest)
    expect(hv).toMatch(/event_type = 'refresh:observer_dead_alert'/)
    expect(hv).toMatch(/INSERT INTO audit_logs[\s\S]*?'refresh:observer_dead_alert_result'/)
    for (const k of ['net_request_id', 'status_code', 'sent'])
      expect(hv, `records ${k}`).toContain(`'${k}'`)
    expect(hv).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM audit_logs x\s+WHERE x\.event_type = 'refresh:observer_dead_alert_result'/
    )
    expect(hv).toMatch(
      /BEGIN\s+v_sent := \(v_alert\.content::jsonb\)[^;]*;\s+EXCEPTION WHEN OTHERS THEN/
    )
    // the lock is taken once, before either job
    expect(hv.indexOf('pg_try_advisory_xact_lock')).toBeLessThan(
      hv.indexOf("'refresh:dispatch_result'")
    )
    expect(mutate(hv, /\s+EXCEPTION WHEN OTHERS THEN/, '')).not.toMatch(/EXCEPTION WHEN OTHERS/)
    // the dead-man reads the durable row before the live response
    const m = body(sql, FNS.deadman)
    expect(m).toMatch(/event_type = 'refresh:observer_dead_alert_result'/)
    expect(m.indexOf("'refresh:observer_dead_alert_result'")).toBeLessThan(
      m.indexOf('FROM net._http_response r')
    )
  })

  it('dedup: only alerts written after the latest heartbeat can suppress', () => {
    const m = body(sql, FNS.deadman)
    // the predicate sits in the dedup loop's own query, on the alert rows
    expect(m).toMatch(
      /WHERE a\.event_type = 'refresh:observer_dead_alert'\s+AND a\.created_at >= now\(\) - v_dedup\s+AND a\.created_at > v_hb\s+ORDER BY/
    )
    expect(mutate(m, /\s+AND a\.created_at > v_hb/, '')).not.toMatch(/a\.created_at > v_hb/)
  })

  it('R2-2: the dead-man takes its own advisory xact lock right after the SLA check, before any dedup read', () => {
    const m = body(sql, FNS.deadman)
    const hv = body(sql, FNS.harvest)
    const lock =
      /pg_try_advisory_xact_lock\(hashtextextended\('check_refresh_observer_heartbeat', 0\)\)/
    expect(m).toMatch(lock)
    expect(m).toMatch(/IF NOT pg_try_advisory_xact_lock\([^;]*THEN\s+RETURN;/)
    expect(m.search(lock)).toBeGreaterThan(m.search(/IF v_age <= p_sla THEN/))
    expect(m.search(lock)).toBeLessThan(m.indexOf("event_type = 'refresh:observer_dead_alert'"))
    expect(m.search(lock)).toBeLessThan(m.indexOf('vault.decrypted_secrets'))
    // the two keys are different literals (hashes are compared on a live server in the pg suite)
    expect(hv).not.toMatch(/check_refresh_observer_heartbeat/)
    expect(mutate(m, "hashtextextended('check_refresh_observer_heartbeat', 0)", '1')).not.toMatch(
      lock
    )
  })

  it('M-E: the migration smoke runs the dead-man with a 1000-year SLA and the harvester', () => {
    const smoke = sql.slice(sql.indexOf('DO $smoke$'))
    expect(smoke).toMatch(
      /PERFORM public\.check_refresh_observer_heartbeat\('1000 years'::interval\);/
    )
    expect(smoke).toMatch(/PERFORM public\.harvest_refresh_dispatch_results\(\);/)
    expect(smoke).toMatch(/'last_attempt'/)
    expect(mutate(smoke, "'1000 years'", "'16 hours'")).not.toMatch(/'1000 years'/)
  })

  it('D3: all four functions are SECURITY DEFINER, fixed search_path, revoked from 3 roles, granted to service_role', () => {
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

  it('none of the four functions uses RETURNS TABLE (no implicit OUT columns to shadow)', () => {
    expect(sql).not.toMatch(/RETURNS\s+TABLE/i)
  })
})
