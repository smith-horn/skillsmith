#!/usr/bin/env tsx
/**
 * SMI-5166: Durable indexer stale-recheck.
 *
 * THE 7-DAY REALITY
 * -----------------
 * Daily maintenance reconcile (Phase 6, `reconcileStaleSkills`) quarantines any
 * skill whose `last_seen_at` is older than 7 days. The ONLY writer of
 * `last_seen_at` is discovery: a skill's timestamp is refreshed when the indexer
 * re-discovers its repo via topic/code search. A live-but-undiscovered GitHub
 * skill (the repo still exists and SKILL.md still passes the scanner, but the
 * repo no longer surfaces in any discovery query) therefore has NO
 * discovery-independent writer of `last_seen_at` — it ages past 7 days and
 * slides into permanent stale quarantine, never to return.
 *
 * THE FIX — TWO MECHANISMS
 * ------------------------
 * This recurring "recheck" re-fetches candidates by their STORED `repo_url`
 * (no discovery query needed) and:
 *
 *   1. PREVENTION (the hard-deadline cohort): for LIVE rows
 *      (`quarantined = false`) whose `last_seen_at` has crossed a recheck
 *      threshold (< 7 days, see THRESHOLD_MAX) but which still pass the scanner,
 *      it CAS-refreshes `last_seen_at` BEFORE the 7-day maintenance gate fires.
 *      This keeps live undiscovered skills out of quarantine in the first place.
 *
 *   2. SELF-HEAL: for rows ALREADY in stale quarantine
 *      (`quarantined = true`, reason null/'stale') whose repo is still live and
 *      whose SKILL.md still passes, it CAS-clears the quarantine.
 *
 * Per-row logic is delegated entirely to `processRow` (revalidate-stale-
 * quarantines.ts), which already handles BOTH cohorts: a `quarantined === false`
 * clean row returns `'live-touched'`, a `quarantined === true` clean row returns
 * `'cleared'`. We do NOT reimplement fetch/scan/CAS here.
 *
 * TWO-PASS PRIORITY (under cap saturation)
 * ----------------------------------------
 * Candidates are loaded in two passes inside a single cap. Pass 1 (prevention)
 * is served first because it is the hard-deadline cohort: a row missed in pass 1
 * crosses the 7-day gate and falls INTO quarantine, which would then need
 * pass-2 self-heal next run — a positive-feedback loop where self-heal backlog
 * grows because prevention was starved. Pass 2 (self-heal) only consumes the cap
 * remaining after pass 1, so prevention can never be crowded out by self-heal.
 *
 * Both passes order by `last_seen_at` ASC: the oldest rows are closest to the
 * 7-day gate (prevention) or have been quarantined longest (self-heal), so they
 * are the most urgent and are served first under cap pressure.
 *
 * AUDIT
 * -----
 * Writes ONE `indexer:run` audit row per run (event_type load-bearing across
 * v_indexer_health / ops-report; `metadata.run_type = 'recheck'` distinguishes
 * it) carrying a `metadata.recheck` counters object. The AUTHORITATIVE
 * fetch-health signal is `recheck.fetch_error_rate` — recheck does not thread
 * rate-limit telemetry through `fetchSkillMd` in v1, so the `metadata.meta`
 * rate-limit fields are zero.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import {
  newRateLimitTelemetry,
  summarizeRateLimitTelemetry,
  type RateLimitTelemetry,
} from './_shared/rate-limit.ts'
import { writeIndexerAuditLog } from './indexer-audit-log.ts'
import type { RecheckAuditCounters } from './indexer-audit-log.ts'
import { processRow, type StaleQuarantinedRow } from './revalidate-stale-quarantines.ts'
import {
  getRecheckMaxSiblingClears,
  loadPass3Candidates,
  buildRecheckResult,
  zeroCounters,
  recheckAuditZeroFills,
  pageCandidates,
  isSiblingQuarantineRow,
  type RecheckResult,
} from './recheck.helpers.ts'
// Re-export so existing callers (run.ts) importing from recheck.ts still resolve.
export type { RecheckResult }

// ---------------------------------------------------------------------------
// Constants (clamps, E7)
// ---------------------------------------------------------------------------

/** Recheck threshold MUST stay strictly below the 7-day maintenance gate so a
 *  prevention touch lands before the row would be quarantined. */
