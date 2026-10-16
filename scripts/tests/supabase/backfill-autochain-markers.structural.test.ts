/**
 * SMI-7121 -- PG-FREE structural suite for 20261016000000_backfill_autochain_markers.sql. It reads
 * migration text only and runs everywhere. Gate: git-crypt lock state (SMI-5984) -- a DECLARED lock
 * skips, an undeclared one throws.
 *
 * THIS IS A TRIPWIRE, NOT A PROOF. The SQL behaviour is proven by the live-Postgres suite
 * (./backfill-autochain-markers.pg.test.ts), which CI skips. Each text predicate here is paired with
 * a known-negative: the same predicate run on a deliberately broken copy of the text must FAIL.
 *
 * @module scripts/tests/supabase/backfill-autochain-markers.structural
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../lib/sql-statement-guards.ts'
import { readMigrationText } from '../lib/migration-text-guards.ts'

const MIG = '20261016000000_backfill_autochain_markers.sql'
const ROLLBACK = 'supabase/rollbacks/20261016000000_backfill_autochain_markers_down.sql'

const raw = readMigrationText(MIG)
const locked = raw === null
const sql = stripComments(raw ?? '')

const FNS = {
  transition: 'backfill_autochain_marker_transition',
  watcher: 'check_backfill_autochain_markers',
} as const
const SIG: Record<keyof typeof FNS, string> = {
  transition: 'text, text, text, jsonb',
  watcher: '',
}
const JOB = 'backfill-autochain-marker-watch'

/** The plan's state machine (D6), as an unordered set of `from->to` strings. */
const EXPECTED_PAIRS = [
  'consumed->dispatched',
  'consumed->needs_intervention',
  'open->consumed',
  'open->needs_intervention',
]

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

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The allowed pairs as the transition function declares them; null when the shape is missing. */
function allowedPairs(t: string): string[] | null {
  const m = /v_allowed\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(t)
  if (!m) return null
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).sort()
}

/** The check that consumes v_allowed: refuses a pair not in it, and refuses a NULL pair. */
const enforcesPairs = (t: string) =>
  /IF NOT coalesce\(\(p_from \|\| '->' \|\| p_to\) = ANY \(v_allowed\), false\) THEN\s+RAISE EXCEPTION/.test(
    t
  )

/** The single conditional UPDATE, with `state` merged last. */
const MERGE_LAST =
  /SET metadata = metadata \|\| p_patch \|\| jsonb_build_object\('state', p_to\)\s+WHERE id = p_id\s+AND event_type = 'indexer_backfill_autochain_deferred'\s+AND metadata->>'state' = p_from;/
const mergesStateLast = (t: string) => MERGE_LAST.test(t)

const revokesAll3 = (t: string, fn: string, sig: string) =>
  new RegExp(
    `REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(${esc(sig)}\\) FROM PUBLIC, anon, authenticated;`
  ).test(t)
