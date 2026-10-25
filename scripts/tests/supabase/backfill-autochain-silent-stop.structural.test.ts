/**
 * SMI-7167 -- PG-FREE structural suite for 20261025000000_backfill_autochain_silent_stop.sql. It reads
 * migration text only and runs everywhere. Gate: git-crypt lock state (SMI-5984) -- a DECLARED lock
 * skips, an undeclared one throws.
 *
 * THIS IS A TRIPWIRE, NOT A PROOF. The SQL behaviour is proven by the live-Postgres suite
 * (./backfill-autochain-silent-stop.pg.test.ts), which CI skips. Each text predicate here is paired
 * with a known-negative: the same predicate run on a deliberately broken copy of the text must FAIL.
 *
 * @module scripts/tests/supabase/backfill-autochain-silent-stop.structural
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../lib/sql-statement-guards.ts'
import { readMigrationText } from '../lib/migration-text-guards.ts'

const MIG = '20261025000000_backfill_autochain_silent_stop.sql'
const ROLLBACK = 'supabase/rollbacks/20261025000000_backfill_autochain_silent_stop_down.sql'

const raw = readMigrationText(MIG)
const locked = raw === null
const sql = stripComments(raw ?? '')

const FNS = {
  candidates: 'backfill_autochain_silent_stop_candidates',
  detector: 'check_backfill_autochain_silent_stop',
} as const
const JOB = 'backfill-autochain-silent-stop-watch'

/** Body of `public.<name>`: from its CREATE to the closing `$$;`. Throws when absent. */
function body(text: string, name: string): string {
  const start = text.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`))
  if (start < 0) throw new Error(`function ${name} not found`)
  const end = text.indexOf('$$;', text.indexOf('$$', start) + 2)
  return text.slice(start, end + 3).replace(/--.*$/gm, '')
}

/** The function header: CREATE ... up to AS $$ (volatility, security, search_path live here). */
function header(text: string, name: string): string {
  const b = body(text, name)
  return b.slice(0, b.indexOf('AS $$'))
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

const revokesAll3 = (t: string, fn: string) =>
  new RegExp(
    `REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(\\) FROM PUBLIC, anon, authenticated;`
  ).test(t)
const grantsService = (t: string, fn: string) =>
  new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(\\) TO service_role;`).test(t)
const scheduled = (t: string) =>
  /cron\.schedule\(\s*'backfill-autochain-silent-stop-watch',\s*'38 \* \* \* \*',\s*\$\$SELECT public\.check_backfill_autochain_silent_stop\(\)\$\$\s*\)/.test(
    t
  )

const LEDGER_EVENTS = [
  'indexer_backfill_autochain_dispatch_prepared',
  'indexer_backfill_autochain_dispatch_resolved',
  'indexer_backfill_autochain_link_started',
  'indexer_backfill_autochain_link_finished',
  'indexer_backfill_autochain_silent_stop_ack',
]
/** The event types of the candidates function's ledger CTE `IN (...)` list, sorted. */
function ledgerEvents(t: string): string[] | null {
  const m = /a\.event_type IN \(([^)]*)\)/.exec(t)
  if (!m) return null
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).sort()
}

/**
 * Casts of an extracted value to a number: `(<expr>)::bigint|int|integer|numeric`. The only casts the
 * migration may carry are on net_request_id (behind its digit guard) and status_code (behind its own).
 */
function numericCasts(t: string): string[] {
  return [...t.matchAll(/\(([^()]*)\)::(?:bigint|integer|int|numeric)\b/g)]
    .map((m) => m[1])
    .filter((e) => !/net_request_id|status_code/.test(e))
}

