/**
 * SMI-7142 -- PG-FREE structural suite for 20261017000000_backfill_autochain_resume_pg_cron.sql. It
 * reads migration text only and runs everywhere. Gate: git-crypt lock state (SMI-5984) -- a DECLARED
 * lock skips, an undeclared one throws. (The cron/workflow parity check is a separate file that FAILS
 * on ciphertext instead: scripts/tests/indexer/backfill-autochain-resume-cron-parity.test.ts.)
 *
 * THIS IS A TRIPWIRE, NOT A PROOF. The SQL behaviour is proven by the live-Postgres suite
 * (./backfill-autochain-resume.pg.test.ts), which CI skips. Each text predicate here is paired with a
 * known-negative: the same predicate run on a deliberately broken copy of the text must FAIL.
 *
 * @module scripts/tests/supabase/backfill-autochain-resume.structural
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../lib/sql-statement-guards.ts'
import { readMigrationText } from '../lib/migration-text-guards.ts'

const MIG = '20261017000000_backfill_autochain_resume_pg_cron.sql'
const PRIOR = '20261016000000_backfill_autochain_markers.sql'
const ROLLBACK = 'supabase/rollbacks/20261017000000_backfill_autochain_resume_pg_cron_down.sql'

const raw = readMigrationText(MIG)
const priorRaw = readMigrationText(PRIOR)
const locked = raw === null || priorRaw === null
const sql = stripComments(raw ?? '')

const DISPATCHER = 'invoke_backfill_autochain_resume'
const WATCHER = 'check_backfill_autochain_markers'
const JOB = 'backfill-autochain-resume'

/** Body of `public.<name>`: from its CREATE to the closing `$$;`, `--` comments removed. */
function body(text: string, name: string): string {
  const start = text.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`))
  if (start < 0) throw new Error(`function ${name} not found`)
  const end = text.indexOf('$$;', text.indexOf('$$', start) + 2)
  return text.slice(start, end + 3).replace(/--.*$/gm, '')
}

/** Replace `from` with `to`, THROWING when `from` is absent (a vacuous known-negative proves nothing). */
function mutate(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, () => to)
  if (out === text) throw new Error(`mutation matched nothing: ${String(from)}`)
  return out
}

const norm = (t: string) =>
  t
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

const revokesAll3 = (t: string, fn: string) =>
  new RegExp(
    `REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(\\) FROM PUBLIC, anon, authenticated;`
  ).test(t)
const grantsService = (t: string, fn: string) =>
  new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(\\) TO service_role;`).test(t)

const auditInserts = (x: string) =>
  [...x.matchAll(/INSERT INTO audit_logs[\s\S]*?\);/g)].map((m) => m[0])

/** Position of the first match of each needle in `t`, -1 when absent. */
const at = (t: string, ...needles: Array<string | RegExp>) =>
  needles.map((n) => (typeof n === 'string' ? t.indexOf(n) : t.search(n)))
const inOrder = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || xs[i - 1] < x))