const grantsService = (t: string, fn: string, sig: string) =>
  new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(${esc(sig)}\\) TO service_role;`).test(t)
const scheduled = (t: string) =>
  /cron\.schedule\(\s*'backfill-autochain-marker-watch',\s*'29 \* \* \* \*',\s*\$\$SELECT public\.check_backfill_autochain_markers\(\)\$\$\s*\)/.test(
    t
  )

/** net_request_id casts and the digit guards in front of them. */
const castCount = (t: string) => (t.match(/net_request_id'\)::bigint/g) ?? []).length
const guardCount = (t: string) =>
  (
    t.match(
      /net_request_id'\s*~\s*'\^\[0-9\]\{1,18\}\$'\s+THEN \(a\.metadata->>'net_request_id'\)::bigint/g
    ) ?? []
  ).length

describe.skipIf(locked)('SMI-7121 -- backfill autochain marker migration (PG-free)', () => {
  it('the allowed transition pairs are exactly the four of the plan (known-negatives: one added, one dropped)', () => {
    const t = body(sql, FNS.transition)
    expect(allowedPairs(t)).toEqual(EXPECTED_PAIRS)
    expect(enforcesPairs(t), 'the list is the one the RAISE consults').toBe(true)
    expect(
      allowedPairs(mutate(t, "'open->consumed',", "'open->consumed', 'dispatched->open',"))
    ).not.toEqual(EXPECTED_PAIRS)
    expect(allowedPairs(mutate(t, "'consumed->dispatched',", ''))).not.toEqual(EXPECTED_PAIRS)
    // a check without the coalesce lets a NULL pair through
    expect(enforcesPairs(mutate(t, 'IF NOT coalesce(', 'IF NOT ('))).toBe(false)
    // only one allowed-pair list exists in the migration
    expect(sql.match(/v_allowed\s+CONSTANT/g)).toHaveLength(1)
  })

  it('the transition is one conditional UPDATE with state applied last (known-negatives: patch last, state check dropped)', () => {
    const t = body(sql, FNS.transition)
    expect(mergesStateLast(t)).toBe(true)
    expect(t.match(/\bUPDATE\b/g), 'exactly one UPDATE').toHaveLength(1)
    expect(t).toMatch(/RETURN FOUND;/)
    expect(t, 'a patch that is not an object is refused').toMatch(
      /jsonb_typeof\(p_patch\) IS DISTINCT FROM 'object' THEN\s+RAISE EXCEPTION/
    )
    expect(
      mergesStateLast(
        mutate(
          t,
          "metadata || p_patch || jsonb_build_object('state', p_to)",
          "metadata || jsonb_build_object('state', p_to) || p_patch"
        )
      )
    ).toBe(false)
    expect(mergesStateLast(mutate(t, /\s+AND metadata->>'state' = p_from/, ''))).toBe(false)
  })

  it('security: the transition is INVOKER with search_path public, pg_temp; the watcher DEFINER with the dead-man path', () => {
    const t = body(sql, FNS.transition)
    const w = body(sql, FNS.watcher)
    expect(t).toMatch(/SECURITY INVOKER\s+SET search_path = public, pg_temp\s+AS/)
    expect(t).not.toMatch(/SECURITY DEFINER/)
    expect(w).toMatch(
      /SECURITY DEFINER\s+SET search_path = public, net, vault, extensions, pg_temp\s+AS/
    )
  })

  it('D3: both functions revoked from PUBLIC, anon and authenticated, then granted to service_role', () => {
    for (const k of Object.keys(FNS) as (keyof typeof FNS)[]) {
      const fn = FNS[k]
      expect(revokesAll3(sql, fn, SIG[k]), `${fn} revoke`).toBe(true)
      expect(grantsService(sql, fn, SIG[k]), `${fn} grant`).toBe(true)
      expect(sql.indexOf(`REVOKE EXECUTE ON FUNCTION public.${fn}(`)).toBeLessThan(
        sql.indexOf(`GRANT EXECUTE ON FUNCTION public.${fn}(`)
      )
      // known-negatives: an anon-only revoke, and one missing authenticated, are not the D3 shape
      expect(
        revokesAll3(sql.replaceAll('FROM PUBLIC, anon, authenticated;', 'FROM anon;'), fn, SIG[k])
      ).toBe(false)
      expect(
        revokesAll3(
          sql.replaceAll('FROM PUBLIC, anon, authenticated;', 'FROM PUBLIC, anon;'),
          fn,
          SIG[k]
        )
      ).toBe(false)
    }
  })

  it('schedules the watcher at 29 * * * *, guard-unscheduling first (known-negative: another minute)', () => {
    expect(scheduled(sql)).toBe(true)
    expect(scheduled(mutate(sql, "'29 * * * *'", "'30 * * * *'"))).toBe(false)
    expect(sql).toMatch(
      /SELECT cron\.unschedule\('backfill-autochain-marker-watch'\)\s+WHERE EXISTS \(SELECT 1 FROM cron\.job WHERE jobname = 'backfill-autochain-marker-watch'\);/
    )
    expect(sql.indexOf(`cron.unschedule('${JOB}')`)).toBeLessThan(
      sql.indexOf(`cron.schedule(\n  '${JOB}'`)
    )
  })

  it('the paired rollback unschedules the job and drops both functions, and nothing else', () => {
    const p = join(process.cwd(), ROLLBACK)
    expect(existsSync(p), `${ROLLBACK} exists`).toBe(true)
    const rb = stripComments(readFileSync(p, 'utf8'))
    expect(rb).toMatch(new RegExp(`cron\\.unschedule\\('${JOB}'\\)`))
    for (const k of Object.keys(FNS) as (keyof typeof FNS)[])
      expect(rb).toMatch(
        new RegExp(`DROP FUNCTION IF EXISTS public\\.${FNS[k]}\\(${esc(SIG[k])}\\);`)
      )
    // every object the migration creates is dropped by the rollback
    const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(
      (m) => m[1]
    )
    expect(created.sort()).toEqual(Object.values(FNS).sort())
    const scheduledJobs = [...sql.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(scheduledJobs).toEqual([JOB])
    // marker rows stay; pg_net is a shared prerequisite
    expect(rb).not.toMatch(/DELETE FROM|TRUNCATE|DROP TABLE|DROP EXTENSION/i)
    expect(readFileSync(p, 'utf8')).toMatch(/pg_net[^\n]*shared prerequisite/)
  })

  it('watcher: lock first, then the harvest, then the kill switch, then evaluation (the switch never gates the harvest)', () => {
    const w = body(sql, FNS.watcher)
    const lock =
      /IF NOT pg_try_advisory_xact_lock\(hashtextextended\('check_backfill_autochain_markers', 0\)\) THEN\s+RETURN;/
    expect(w).toMatch(lock)
    const order = (t: string) => {
      const iLock = t.search(lock)
      const iHarvest = t.indexOf('JOIN net._http_response r ON r.id = d.rid')
      const iKill = t.indexOf("'SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLE'")
      const iEval = t.indexOf("a.event_type = 'indexer_backfill_autochain_deferred'")
      return iLock >= 0 && iLock < iHarvest && iHarvest < iKill && iKill < iEval
    }
    expect(order(w)).toBe(true)
    expect(w).toMatch(
      /IF lower\(trim\(coalesce\(v_disable, ''\)\)\) IN \('1', 'true'\) THEN\s+RETURN;/
    )
    // known-negative: the kill switch moved back above the harvest
    const killBlock =
      /\s+SELECT decrypted_secret INTO v_disable[\s\S]*?IN \('1', 'true'\) THEN\s+RETURN;\s+END IF;/
    const kill = killBlock.exec(w)![0]
    const moved = mutate(w.replace(kill, ''), /(THEN\s+RETURN;\s+END IF;)/, `$1${kill}`)
    expect(order(moved)).toBe(false)
    expect(mutate(w, "hashtextextended('check_backfill_autochain_markers', 0)", '1')).not.toMatch(
      lock
    )
  })

  it('watcher: thresholds are 12h stalled, 1h unreconciled, 24h dedup, 1h pending; consumed_at falls back to created_at', () => {
    const w = body(sql, FNS.watcher)
    expect(w).toMatch(/v_stall_after\s+CONSTANT interval := interval '12 hours';/)
    expect(w).toMatch(/v_reconcile_after\s+CONSTANT interval := interval '1 hour';/)
    expect(w).toMatch(/v_dedup\s+CONSTANT interval := interval '24 hours';/)
    expect(w).toMatch(/v_pending\s+CONSTANT interval := interval '1 hour';/)
    const parsesSafely = (t: string) =>
      /BEGIN\s+v_ref := \(v_m\.metadata->>'consumed_at'\)::timestamptz;\s+EXCEPTION WHEN OTHERS THEN\s+v_ref := NULL;/.test(
        t
      )
    expect(parsesSafely(w)).toBe(true)
    expect(parsesSafely(mutate(w, /\s+EXCEPTION WHEN OTHERS THEN\s+v_ref := NULL;/, ''))).toBe(
      false
    )
    expect(w).toMatch(/v_ref := coalesce\(v_ref, v_m\.created_at\);/)
    // a consumed_at in the future falls back too, ahead of the coalesce
    expect(w).toMatch(
      /IF v_ref > now\(\) THEN\s+v_ref := NULL;\s+END IF;\s+v_ref := coalesce\(v_ref, v_m\.created_at\);/
    )
    expect(w).toMatch(/'indexer_backfill_autochain_' \|\| v_kind/)
    expect(w).toMatch(
      /CASE WHEN a\.metadata->>'state' = 'open' THEN 'stalled' ELSE 'unreconciled' END AS kind/
    )
    expect(w).toMatch(/v_kind := v_c\.kind;/)
  })

  it('watcher: dedup reads only the alert rows -- harvested 2xx + sent true suppresses, unharvested under 1h is pending', () => {
    const w = body(sql, FNS.watcher)
    const loop = (t: string) => {
      const start = t.indexOf('FOR v_alert IN')
      return t.slice(start, t.indexOf('END LOOP;', start))
    }
    const dedup = loop(w)
    expect(dedup).toMatch(
      /AND a\.metadata->>'marker_id' = v_m\.id\s+AND a\.metadata->>'kind' = v_kind/
    )
    expect(dedup).toMatch(
      /IF v_alert\.metadata \? 'status_code' THEN[\s\S]*?IF v_status BETWEEN 200 AND 299 AND v_alert\.metadata->>'sent' = 'true' THEN\s+v_suppress := true;\s+EXIT;\s+END IF;\s+CONTINUE;\s+END IF;\s+IF v_alert\.created_at > now\(\) - v_pending THEN\s+v_suppress := true;\s+EXIT;\s+END IF;/
    )
    // only the harvest reads net._http_response; the dedup loop never does
    expect(dedup, 'the dedup loop does not read net._http_response').not.toMatch(/_http_response/)
    expect(w.match(/net\._http_response/g), 'exactly one reader: the harvest').toHaveLength(1)
    expect(w.indexOf('net._http_response')).toBeLessThan(
      w.indexOf("'SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLE'")
    )
    // known-negative: a live lookup re-added inside the loop is caught
    const withLive = mutate(
      w,
      'IF v_alert.created_at > now() - v_pending THEN',
      'PERFORM 1 FROM net._http_response r;\n      IF v_alert.created_at > now() - v_pending THEN'
    )
    expect(loop(withLive)).toMatch(/_http_response/)
  })

  it('watcher: each candidate is re-read FOR UPDATE SKIP LOCKED and re-checked before dedup and send', () => {
    const w = body(sql, FNS.watcher)
    const reread =
      /SELECT a\.id, a\.created_at, a\.metadata INTO v_m\s+FROM public\.audit_logs a\s+WHERE a\.id = v_c\.id\s+AND a\.event_type = 'indexer_backfill_autochain_deferred'\s+FOR UPDATE SKIP LOCKED;\s+IF NOT FOUND THEN\s+v_row_locked := true;\s+v_m := v_c;\s+END IF;/
    expect(w).toMatch(reread)
    const iReread = w.search(reread)
    expect(iReread).toBeGreaterThan(w.indexOf('FOR v_c IN'))
    expect(iReread).toBeLessThan(w.indexOf('FOR v_alert IN'))
    expect(iReread).toBeLessThan(w.indexOf('net.http_post'))
    // eligibility is re-checked on the locked row, for the kind the cursor selected
    expect(w).toMatch(/IF v_m\.metadata->>'state' IS DISTINCT FROM 'open' THEN\s+CONTINUE;/)
    expect(w).toMatch(
      /IF v_m\.metadata->>'state' IS DISTINCT FROM 'consumed'\s+OR coalesce\(trim\(v_m\.metadata->>'dispatched_run_id'\), ''\) <> '' THEN\s+CONTINUE;/
    )
    expect(mutate(w, 'FOR UPDATE SKIP LOCKED', 'FOR UPDATE')).not.toMatch(reread)
  })

  it('watcher: a row held by another session falls back to the unlocked read, but only past a 12h wider bound', () => {
    const w = body(sql, FNS.watcher)
    expect(w).toMatch(/v_locked_margin\s+CONSTANT interval := interval '12 hours';/)
    expect(w).toMatch(
      /v_margin := CASE WHEN v_row_locked THEN v_locked_margin ELSE interval '0' END;/
    )
    // the margin widens BOTH thresholds
    const bounds = (t: string) =>
      /IF v_ref >= now\(\) - \(v_stall_after \+ v_margin\) THEN\s+CONTINUE;/.test(t) &&
      /IF v_ref >= now\(\) - \(v_reconcile_after \+ v_margin\) THEN\s+CONTINUE;/.test(t)
    expect(bounds(w)).toBe(true)
    expect(bounds(mutate(w, '(v_stall_after + v_margin)', 'v_stall_after'))).toBe(false)
    // the snapshot carries what eligibility needs
    const cursor = w.slice(w.indexOf('FOR v_c IN'), w.indexOf('LOOP', w.indexOf('FOR v_c IN')))
    expect(cursor).toMatch(/SELECT a\.id, a\.created_at, a\.metadata,/)
    // the fallback takes no lock of its own: the only FOR UPDATE is the SKIP LOCKED re-read
    expect(w.match(/FOR UPDATE/g)).toHaveLength(1)
    // the alert row and the message say so
    expect(w).toMatch(/'row_locked', v_row_locked/)
    // the message gains a note only on the locked path (wording is free; the live suite checks it is sent)
    expect(w).toMatch(/CASE WHEN v_row_locked\s+THEN '[^']+'\s+ELSE ''/)
    // the fallback is not exempt from dedup: the suppress check names no row_locked condition
    expect(w).toMatch(/IF v_suppress THEN\s+CONTINUE;/)
  })

  it('watcher: harvest copies status_code and sent once per alert, parsing sent defensively', () => {
    const w = body(sql, FNS.watcher)
    expect(w).toMatch(/AND NOT \(a\.metadata \? 'status_code'\)/)
    expect(w).toMatch(
      /SET metadata = metadata \|\| jsonb_build_object\('status_code', v_h\.status_code, 'sent', v_sent\)/
    )
    expect(w).toMatch(
      /BEGIN\s+v_sent := \(v_h\.content::jsonb\)->'data'->>'sent';\s+EXCEPTION WHEN OTHERS THEN/
    )
    expect(mutate(w, "AND NOT (a.metadata ? 'status_code')", '')).not.toMatch(
      /NOT \(a\.metadata \? 'status_code'\)/
    )
  })

  it('watcher: every net_request_id cast sits inside a CASE behind its 1-18 digit guard', () => {
    const w = body(sql, FNS.watcher)
    expect(castCount(w)).toBeGreaterThan(0)
    expect(guardCount(w)).toBe(castCount(w))
    expect(guardCount(mutate(w, /\{1,18\}/, '+'))).toBeLessThan(castCount(w))
  })

  it('watcher: sends with the refresh vault secrets, 30s timeout, and records the alert row; never RAISES EXCEPTION', () => {
    const w = body(sql, FNS.watcher)
    expect(w).toMatch(/name = 'refresh_metadata_functions_base_url'/)
    expect(w).toMatch(/name = 'refresh_metadata_service_role_key'/)
    expect(w).toMatch(/v_base_url \|\| '\/functions\/v1\/alert-notify'/)
    expect(w).toMatch(/timeout_milliseconds := 30000/)
    expect(w).toMatch(
      /'indexer_backfill_autochain_marker_alert'[\s\S]*?'marker_id', v_m\.id,\s+'kind', v_kind,\s+'net_request_id', v_rid,\s+'completed_run_id'/
    )
    expect(w).toMatch(/'indexer_backfill_autochain_watch_error'/)
    expect(w).toMatch(/RAISE WARNING/)
    expect(w).not.toMatch(/RAISE EXCEPTION/)
    // the message names the runbook and the sections of the plan's runbook changes
    expect(w).toMatch(/backfill-autochain-handover\.md/)
    expect(w).toMatch(/'A deferred chain did not resume'/)
    expect(w).toMatch(/'Resume after a failed resume dispatch'/)
  })

  it('smoke: asserts INVOKER/DEFINER, search_path, grants, the schedule, and runs the transition against no row', () => {
    const smoke = sql.slice(sql.indexOf('DO $smoke$'))
    expect(smoke).toMatch(/SMOKE FAIL \(secinvoker\)/)
    expect(smoke).toMatch(/SMOKE FAIL \(secdef\)/)
    expect(smoke).toMatch(/SMOKE FAIL \(search_path\)/)
    expect(smoke).toMatch(/has_function_privilege\('anon', v_fn, 'EXECUTE'\)/)
    expect(smoke).toMatch(/has_function_privilege\('authenticated', v_fn, 'EXECUTE'\)/)
    expect(smoke).toMatch(/IF v_schedule IS DISTINCT FROM '29 \* \* \* \*' THEN/)
    expect(smoke).toMatch(
      /IF NOT has_table_privilege\('service_role', 'public\.audit_logs', 'UPDATE'\)\s+OR NOT has_table_privilege\('service_role', 'public\.audit_logs', 'SELECT'\) THEN\s+RAISE EXCEPTION 'SMOKE FAIL \(audit_logs grant\)/
    )
    expect(smoke).toMatch(/'dispatched', 'open'/)
    expect(smoke, 'the watcher is not executed at apply').not.toMatch(
      /PERFORM public\.check_backfill_autochain_markers\(\)/
    )
  })

  it('no RETURNS TABLE (no implicit OUT columns to shadow), and every parameter is p_-prefixed', () => {
    expect(sql).not.toMatch(/RETURNS\s+TABLE/i)
    const params = /backfill_autochain_marker_transition\(\s*([^)]*)\)\s*RETURNS boolean/.exec(
      sql
    )?.[1]
    expect(params).toBeDefined()
    for (const p of params!.split(',')) expect(p.trim()).toMatch(/^p_\w+ \w+$/)
  })
})