describe.skipIf(locked)('SMI-7167 -- backfill autochain silent-stop migration (PG-free)', () => {
  it('both functions exist, each with a fixed search_path (known-negative: the SET dropped)', () => {
    for (const fn of Object.values(FNS)) {
      const h = header(sql, fn)
      expect(h, `${fn} pins search_path`).toMatch(/SET search_path = [\w, ]+\s*$/)
      expect(() => mutate(h, /SET search_path = [\w, ]+\s*$/, '')).not.toThrow()
      expect(mutate(h, /SET search_path = [\w, ]+\s*$/, '')).not.toMatch(/SET search_path/)
    }
    expect(header(sql, FNS.candidates)).toMatch(/SET search_path = public, pg_temp\s*$/)
    expect(header(sql, FNS.detector)).toMatch(
      /SET search_path = public, net, vault, extensions, pg_temp\s*$/
    )
  })

  it('candidates is SECURITY INVOKER and STABLE; the detector SECURITY DEFINER (known-negatives)', () => {
    const c = header(sql, FNS.candidates)
    const d = header(sql, FNS.detector)
    const invokerStable = (h: string) => /\bSTABLE\b/.test(h) && /SECURITY INVOKER/.test(h)
    expect(invokerStable(c)).toBe(true)
    expect(c).not.toMatch(/SECURITY DEFINER/)
    expect(invokerStable(mutate(c, 'SECURITY INVOKER', 'SECURITY DEFINER'))).toBe(false)
    expect(invokerStable(mutate(c, /\bSTABLE\b/, 'VOLATILE'))).toBe(false)
    expect(d).toMatch(/SECURITY DEFINER/)
    expect(mutate(d, 'SECURITY DEFINER', 'SECURITY INVOKER')).not.toMatch(/SECURITY DEFINER/)
  })

  it('the candidates function is read-only (known-negative: a write added is caught)', () => {
    const c = body(sql, FNS.candidates)
    const writes = (t: string) =>
      /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE|PERFORM)\b/i.test(t)
    expect(writes(c)).toBe(false)
    expect(
      writes(mutate(c, "SELECT 'A'::text,", "DELETE FROM public.audit_logs; SELECT 'A'::text,"))
    ).toBe(true)
  })

  it('D3: both functions revoked from PUBLIC, anon and authenticated, then granted to service_role', () => {
    for (const fn of Object.values(FNS)) {
      expect(revokesAll3(sql, fn), `${fn} revoke`).toBe(true)
      expect(grantsService(sql, fn), `${fn} grant`).toBe(true)
      expect(sql.indexOf(`REVOKE EXECUTE ON FUNCTION public.${fn}(`)).toBeLessThan(
        sql.indexOf(`GRANT EXECUTE ON FUNCTION public.${fn}(`)
      )
      // known-negatives: an anon-only revoke, one missing authenticated, and a missing grant
      expect(
        revokesAll3(sql.replaceAll('FROM PUBLIC, anon, authenticated;', 'FROM anon;'), fn)
      ).toBe(false)
      expect(
        revokesAll3(sql.replaceAll('FROM PUBLIC, anon, authenticated;', 'FROM PUBLIC, anon;'), fn)
      ).toBe(false)
      expect(grantsService(sql.replaceAll('TO service_role;', 'TO anon;'), fn)).toBe(false)
    }
  })

  it('schedules the detector at 38 * * * *, guard-unscheduling first (known-negative: another minute)', () => {
    expect(scheduled(sql)).toBe(true)
    expect(scheduled(mutate(sql, "'38 * * * *'", "'39 * * * *'"))).toBe(false)
    expect(sql).toMatch(
      /SELECT cron\.unschedule\('backfill-autochain-silent-stop-watch'\)\s+WHERE EXISTS \(SELECT 1 FROM cron\.job WHERE jobname = 'backfill-autochain-silent-stop-watch'\);/
    )
    expect(sql.indexOf(`cron.unschedule('${JOB}')`)).toBeLessThan(
      sql.indexOf(`cron.schedule(\n  '${JOB}'`)
    )
    expect(sql).toMatch(/IF v_schedule IS DISTINCT FROM '38 \* \* \* \*' THEN/)
  })

  it('the five ledger event types are exactly the ones the candidates function reads (known-negative: one dropped)', () => {
    const c = body(sql, FNS.candidates)
    expect(ledgerEvents(c)).toEqual([...LEDGER_EVENTS].sort())
    expect(ledgerEvents(mutate(c, "'indexer_backfill_autochain_link_started',", ''))).not.toEqual(
      [...LEDGER_EVENTS].sort()
    )
    // the checkpoint is read from audit_logs directly, with the dry-run exclusion
    expect(c).toMatch(/c\.event_type = 'indexer_backfill_checkpoint'/)
    expect(c).toMatch(/coalesce\(c\.metadata->>'dry_run', 'false'\) <> 'true'/)
    // the detector's own rows
    const d = body(sql, FNS.detector)
    expect(d).toMatch(/'indexer_backfill_autochain_silent_stop_alert'/)
    expect(d).toMatch(/'indexer_backfill_autochain_silent_stop_error'/)
    expect(d).toMatch(/v_type := 'indexer_backfill_autochain_silent_stop';/)
    expect(d).toMatch(/v_type := 'indexer_backfill_autochain_dispatch_ambiguous';/)
  })

  it('the intervals sit where the header says: 30 min / 12 h / 30 min / 24 h / 1 h / 1 year', () => {
    const c = body(sql, FNS.candidates)
    const d = body(sql, FNS.detector)
    const deadlineA = "coalesce(a.ckpt + interval '30 minutes', a.created_at + interval '12 hours')"
    // Arm A deadline appears in the SELECT list and in the WHERE (both must agree)
    expect(c.split(deadlineA)).toHaveLength(3)
    expect(c).toMatch(
      /WHERE coalesce\(a\.ckpt \+ interval '30 minutes', a\.created_at \+ interval '12 hours'\) <= now\(\)/
    )
    // Arm B: created_at + 30 min in the SELECT list and in the WHERE
    expect(c.match(/p\.created_at \+ interval '30 minutes'/g)).toHaveLength(2)
    expect(c).toMatch(/a\.created_at >= now\(\) - interval '1 year'/)
    expect(d).toMatch(/v_dedup\s+CONSTANT interval := interval '24 hours';/)
    expect(d).toMatch(/v_pending\s+CONSTANT interval := interval '1 hour';/)
    // known-negatives: each interval changed breaks its predicate
    expect(
      mutate(c, "a.created_at + interval '12 hours'", "a.created_at + interval '6 hours'").split(
        deadlineA
      )
    ).toHaveLength(2)
    expect(
      mutate(c, "a.ckpt + interval '30 minutes'", "a.ckpt + interval '60 minutes'").split(deadlineA)
    ).toHaveLength(2)
    expect(mutate(c, /interval '1 year'/, "interval '1 month'")).not.toMatch(/interval '1 year'/)
    expect(mutate(d, "interval '24 hours'", "interval '48 hours'")).not.toMatch(
      /v_dedup\s+CONSTANT interval := interval '24 hours'/
    )
    expect(
      mutate(d, /(v_pending\s+CONSTANT interval := interval )'1 hour'/, "$1'2 hours'")
    ).not.toMatch(/v_pending\s+CONSTANT interval := interval '1 hour';/)
  })

  it('ids are compared as text and never cast; malformed ids are filtered by shape (known-negative: a cast added)', () => {
    const c = body(sql, FNS.candidates)
    const d = body(sql, FNS.detector)
    expect(numericCasts(c)).toEqual([])
    expect(numericCasts(d)).toEqual([])
    expect(c).not.toMatch(/::(bigint|integer|int|numeric)\b/)
    // the only ::bigint in the detector is the guarded net_request_id one
    expect(d.match(/::bigint/g)).toHaveLength(1)
    expect(d).toMatch(
      /net_request_id'\s*~\s*'\^\[0-9\]\{1,18\}\$'\s+THEN \(a\.metadata->>'net_request_id'\)::bigint/
    )
    // shape filters in front of the comparisons
    expect(c).toMatch(/l\.m->>'dispatched_run_id' ~ '\^\[1-9\]\[0-9\]\{0,18\}\$'/)
    expect(c).toMatch(/l\.m->>'dispatch_token' ~ '\^ac-\[1-9\]\[0-9\]\{0,18\}\$'/)
    expect(c).toMatch(/l\.m->>'link_run_attempt' ~ '\^\[1-9\]\[0-9\]\{0,4\}\$'/)
    for (const [from, id] of [
      ["f.m->>'completed_run_id' = d.rid", 'completed_run_id'],
      ["l.m->>'dispatched_run_id' ~", 'dispatched_run_id'],
      ["k.m->>'key' = d.rid", 'key'],
    ] as const) {
      const cast = from.replace(/^(\w\.m->>'\w+')/, '($1)::bigint')
      expect(numericCasts(mutate(c, from, cast)), `a cast on ${id} is caught`).not.toEqual([])
    }
  })

  it('detector: lock first, then the harvest, then the kill switch, then evaluation (the switch never gates the harvest)', () => {
    const d = body(sql, FNS.detector)
    const lock =
      /IF NOT pg_try_advisory_xact_lock\(hashtextextended\('check_backfill_autochain_silent_stop', 0\)\) THEN\s+RETURN;/
    expect(d).toMatch(lock)
    const order = (t: string) => {
      const iLock = t.search(lock)
      const iHarvest = t.indexOf('JOIN net._http_response r ON r.id = d.rid')
      const iKill = t.indexOf("'SKILLSMITH_BACKFILL_AUTOCHAIN_SILENT_STOP_DISABLE'")
      const iEval = t.indexOf('public.backfill_autochain_silent_stop_candidates()')
      return iLock >= 0 && iLock < iHarvest && iHarvest < iKill && iKill < iEval
    }
    expect(order(d)).toBe(true)
    expect(d).toMatch(
      /IF lower\(trim\(coalesce\(v_disable, ''\)\)\) IN \('1', 'true'\) THEN\s+RETURN;/
    )
    // known-negative: the kill switch moved back above the harvest
    const killBlock =
      /\s+SELECT decrypted_secret INTO v_disable[\s\S]*?IN \('1', 'true'\) THEN\s+RETURN;\s+END IF;/
    const kill = killBlock.exec(d)![0]
    const moved = mutate(d.replace(kill, ''), /(THEN\s+RETURN;\s+END IF;)/, `$1${kill}`)
    expect(order(moved)).toBe(false)
    expect(
      mutate(d, "hashtextextended('check_backfill_autochain_silent_stop', 0)", '1')
    ).not.toMatch(lock)
  })

  it('detector: dedup reads only the alert rows, per (arm, key); harvested 2xx + sent true suppresses, unharvested under 1h is pending', () => {
    const d = body(sql, FNS.detector)
    const loop = (t: string) => {
      const start = t.indexOf('FOR v_alert IN')
      return t.slice(start, t.indexOf('END LOOP;', start))
    }
    const dedup = loop(d)
    expect(dedup).toMatch(/AND a\.metadata->>'arm' = v_c\.arm\s+AND a\.metadata->>'key' = v_c\.key/)
    expect(dedup).toMatch(
      /IF v_alert\.metadata \? 'status_code' THEN[\s\S]*?IF v_status BETWEEN 200 AND 299 AND v_alert\.metadata->>'sent' = 'true' THEN\s+v_suppress := true;\s+EXIT;\s+END IF;\s+CONTINUE;\s+END IF;\s+IF v_alert\.created_at > now\(\) - v_pending THEN\s+v_suppress := true;\s+EXIT;\s+END IF;/
    )
    expect(dedup, 'the dedup loop does not read net._http_response').not.toMatch(/_http_response/)
    expect(d.match(/net\._http_response/g), 'exactly one reader: the harvest').toHaveLength(1)
    const withLive = mutate(
      d,
      'IF v_alert.created_at > now() - v_pending THEN',
      'PERFORM 1 FROM net._http_response r;\n      IF v_alert.created_at > now() - v_pending THEN'
    )
    expect(loop(withLive)).toMatch(/_http_response/)
    // the harvest copies status_code and sent once per alert, parsing sent defensively
    expect(d).toMatch(/AND NOT \(a\.metadata \? 'status_code'\)/)
    expect(d).toMatch(
      /SET metadata = metadata \|\| jsonb_build_object\('status_code', v_h\.status_code, 'sent', v_sent\)/
    )
    expect(d).toMatch(
      /BEGIN\s+v_sent := \(v_h\.content::jsonb\)->'data'->>'sent';\s+EXCEPTION WHEN OTHERS THEN/
    )
    expect(mutate(d, "AND NOT (a.metadata ? 'status_code')", '')).not.toMatch(
      /NOT \(a\.metadata \? 'status_code'\)/
    )
  })

  it('detector: sends with the refresh vault secrets and a 30s timeout; never RAISES EXCEPTION; records the alert row', () => {
    const d = body(sql, FNS.detector)
    expect(d).toMatch(/name = 'refresh_metadata_functions_base_url'/)
    expect(d).toMatch(/name = 'refresh_metadata_service_role_key'/)
    expect(d).toMatch(/v_base_url \|\| '\/functions\/v1\/alert-notify'/)
    expect(d).toMatch(/timeout_milliseconds := 30000/)
    expect(d).toMatch(
      /'indexer_backfill_autochain_silent_stop_alert'[\s\S]*?'arm', v_c\.arm,\s+'key', v_c\.key,\s+'sub_kind', v_c\.sub_kind,\s+'net_request_id', v_rid/
    )
    expect(d).toMatch(/RAISE WARNING/)
    expect(d).not.toMatch(/RAISE EXCEPTION/)
    expect(mutate(d, "RAISE WARNING 'backfill", "RAISE EXCEPTION 'backfill")).toMatch(
      /RAISE EXCEPTION/
    )
    expect(d).toMatch(/backfill-autochain-handover\.md/)
    expect(d).toMatch(/'A dispatched run got no link'/)
    // no literal secrets
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret_|Bearer [A-Za-z0-9]{20,}/)
  })

  it('smoke: asserts INVOKER/DEFINER, search_path, grants and the schedule; runs the candidates query but NOT the detector', () => {
    const smoke = sql.slice(sql.indexOf('DO $smoke$'))
    expect(smoke).toMatch(/SMOKE FAIL \(secinvoker\)/)
    expect(smoke).toMatch(/SMOKE FAIL \(secdef\)/)
    expect(smoke).toMatch(/SMOKE FAIL \(search_path\)/)
    expect(smoke).toMatch(/has_function_privilege\('anon', v_fn, 'EXECUTE'\)/)
    expect(smoke).toMatch(/has_function_privilege\('authenticated', v_fn, 'EXECUTE'\)/)
    expect(smoke).toMatch(/FROM public\.backfill_autochain_silent_stop_candidates\(\)/)
    expect(smoke, 'the detector is not executed at apply').not.toMatch(
      /(PERFORM|SELECT)\s+public\.check_backfill_autochain_silent_stop\(\)/
    )
  })

  it('no new relation is created (so no R-Grant), and the migration touches no table', () => {
    expect(sql).not.toMatch(/CREATE\s+(TABLE|VIEW|SEQUENCE|MATERIALIZED VIEW)/i)
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b|\bDROP\s+TABLE\b/i)
  })

  it('the paired rollback unschedules the job and drops both functions, and nothing else', () => {
    const p = join(process.cwd(), ROLLBACK)
    expect(existsSync(p), `${ROLLBACK} exists`).toBe(true)
    const rb = stripComments(readFileSync(p, 'utf8'))
    expect(rb).toMatch(new RegExp(`cron\\.unschedule\\('${JOB}'\\)`))
    for (const fn of Object.values(FNS))
      expect(rb).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${esc(fn)}\\(\\);`))
    // every object the migration creates is dropped by the rollback
    const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(
      (m) => m[1]
    )
    expect(created.sort()).toEqual(Object.values(FNS).sort())
    const scheduledJobs = [...sql.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(scheduledJobs).toEqual([JOB])
    // ledger/ack/alert rows stay; pg_net is a shared prerequisite
    expect(rb).not.toMatch(/DELETE FROM|TRUNCATE|DROP TABLE|DROP EXTENSION/i)
    expect(readFileSync(p, 'utf8')).toMatch(/pg_net[^\n]*shared prerequisite/)
    // known-negative: a rollback missing one drop is caught by the same predicate
    const dropsBoth = (t: string) =>
      Object.values(FNS).every((fn) =>
        new RegExp(`DROP FUNCTION IF EXISTS public\\.${esc(fn)}\\(\\);`).test(t)
      )
    expect(dropsBoth(rb)).toBe(true)
    expect(
      dropsBoth(
        mutate(rb, /DROP FUNCTION IF EXISTS public\.check_backfill_autochain_silent_stop\(\);/, '')
      )
    ).toBe(false)
  })
})
