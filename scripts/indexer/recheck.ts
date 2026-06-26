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
/** PostgREST caps a single response at 1000 rows; candidate sets are larger. */
const PAGE_SIZE = 1000

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.trunc(n)))

// ---------------------------------------------------------------------------
// Candidate loading (two-pass preventive-priority)
// ---------------------------------------------------------------------------

const SELECT_COLUMNS =
  'id, author, name, repo_url, skill_path, quarantine_reason, security_findings, quarantined, last_seen_at'

/**
 * Page a single PostgREST filter set, ordered by `last_seen_at` ASC, accumulating
 * up to `limit` rows. Stops when a page returns fewer than requested or `limit`
 * is filled. `pass` is folded into the error message for diagnosability.
 */
async function pageCandidates(
  db: SupabaseClient,
  pass: string,
  limit: number,
  applyFilters: (
    q: ReturnType<ReturnType<SupabaseClient['from']>['select']>
  ) => ReturnType<ReturnType<SupabaseClient['from']>['select']>
): Promise<StaleQuarantinedRow[]> {
  const out: StaleQuarantinedRow[] = []
  for (let page = 0; ; page++) {
    const remaining = Math.min(PAGE_SIZE, limit - out.length)
    if (remaining <= 0) break
    const from = page * PAGE_SIZE
    const { data, error } = await applyFilters(db.from('skills').select(SELECT_COLUMNS))
      .order('last_seen_at', { ascending: true })
      .range(from, from + remaining - 1)
    if (error) {
      throw new Error(`Failed to load recheck candidates (${pass}, page ${page}): ${error.message}`)
    }
    const rows = (data ?? []) as unknown as StaleQuarantinedRow[]
    out.push(...rows)
    if (rows.length < remaining) break
  }
  return out.slice(0, limit)
}

/**
 * Load recheck candidates with two-pass preventive priority inside a single cap.
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
 * Both passes order by `last_seen_at` ASC — oldest rows are closest to the
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
  const remaining = opts.cap - pass1.length
  if (remaining <= 0) return pass1

  const pass2 = await pageCandidates(db, 'pass2-selfheal', remaining, (q) =>
    q
      .eq('quarantined', true)
      .or('quarantine_reason.is.null,quarantine_reason.eq.stale')
      .lt('last_seen_at', cutoff)
      .ilike('repo_url', 'https://github.com/%')
  )

  return pass1.concat(pass2)
}

// ---------------------------------------------------------------------------
// Result payload
// ---------------------------------------------------------------------------

/**
 * Data payload returned to run.ts / printed to stdout. Mirrors the maintenance
 * zero-fill shape so the existing `.github/workflows/indexer.yml` Parse Results
 * jq keys (found/indexed/updated/...) all exist, PLUS the namespaced `recheck`
 * object carrying the recheck-specific counters.
 */
export interface RecheckResult {
  found: number
  indexed: number
  updated: number
  failed: number
  quarantined: number
  skipped: boolean
  stale: number
  quality_gate_filtered: number
  meta_list_filtered: number
  unchanged: number
  github_skill_count: number
  code_search: { repos_found: number; retries: number }
  errors: string[]
  dryRun: boolean
  repositories_found: number
  recheck: RecheckAuditCounters
}

/** Build the zero-filled RecheckResult around a given counters object. */
function buildRecheckResult(
  counters: RecheckAuditCounters,
  dryRun: boolean,
  skipped: boolean,
  errors: string[]
): RecheckResult {
  return {
    found: 0,
    indexed: 0,
    updated: 0,
    failed: 0,
    quarantined: 0,
    skipped,
    stale: 0,
    quality_gate_filtered: 0,
    meta_list_filtered: 0,
    unchanged: 0,
    github_skill_count: 0,
    code_search: { repos_found: 0, retries: 0 },
    errors,
    dryRun,
    repositories_found: 0,
    recheck: counters,
  }
}

/** All-zero counters with explicit cap/killswitch flags. */
function zeroCounters(killswitchEngaged: boolean): RecheckAuditCounters {
  return {
    candidate_count: 0,
    live_touched: 0,
    cleared: 0,
    kept_security: 0,
    requarantined: 0,
    repo_gone: 0,
    parse_failed: 0,
    fetch_error: 0,
    cas_skipped: 0,
    errors: 0,
    fetch_error_rate: 0,
    cap_saturated: false,
    killswitch_engaged: killswitchEngaged,
  }
}

/**
 * Build the maintenance-style zero-fill block for writeIndexerAuditLog so a
 * recheck audit row carries the same flat keys as discovery/maintenance rows
 * (v_indexer_health / ops-report don't branch on run type).
 */
function recheckAuditZeroFills(): {
  topics: string[]
  found: number
  indexed: number
  updated: number
  failed: number
  stale: number
  quality_gate_filtered: number
  unchanged: number
  quarantined: number
  github_skill_count: number
  code_search: { repos_found: number; retries: number }
  scoreDistribution: { highTrust: number; community: number; scores: number[] }
  categorizedCount: number
  categoryAssignments: number
  wildcard_expansion_count: number
  cron_slot: number | null
  rotation_source: 'fallback'
  discovery_path_counts: Record<string, number>
  high_trust_fallback_hits: number
} {
  return {
    topics: [],
    found: 0,
    indexed: 0,
    updated: 0,
    failed: 0,
    stale: 0,
    quality_gate_filtered: 0,
    unchanged: 0,
    quarantined: 0,
    github_skill_count: 0,
    code_search: { repos_found: 0, retries: 0 },
    scoreDistribution: { highTrust: 0, community: 0, scores: [] },
    categorizedCount: 0,
    categoryAssignments: 0,
    wildcard_expansion_count: 0,
    cron_slot: null,
    rotation_source: 'fallback',
    discovery_path_counts: {},
    high_trust_fallback_hits: 0,
  }
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

  // (c) Build GitHub headers; (d) load candidates (two-pass preventive priority).
  const headers = await buildGitHubHeaders()
  const rows = await loadRecheckCandidates(supabase, { thresholdDays, cap })

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

  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch)
    const results = await Promise.all(slice.map((r) => processRow(r, headers, apply, supabase)))
    for (const r of results) {
      switch (r.outcome) {
        case 'cleared':
          cleared++
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
      }
    }
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
    fetch_error_rate: fetchErrorRate,
    cap_saturated: capSaturated,
    killswitch_engaged: false,
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