describe.skipIf(locked)('SMI-7142 -- backfill autochain resume migration (PG-free)', () => {
  const d = () => body(sql, DISPATCHER)
  const w = () => body(sql, WATCHER)

  it('dispatcher is SECURITY DEFINER with the pinned search_path; neither function RETURNS TABLE', () => {
    expect(d()).toMatch(
      /RETURNS void\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public, net, vault, extensions, pg_temp\s+AS/
    )
    expect(w()).toMatch(
      /SECURITY DEFINER\s+SET search_path = public, net, vault, extensions, pg_temp\s+AS/
    )
    expect(sql).not.toMatch(/RETURNS\s+TABLE/i)
    expect(mutate(d(), 'SECURITY DEFINER', 'SECURITY INVOKER')).not.toMatch(/SECURITY DEFINER/)
  })

  it('order: advisory lock, then kill switch, then the marker scan, then the PAT, then the request', () => {
    const t = d()
    const order = (x: string) =>
      inOrder(
        at(
          x,
          "pg_try_advisory_xact_lock(hashtextextended('invoke_backfill_autochain_resume', 0))",
          "name = 'SKILLSMITH_BACKFILL_AUTOCHAIN_RESUME_DISABLE'",
          "a.event_type = 'indexer_backfill_autochain_deferred'",
          'WHERE name = v_pat_secret',
          'net.http_post('
        )
      )
    expect(order(t)).toBe(true)
    expect(t).toMatch(/IF NOT pg_try_advisory_xact_lock\([^)]*\)\) THEN\s+RETURN;/)
    expect(t).toMatch(
      /IF lower\(trim\(coalesce\(v_disable, ''\)\)\) IN \('1', 'true'\) THEN\s+RETURN;/
    )
    // known-negative: the PAT read hoisted above the kill switch is not that order
    const hoisted = mutate(
      t,
      "name = 'SKILLSMITH_BACKFILL_AUTOCHAIN_RESUME_DISABLE'",
      'name = v_pat_secret '
    )
    expect(order(hoisted)).toBe(false)
  })

  it("live-marker gate: open uses next_window_utc <= now (unreadable and non-finite count as due); consumed uses 5 minutes and the watcher's consumed_at fallback", () => {
    const t = d()
    expect(t).toMatch(/v_consumed_after CONSTANT interval := interval '5 minutes';/)
    expect(t).toMatch(
      /a\.metadata->>'state' = 'open'\s+OR \(a\.metadata->>'state' = 'consumed'\s+AND coalesce\(trim\(a\.metadata->>'dispatched_run_id'\), ''\) = ''\)/
    )
    expect(t).toMatch(
      /\(v_c\.metadata->>'next_window_utc'\)::timestamptz;\s+EXCEPTION WHEN OTHERS THEN\s+v_ref := NULL;/
    )
    expect(t).toMatch(/IF v_ref IS NOT NULL AND NOT isfinite\(v_ref\) THEN\s+v_ref := NULL;/)
    expect(t).toMatch(
      /IF v_ref IS NULL THEN\s+v_due := true;\s+v_gate := 'open_window_unreadable';\s+ELSIF v_ref <= now\(\) THEN\s+v_due := true;\s+v_gate := 'open_window_passed';/
    )
    expect(t).toMatch(
      /\(v_c\.metadata->>'consumed_at'\)::timestamptz;\s+EXCEPTION WHEN OTHERS THEN\s+v_ref := NULL;/
    )
    expect(t).toMatch(
      /IF v_ref IS NOT NULL AND \(NOT isfinite\(v_ref\) OR v_ref > now\(\)\) THEN\s+v_ref := NULL;\s+END IF;\s+v_ref := coalesce\(v_ref, v_c\.created_at\);/
    )
    expect(t).toMatch(
      /IF v_ref < now\(\) - v_consumed_after THEN\s+v_due := true;\s+v_gate := 'consumed_over_5m';/
    )
    expect(t).toMatch(/IF v_marker_id IS NULL THEN\s+RETURN;/)
    // known-negatives
    expect(mutate(t, 'v_ref <= now()', 'v_ref < now()')).not.toMatch(/ELSIF v_ref <= now\(\)/)
    expect(mutate(t, "interval '5 minutes'", "interval '0 minutes'")).not.toMatch(
      /interval '5 minutes'/
    )
    expect(
      mutate(t, 'v_ref < now() - v_consumed_after', 'v_ref <= now() - v_consumed_after')
    ).not.toMatch(/IF v_ref < now\(\) - v_consumed_after/)
  })

  it('the request: URL, ref main, inputs mode/verify_only (a STRING)/resume_source, headers, 30s timeout', () => {
    const t = d()
    expect(t).toContain(
      "'https://api.github.com/repos/smith-horn/skillsmith/actions/workflows/indexer-backfill-autochain.yml/dispatches'"
    )
    expect(t).toMatch(/v_timeout_ms\s+CONSTANT integer := 30000;/)
    expect(t).toMatch(/timeout_milliseconds := v_timeout_ms/)
    expect(t).toMatch(
      /'ref', 'main',\s+(?:--[^\n]*\s+)*'return_run_details', true,\s+'inputs', jsonb_build_object\(\s+'mode', 'resume',\s+'verify_only', 'false',\s+'resume_source', v_source\s+\)/
    )
    for (const h of [
      "'Accept', 'application/vnd.github+json'",
      "'X-GitHub-Api-Version', '2022-11-28'",
      "'User-Agent', 'skillsmith-pg-cron'",
      "'Authorization', 'Bearer ' || trim(v_pat)",
      "'Content-Type', 'application/json'",
    ])
      expect(t, h).toContain(h)
    expect(t).toMatch(/v_pat_secret\s+CONSTANT text := 'backfill_autochain_dispatch_pat';/)
    // known-negatives: a boolean verify_only, and a dropped one
    expect(mutate(t, "'verify_only', 'false'", "'verify_only', false")).not.toMatch(
      /'verify_only', 'false'/
    )
    expect(mutate(t, /\s+'verify_only', 'false',/, '')).not.toMatch(/verify_only/)
  })

  it('resume_source is sanitised to the workflow charset and capped', () => {
    const t = d()
    expect(t).toMatch(
      /v_source := 'pg_cron-' \|\|\s+left\(regexp_replace\(coalesce\(nullif\(v_marker_env, ''\), 'unknown'\), '\[\^A-Za-z0-9\._-\]', '', 'g'\), 40\);/
    )
  })

  it('the PAT is used only for its null check and the Authorization header: never written to a row, message or warning', () => {
    const t = d()
    const uses = [...t.matchAll(/\bv_pat\b/g)].length
    // declaration, SELECT INTO, the two null checks (IS NULL / length), and the header
    expect(uses).toBe(5)
    expect(t).toMatch(/'Authorization', 'Bearer ' \|\| trim\(v_pat\)/)
    const audit = auditInserts(t)
    expect(audit).toHaveLength(3)
    for (const a of audit) expect(a).not.toMatch(/v_pat\b|Bearer/)
    for (const m of t.matchAll(/RAISE WARNING[^;]*;/g)) expect(m[0]).not.toMatch(/v_pat\b/)
    // known-negative: logging the token into a row is caught by the same predicate
    const leaks = (x: string) => auditInserts(x).some((i) => /v_pat\b|Bearer/.test(i))
    expect(leaks(t)).toBe(false)
    expect(
      leaks(
        mutate(t, /'missing_secret', v_pat_secret,/, "'missing_secret', v_pat_secret, 'p', v_pat,")
      )
    ).toBe(true)
  })

  it('writes exactly the planned rows, never a marker, and never RAISES an exception', () => {
    const t = d()
    expect(t).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/)
    expect(t).not.toMatch(/RAISE EXCEPTION/)
    expect(t.match(/RAISE WARNING/g)).toHaveLength(2)
    const events = [...t.matchAll(/INSERT INTO audit_logs[^;]*?VALUES \('([a-z_]+)'/g)].map(
      (m) => m[1]
    )
    expect(events.sort()).toEqual([
      'indexer_backfill_autochain_resume_dispatch',
      'indexer_backfill_autochain_resume_error',
      'indexer_backfill_autochain_resume_error',
    ])
    expect(t).toMatch(/'missing_secret', v_pat_secret/)
    expect(t).toMatch(/EXCEPTION WHEN OTHERS THEN\s+INSERT INTO audit_logs/)
    // known-negative: a RAISE EXCEPTION in place of the missing-PAT warning is caught
    expect(
      mutate(
        t,
        /RAISE WARNING 'backfill autochain resume cannot dispatch: vault secret/,
        "RAISE EXCEPTION 'backfill autochain resume cannot dispatch: vault secret"
      )
    ).toMatch(/RAISE EXCEPTION/)
  })

  it('D3: both functions revoked from PUBLIC, anon and authenticated, then granted to service_role', () => {
    for (const fn of [DISPATCHER, WATCHER]) {
      expect(revokesAll3(sql, fn), `${fn} revoke`).toBe(true)
      expect(grantsService(sql, fn), `${fn} grant`).toBe(true)
      expect(sql.lastIndexOf(`REVOKE EXECUTE ON FUNCTION public.${fn}(`)).toBeLessThan(
        sql.lastIndexOf(`GRANT EXECUTE ON FUNCTION public.${fn}(`)
      )
      expect(
        revokesAll3(sql.replaceAll('FROM PUBLIC, anon, authenticated;', 'FROM anon;'), fn)
      ).toBe(false)
      expect(
        revokesAll3(sql.replaceAll('FROM PUBLIC, anon, authenticated;', 'FROM PUBLIC, anon;'), fn)
      ).toBe(false)
    }
  })

  it("schedules the dispatcher guard-unscheduling first, and leaves the watcher's own job alone", () => {
    expect(sql).toMatch(
      new RegExp(
        `cron\\.schedule\\(\\s*'${JOB}',\\s*'[0-9,]+ [0-9,]+ \\* \\* \\*',\\s*\\$\\$SELECT public\\.${DISPATCHER}\\(\\)\\$\\$\\s*\\)`
      )
    )
    expect(sql).toMatch(
      /SELECT cron\.unschedule\('backfill-autochain-resume'\)\s+WHERE EXISTS \(SELECT 1 FROM cron\.job WHERE jobname = 'backfill-autochain-resume'\);/
    )
    expect(sql.indexOf(`cron.unschedule('${JOB}')`)).toBeLessThan(
      sql.indexOf(`cron.schedule(\n  '${JOB}'`)
    )
    expect([...sql.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map((m) => m[1])).toEqual([JOB])
    expect(sql).not.toMatch(/cron\.unschedule\('backfill-autochain-marker-watch'\)/)
  })

  it('smoke: asserts DEFINER, search_path, grants, both schedules; never executes either function', () => {
    const smoke = sql.slice(sql.indexOf('DO $smoke$'))
    expect(smoke).toMatch(/SMOKE FAIL \(secdef\)/)
    expect(smoke).toMatch(/SMOKE FAIL \(search_path\)/)
    expect(smoke).toMatch(/has_function_privilege\('anon', v_fn, 'EXECUTE'\)/)
    expect(smoke).toMatch(/has_function_privilege\('authenticated', v_fn, 'EXECUTE'\)/)
    expect(smoke).toMatch(
      /IF v_schedule IS DISTINCT FROM '3,23,43 1,4,9,10,15,16,21,22 \* \* \*' THEN/
    )
    expect(smoke).toMatch(/IF v_schedule IS DISTINCT FROM '29 \* \* \* \*' THEN/)
    expect(smoke).toMatch(/position\('resume_dispatch_failed' IN v_src\) = 0/)
    const executes = (t: string) =>
      /(?<!['"])\b(PERFORM|SELECT)\s+public\.(invoke_backfill_autochain_resume|check_backfill_autochain_markers)\s*\(/.test(
        t
      )
    expect(executes(smoke), 'the smoke block runs neither function').toBe(false)
    expect(
      executes(
        mutate(
          smoke,
          'RAISE NOTICE',
          'PERFORM public.invoke_backfill_autochain_resume(); RAISE NOTICE'
        )
      )
    ).toBe(true)
  })

  it('watcher: every pre-existing line is unchanged -- the new body is the old one plus exactly the declared additions', () => {
    const oldBody = body(stripComments(priorRaw ?? ''), WATCHER)
    const harvest = (t: string) => {
      const s = t.indexOf('FOR v_h IN')
      return [s, t.indexOf('END LOOP;', s) + 'END LOOP;'.length] as const
    }
    const restore = (t: string) => {
      const [os, oe] = harvest(oldBody)
      const [ns, ne] = harvest(t)
      let r = t.slice(0, ns) + oldBody.slice(os, oe) + t.slice(ne)
      r = r.slice(0, r.indexOf('FOR v_f IN')) + r.slice(r.lastIndexOf('END;'))
      return norm(r).filter(
        (l) =>
          !/^(v_fail_window CONSTANT interval := interval '3 hours';|v_noresp_after CONSTANT interval := interval '1 hour';|v_f record;|v_reason text;|v_msg text;|v_wrid text;)$/.test(
            l
          )
      )
    }
    expect(restore(w())).toEqual(norm(oldBody))
    // known-negatives: a changed threshold, a dropped dedup line, and a changed kill-switch name each break equality
    expect(restore(mutate(w(), /interval '24 hours'/, "interval '25 hours'"))).not.toEqual(
      norm(oldBody)
    )
    expect(restore(mutate(w(), /IF v_suppress THEN\s+CONTINUE;\s+END IF;/, ''))).not.toEqual(
      norm(oldBody)
    )
    expect(
      restore(
        mutate(
          w(),
          'SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLE',
          'SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLED'
        )
      )
    ).not.toEqual(norm(oldBody))
  })

  it('watcher: the harvest covers the dispatcher rows (status, body, error_msg, timed_out, run id) and still alert rows', () => {
    const t = w()
    expect(t).toMatch(
      /a\.event_type IN \('indexer_backfill_autochain_marker_alert',\s+'indexer_backfill_autochain_resume_dispatch'\)\s+AND a\.created_at >= now\(\) - v_dedup\s+AND NOT \(a\.metadata \? 'status_code'\)/
    )
    expect(t).toMatch(
      /SELECT d\.id, d\.event_type, r\.status_code, r\.content, r\.error_msg, r\.timed_out/
    )
    expect(t).toMatch(
      /'body', left\(v_h\.content, 300\),\s+'error_msg', left\(v_h\.error_msg, 200\),\s+'timed_out', v_h\.timed_out,\s+'workflow_run_id', v_wrid/
    )
    expect(t).toMatch(
      /v_wrid := \(v_h\.content::jsonb\)->>'workflow_run_id';\s+EXCEPTION WHEN OTHERS THEN/
    )
    // the harvest still precedes the kill switch; it is the only JOIN on pg_net's table, and the
    // failure arm's no-response check is the only other reader (one NOT EXISTS, pinned below)
    expect(
      inOrder(
        at(
          t,
          'JOIN net._http_response r ON r.id = d.rid',
          "'SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLE'"
        )
      )
    ).toBe(true)
    expect(t.match(/JOIN net\._http_response/g)).toHaveLength(1)
    expect(t.match(/FROM net\._http_response/g)).toHaveLength(1)
    const inList = (x: string) =>
      /a\.event_type IN \('indexer_backfill_autochain_marker_alert',\s+'indexer_backfill_autochain_resume_dispatch'\)/.test(
        x
      )
    expect(inList(t)).toBe(true)
    expect(
      inList(
        mutate(
          t,
          "'indexer_backfill_autochain_resume_dispatch')",
          "'indexer_backfill_autochain_resume_dispatch_x')"
        )
      )
    ).toBe(false)
  })

  it('watcher: the failure arm -- 3h window, newest failing event per marker, regex-guarded cast, delivery dedup, own section', () => {
    const t = w()
    const arm = t.slice(t.indexOf('FOR v_f IN'))
    expect(t).toMatch(/v_fail_window\s+CONSTANT interval := interval '3 hours';/)
    expect(arm).toMatch(
      /SELECT DISTINCT ON \(f\.marker_id\) f\.marker_id, f\.event_type, f\.metadata, f\.created_at/
    )
    expect(arm).toMatch(
      /CASE WHEN a\.event_type = 'indexer_backfill_autochain_resume_error' THEN false\s+WHEN a\.metadata->>'status_code' ~ '\^\[0-9\]\{1,3\}\$'\s+THEN \(a\.metadata->>'status_code'\)::integer BETWEEN 200 AND 299\s+ELSE false END AS ok/
    )
    expect(arm).toMatch(
      /AND \(a\.event_type = 'indexer_backfill_autochain_resume_error'\s+OR \(a\.event_type = 'indexer_backfill_autochain_resume_dispatch'\s+AND \(a\.metadata \? 'status_code'\s+OR \(a\.created_at < now\(\) - v_noresp_after\s+AND NOT EXISTS \(\s+SELECT 1 FROM net\._http_response r\s+WHERE r\.id = CASE WHEN a\.metadata->>'net_request_id' ~ '\^\[0-9\]\{1,18\}\$'\s+THEN \(a\.metadata->>'net_request_id'\)::bigint END\)\)\)\)\)/
    )
    expect(t).toMatch(/v_noresp_after\s+CONSTANT interval := interval '1 hour';/)
    expect(arm).toMatch(
      /WHEN NOT \(v_f\.metadata \? 'status_code'\)\s+THEN 'no response from pg_net after 1h'/
    )
    expect(arm).toMatch(/WHERE NOT f\.ok\s+ORDER BY f\.marker_id, f\.created_at DESC/)
    expect(arm).toMatch(
      /v_kind := 'resume_dispatch_failed';\s+v_section := '`resume_dispatch_failed`';/
    )
    expect(arm).toMatch(
      /AND a\.metadata->>'marker_id' = v_f\.marker_id\s+AND a\.metadata->>'kind' = v_kind/
    )
    expect(arm).toMatch(
      /IF v_status BETWEEN 200 AND 299 AND v_alert\.metadata->>'sent' = 'true' THEN\s+v_suppress := true;\s+EXIT;/
    )
    expect(arm).toMatch(/IF v_alert\.created_at > now\(\) - v_pending THEN\s+v_suppress := true;/)
    // dedup reads only the alert rows, never pg_net's table
    const dedup = arm.slice(arm.indexOf('v_suppress := false'), arm.indexOf("'type', 'indexer_"))
    expect(dedup.length).toBeGreaterThan(100)
    expect(dedup).not.toMatch(/_http_response/)
    expect(arm).toMatch(/'type', 'indexer_backfill_autochain_' \|\| v_kind/)
    expect(arm).toMatch(/'row_locked', false,\s+'failure_event', v_f\.event_type/)
    expect(arm).not.toMatch(/RAISE EXCEPTION/)
    // known-negatives
    const okRange = (x: string) => /::integer BETWEEN 200 AND 299\s+ELSE false END AS ok/.test(x)
    expect(okRange(arm)).toBe(true)
    expect(
      okRange(mutate(arm, '::integer BETWEEN 200 AND 299', '::integer BETWEEN 200 AND 399'))
    ).toBe(false)
    const keyed = (x: string) => /AND \(a\.metadata \? 'status_code'\s+OR \(a\.created_at/.test(x)
    expect(keyed(arm)).toBe(true)
    expect(keyed(mutate(arm, "AND (a.metadata ? 'status_code'", 'AND (true'))).toBe(false)
    const noResp = (x: string) => /OR \(a\.created_at < now\(\) - v_noresp_after/.test(x)
    expect(noResp(arm)).toBe(true)
    expect(noResp(mutate(arm, 'OR (a.created_at < now() - v_noresp_after', 'OR (false'))).toBe(
      false
    )
    // the no-response arm also requires no pg_net response row for that dispatch, in the same scan
    const noRow = (x: string) =>
      /v_noresp_after\s+AND NOT EXISTS \(\s+SELECT 1 FROM net\._http_response r/.test(x)
    expect(noRow(arm)).toBe(true)
    expect(noRow(mutate(arm, 'AND NOT EXISTS (', 'AND (EXISTS ('))).toBe(false)
  })

  it('watcher: the runbook section the failure alert names, and the COMMENT, name the new kind', () => {
    expect(w()).toContain("'`resume_dispatch_failed`'")
    const comment =
      /COMMENT ON FUNCTION public\.check_backfill_autochain_markers\(\) IS\s+'((?:[^']|'')*)'/.exec(
        sql
      )
    expect(comment, 'a watcher COMMENT exists').not.toBeNull()
    for (const part of [
      'resume_dispatch_failed',
      'indexer_backfill_autochain_resume_dispatch',
      'status_code',
      'SMI-7142',
      'Cron 29 * * * *',
    ])
      expect(comment![1], `COMMENT names ${part}`).toContain(part)
    const dcomment =
      /COMMENT ON FUNCTION public\.invoke_backfill_autochain_resume\(\) IS\s+'((?:[^']|'')*)'/.exec(
        sql
      )
    expect(dcomment![1]).toContain('3,23,43 1,4,9,10,15,16,21,22 * * *')
  })

  it('the paired rollback unschedules only the resume job, drops the dispatcher, and restores the prior watcher verbatim', () => {
    const p = join(process.cwd(), ROLLBACK)
    expect(existsSync(p), `${ROLLBACK} exists`).toBe(true)
    const rbRaw = readFileSync(p, 'utf8')
    const rb = stripComments(rbRaw)
    expect(rb).toMatch(/cron\.unschedule\('backfill-autochain-resume'\)/)
    expect(rb).not.toMatch(/cron\.unschedule\('backfill-autochain-marker-watch'\)/)
    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.invoke_backfill_autochain_resume\(\);/)
    expect(rb).not.toMatch(/DROP FUNCTION IF EXISTS public\.check_backfill_autochain_markers/)
    expect(rb).not.toMatch(/DELETE FROM|TRUNCATE|DROP TABLE|DROP EXTENSION|DROP SCHEMA/i)
    expect(rbRaw).toMatch(/pg_net is a shared prerequisite/)
    // the restored body is the prior migration's, line for line
    const restored = norm(body(rb, WATCHER))
    expect(restored).toEqual(norm(body(stripComments(priorRaw ?? ''), WATCHER)))
    expect(restored).not.toContain("v_section := '`resume_dispatch_failed`';")
    expect(restored.join('\n')).not.toMatch(/resume_dispatch/)
    // and its COMMENT is the prior one, not the extended one
    expect(rb).not.toMatch(/resume_dispatch_failed/)
    expect(revokesAll3(rb, WATCHER) && grantsService(rb, WATCHER)).toBe(true)
    // the migration creates exactly these two functions: one dropped, one restored
    expect(
      [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).sort()
    ).toEqual([DISPATCHER, WATCHER].sort())
  })
})