const THRESHOLD_MIN = 1
const THRESHOLD_MAX = 6
const BATCH_MIN = 1
const BATCH_MAX = 10
const CAP_MIN = 1
const CAP_MAX = 5000
/** Mirror of MAX_FETCH_ERROR_RATE in revalidate-stale-quarantines.ts: above
 *  this fraction the run is throttled and its last_seen_at touches are
 *  unreliable — a PREVENTION OUTAGE, not a quiet 0-cleared run. */
const MAX_FETCH_ERROR_RATE = 0.1

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.trunc(n)))

// ---------------------------------------------------------------------------
// Candidate loading (three-pass preventive-priority)
// ---------------------------------------------------------------------------

/**
 * Load recheck candidates with three-pass preventive priority inside a single cap.
 *
 * PASS 1 (prevention): `quarantined = false` AND `last_seen_at < cutoff` AND
 * GitHub repo_url — the hard-deadline cohort. Served first (see file header):
 * under cap saturation, prevention must not be starved by self-heal, or a
 * positive-feedback loop forms (missed prevention → falls into quarantine →
 * grows the self-heal backlog).
 *
 * PASS 2 (self-heal), ONLY if cap remains: `quarantined = true` AND
 * (reason null OR 'stale') AND `last_seen_at < cutoff` AND GitHub repo_url.
 *
 * PASS 3 (sibling-quarantined cohort, SMI-5445), ONLY if cap remains after
 * PASS 1+2: calls the DB-side RPC `get_recheck_sibling_candidates` which
 * filters on `jsonb_path_exists(security_findings, '$[*].filePath ? (@ != null && @ != "")')`.
 * Dedup by id across passes (M1) — a row can match both PASS 2 (reason null) and
 * PASS 3 (filePath) if it has both conditions; it is served only once (PASS 2 wins
 * position/priority, PASS 3 adds the rest).
 *
 * Both PASS 1+2 order by `last_seen_at` ASC — oldest rows are closest to the
 * 7-day gate (pass 1) or quarantined longest (pass 2), so most urgent first.
 */
export async function loadRecheckCandidates(
  db: SupabaseClient,
  opts: { thresholdDays: number; cap: number }
): Promise<StaleQuarantinedRow[]> {
  const cutoff = new Date(Date.now() - opts.thresholdDays * 86_400_000).toISOString()

  // PASS 1 — prevention (live, aging, not yet quarantined).
  const pass1 = await pageCandidates(db, 'pass1-prevention', opts.cap, (q) =>
    q.eq('quarantined', false).lt('last_seen_at', cutoff).ilike('repo_url', 'https://github.com/%')
  )

  // PASS 2 — self-heal, only if cap remains after prevention.
  const remaining2 = opts.cap - pass1.length
  if (remaining2 <= 0) return pass1

  const pass2 = await pageCandidates(db, 'pass2-selfheal', remaining2, (q) =>
    q
      .eq('quarantined', true)
      .or('quarantine_reason.is.null,quarantine_reason.eq.stale')
      .lt('last_seen_at', cutoff)
      .ilike('repo_url', 'https://github.com/%')
  )

  // PASS 3 (SMI-5445 H1): sibling-quarantined rows, only if cap remains after PASS 1+2.
  // Uses the DB-side RPC predicate to avoid the starvation-correctness bug of the
  // naive in-code post-filter (see plan §3 for the starvation analysis).
  const remaining3 = opts.cap - pass1.length - pass2.length
  if (remaining3 <= 0) return pass1.concat(pass2)

  // SMI-5445 M1: dedup by id — a row that matches both PASS 2 and PASS 3
  // (reason null AND filePath != null) must not appear twice.
  const seen = new Set([...pass1, ...pass2].map((r) => r.id))

  let pass3: StaleQuarantinedRow[] = []
  try {
    const rawPass3 = await loadPass3Candidates(db, cutoff, remaining3)
    pass3 = rawPass3.filter((r) => !seen.has(r.id))
  } catch (err) {
    // PASS 3 failure is non-fatal: log and continue with PASS 1+2 results.
    // The sibling cohort will be retried on the next cron run.
    console.warn(
      `[recheck] PASS 3 RPC failed — sibling-quarantined candidates not loaded this run: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return [...pass1, ...pass2, ...pass3]
}

// ---------------------------------------------------------------------------
// Killswitch (P3)
// ---------------------------------------------------------------------------

/**
 * `RECHECK_ENABLED` defaults to ENABLED (absent/'1'/'true'/'True'/'TRUE'). Only
 * an explicit disable value turns the recheck off — a deploy that forgets to set
 * the var still runs the recheck (prevention is the safer default).
 */
function recheckEnabled(): boolean {
  const raw = process.env.RECHECK_ENABLED
  if (raw === undefined) return true
  const v = raw.trim().toLowerCase()
  return v === '' || v === '1' || v === 'true'
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Run the durable stale-recheck: prevention + self-heal, one audit row. */
export async function runRecheck(opts: {
  supabase: SupabaseClient
  requestId: string
  apply: boolean
  thresholdDays: number
  cap: number
  batch: number
  telemetry?: RateLimitTelemetry
}): Promise<RecheckResult> {
  const { supabase, requestId, apply } = opts

  // (a) KILLSWITCH — write one audit row, log, and bail before any fetch.
  if (!recheckEnabled()) {
    const counters = zeroCounters(true)
    await writeIndexerAuditLog(supabase, 'success', {
      requestId,
      runType: 'recheck',
      dryRun: !apply,
      ...recheckAuditZeroFills(),
      recheck: counters,
      meta: {
        request_id: requestId,
        run_type: 'recheck',
        ...summarizeRateLimitTelemetry(opts.telemetry ?? newRateLimitTelemetry()),
        concurrency: 1,
        kill_switch_engaged: true,
        topics: [],
        cron_slot: null,
        rotation_source: 'fallback',
        tree_hash_cache_hits: 0,
        tree_hash_cache_misses: 0,
      },
    })
    console.log(JSON.stringify({ event: 'recheck_skipped_killswitch', request_id: requestId }))
    return buildRecheckResult(counters, !apply, true, [])
  }

  // (b) Clamp inputs; warn on any clamp so operators notice an out-of-range arg.
  const thresholdDays = clamp(opts.thresholdDays, THRESHOLD_MIN, THRESHOLD_MAX)
  const cap = clamp(opts.cap, CAP_MIN, CAP_MAX)
  const batch = clamp(opts.batch, BATCH_MIN, BATCH_MAX)
  if (thresholdDays !== opts.thresholdDays)
    console.warn(`[recheck] thresholdDays clamped ${opts.thresholdDays} -> ${thresholdDays}`)
  if (cap !== opts.cap) console.warn(`[recheck] cap clamped ${opts.cap} -> ${cap}`)
  if (batch !== opts.batch) console.warn(`[recheck] batch clamped ${opts.batch} -> ${batch}`)

  // (c) Build GitHub headers; (d) load candidates (three-pass preventive priority).
  const headers = await buildGitHubHeaders()
  const rows = await loadRecheckCandidates(supabase, { thresholdDays, cap })

  // SMI-5445 M3: per-pass candidate counts. PASS 1 = quarantined=false rows;
  // PASS 2 = quarantined=true, reason null/'stale'; PASS 3 = sibling-quarantined.
  // We infer counts from the row shape because loadRecheckCandidates returns a flat
  // merged list. PASS 3 rows are identified by the SINGLE canonical predicate
  // isSiblingQuarantineRow — the same predicate pass3_sibling_recovered uses below,
  // so the two counters can never diverge (SMI-5445 C2-low reconciliation).
  const pass1Count = rows.filter((r) => r.quarantined === false).length
  const pass3Count = rows.filter(isSiblingQuarantineRow).length
  const pass2Count = rows.length - pass1Count - pass3Count

  // SMI-5445 C2: per-run sibling-clear cap. Once this many sibling-quarantine
  // clears have occurred in this run, further sibling-recovered outcomes are
  // deferred to the next cycle (outcome: 'deferred-cap').
  const maxSiblingClears = getRecheckMaxSiblingClears()
  // SPIKE_THRESHOLD: if more than half the cap is consumed in one run, emit a WARN.
  // Operators should investigate unusual auto-clear bursts.
  const siblingClearSpikeThreshold = Math.max(1, Math.floor(maxSiblingClears / 2))

  // (e) Tally per-row outcomes in batches (polite GitHub concurrency).
  let cleared = 0
  let liveTouched = 0
  let keptSecurity = 0
  let requarantined = 0
  let repoGone = 0
  let parseFailed = 0
  let fetchErrors = 0
  let casSkipped = 0
  let errors = 0
  // SMI-5436 Wave 2: sibling gate counter preserved for audit log schema compatibility.
  // Always 0 post-SMI-5437 (gate removed — sibling re-scan now runs inside processRow).
  const siblingGateSkipped = 0
  // SMI-5437 Wave 2: sibling re-scan outcome counters.
  let siblingRequarantined = 0
  let siblingRecovered = 0
  // SMI-5445 C2: deferred-cap tally (rows processRow returned 'deferred-cap' for).
  let deferredCap = 0
  // SMI-5445 M3: PASS-3 sibling-recovered sub-counter.
  let pass3SiblingRecovered = 0

  // SMI-5445 C2: mutable clear budget threaded into processRow so the cap is
  // enforced BEFORE the DB write, not post-hoc in the switch below. processRow
  // checks-then-decrements synchronously before any DB await, which is race-free
  // in Node.js even under Promise.all: all budget checks complete in the current
  // tick before any I/O resumes in microtask queue callbacks.
  const clearBudget = { remaining: maxSiblingClears }

  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch)
    // SMI-5437: sibling gate removed. All rows now pass to processRow, which runs
    // sibling re-scan internally on quarantined=true rows with clean SKILL.md.
    // SMI-5445 C2: clearBudget is shared across all rows so processRow can gate
    // the write before it happens — the cap is enforced at the source, not post-hoc.
    const results = await Promise.all(
      slice.map((r) =>
        processRow(
          r,
          headers,
          apply,
          supabase,
          opts.telemetry ?? newRateLimitTelemetry(),
          clearBudget
        )
      )
    )
    for (const r of results) {
      switch (r.outcome) {
        case 'cleared':
          cleared++
          break
        // SMI-5437 Wave 2: sibling-recovered is additive — increments both
        // cleared AND sibling_recovered (the skill was unquarantined after sibling
        // rescan confirmed all siblings clean).
        // SMI-5445 C2: the cap was enforced inside processRow before the DB write;
        // a 'sibling-recovered' outcome here means the clear already happened.
        case 'sibling-recovered':
          cleared++
          siblingRecovered++
          // SMI-5445 M3: track whether this was a PASS-3 sibling-quarantine row.
          // Keyed on the SAME canonical predicate as pass3Count above so the two
          // counters stay consistent (SMI-5445 C2-low reconciliation).
          if (isSiblingQuarantineRow(r.row)) {
            pass3SiblingRecovered++
          }
          break
        case 'live-touched':
          liveTouched++
          break
        case 'kept-security':
          keptSecurity++
          break
        case 'requarantined':
          requarantined++
          break
        // SMI-5437 Wave 2: sibling-requarantined is additive — increments both
        // requarantined AND sibling_requarantined (sibling still/newly malicious).
        case 'sibling-requarantined':
          requarantined++
          siblingRequarantined++
          break
        case 'repo-gone':
          repoGone++
          break
        case 'parse-failed':
          parseFailed++
          break
        case 'fetch-error':
          fetchErrors++
          break
        case 'cas-skipped':
          casSkipped++
          break
        case 'error':
          errors++
          break
        // SMI-5445 C2: 'deferred-cap' is now emitted directly by processRow when
        // the clearBudget is exhausted before the DB write. The row stays
        // quarantined=true; no DB write or audit row was issued.
        case 'deferred-cap':
          deferredCap++
          break
        default:
          // Defense-in-depth (mirrors runSweep's guard): a future outcome added
          // without a case here would otherwise be silently dropped from the run
          // counters — the exact invisible-success class SMI-5377 fixed.
          console.warn(`recheck: unhandled processRow outcome ${r.outcome} — not counted`)
      }
    }
  }

  // SMI-5445 C2: spike alert — an abnormal auto-clear wave should be investigated.
  if (siblingRecovered > siblingClearSpikeThreshold) {
    console.warn(
      `[recheck] SPIKE ALERT: ${siblingRecovered} sibling-quarantine clears in a single run ` +
        `(threshold ${siblingClearSpikeThreshold}). Investigate for evidence-scrubbing or ` +
        `unusual fixture state. Run: sibling_recovered=${siblingRecovered}, deferredCap=${deferredCap}`
    )
  }

  // (f) Derive run-level signals.
  const total = rows.length
  const fetchErrorRate = total > 0 ? fetchErrors / total : 0
  const capSaturated = rows.length >= cap

  // (g) Assemble the recheck counters (killswitch off on a live run).
  const counters: RecheckAuditCounters = {
    candidate_count: total,
    live_touched: liveTouched,
    cleared,
    kept_security: keptSecurity,
    requarantined,
    repo_gone: repoGone,
    parse_failed: parseFailed,
    fetch_error: fetchErrors,
    cas_skipped: casSkipped,
    errors,
    sibling_gate_skipped: siblingGateSkipped,
    // SMI-5437 Wave 2: sibling re-scan outcome counters. Additive with cleared/requarantined.
    sibling_requarantined: siblingRequarantined,
    sibling_recovered: siblingRecovered,
    fetch_error_rate: fetchErrorRate,
    cap_saturated: capSaturated,
    killswitch_engaged: false,
    // SMI-5445 M3: per-pass candidate counts for dashboard disambiguation.
    pass1_count: pass1Count,
    pass2_count: pass2Count,
    pass3_count: pass3Count,
    pass3_sibling_recovered: pass3SiblingRecovered,
    // SMI-5445 C2: deferred-cap count (rows that hit the per-run sibling-clear cap).
    deferred_cap: deferredCap,
  }

  // (h) Classify the audit result; a throttled recheck is a prevention OUTAGE.
  const throttled = fetchErrorRate > MAX_FETCH_ERROR_RATE
  const eventResult: 'success' | 'partial' = errors > 0 || throttled ? 'partial' : 'success'
  if (throttled) {
    console.warn(
      `[recheck] ${fetchErrors}/${total} rows hit transient fetch errors ` +
        `(> ${MAX_FETCH_ERROR_RATE * 100}%). This is a PREVENTION OUTAGE: the ` +
        `last_seen_at touches are unreliable, materially different from a quiet ` +
        `0-cleared run. Re-run when GitHub is not rate-limiting.`
    )
  }

  // (i) Write the single audit row. NOTE: the AuditLogMeta rate-limit fields are
  // zero — recheck does not thread telemetry through fetchSkillMd in v1; the
  // AUTHORITATIVE fetch-health signal is `recheck.fetch_error_rate` in metadata.
  await writeIndexerAuditLog(supabase, eventResult, {
    requestId,
    runType: 'recheck',
    dryRun: !apply,
    ...recheckAuditZeroFills(),
    recheck: counters,
    meta: {
      request_id: requestId,
      run_type: 'recheck',
      ...summarizeRateLimitTelemetry(opts.telemetry ?? newRateLimitTelemetry()),
      concurrency: 1,
      kill_switch_engaged: false,
      topics: [],
      cron_slot: null,
      rotation_source: 'fallback',
      tree_hash_cache_hits: 0,
      tree_hash_cache_misses: 0,
    },
  })

  // (j) Structured summary line + return.
  console.log(
    JSON.stringify({
      event: 'recheck_complete',
      request_id: requestId,
      dry_run: !apply,
      event_result: eventResult,
      ...counters,
    })
  )

  return buildRecheckResult(counters, !apply, false, [])
}
