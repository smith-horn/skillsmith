/**
 * SMI-5445 Wave 1 (L2): Helper functions extracted from recheck.ts to keep that
 * file under the 500-line CI gate. Contains:
 *   - PASS-3 sibling-candidate loader (H1 DB-predicate path)
 *   - isSiblingFinding predicate (H4)
 *   - per-run sibling-clear cap constant (C2)
 *   - buildRecheckResult, zeroCounters, recheckAuditZeroFills (extracted for line budget)
 *
 * Do NOT fold these into revalidate-stale-quarantines.sibling.ts — different
 * responsibility (candidate loading vs sibling scanning).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { StaleQuarantinedRow } from './revalidate-stale-quarantines.ts'
import type { RecheckAuditCounters } from './indexer-audit-log.ts'

// ---------------------------------------------------------------------------
// RecheckResult (extracted type — mirrors the zero-fill shape recheck.ts returns)
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
export function buildRecheckResult(
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
export function zeroCounters(killswitchEngaged: boolean): RecheckAuditCounters {
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
    sibling_gate_skipped: 0,
    sibling_requarantined: 0,
    sibling_recovered: 0,
    fetch_error_rate: 0,
    cap_saturated: false,
    killswitch_engaged: killswitchEngaged,
    pass1_count: 0,
    pass2_count: 0,
    pass3_count: 0,
    pass3_sibling_recovered: 0,
    deferred_cap: 0,
  }
}

/**
 * Build the maintenance-style zero-fill block for writeIndexerAuditLog so a
 * recheck audit row carries the same flat keys as discovery/maintenance rows
 * (v_indexer_health / ops-report don't branch on run type).
 */
export function recheckAuditZeroFills() {
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
    rotation_source: 'fallback' as const,
    discovery_path_counts: {},
    high_trust_fallback_hits: 0,
  }
}

// ---------------------------------------------------------------------------
// pageCandidates (extracted from recheck.ts for line budget)
// ---------------------------------------------------------------------------

/** PostgREST caps a single response at 1000 rows; candidate sets are larger. */
const PAGE_SIZE = 1000

const SELECT_COLUMNS =
  'id, author, name, repo_url, skill_path, quarantine_reason, security_findings, quarantined, last_seen_at'

/**
 * Page a single PostgREST filter set, ordered by `last_seen_at` ASC, accumulating
 * up to `limit` rows. Stops when a page returns fewer than requested or `limit`
 * is filled. `pass` is folded into the error message for diagnosability.
 */
export async function pageCandidates(
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

// ---------------------------------------------------------------------------
// C2: per-run sibling-clear cap
// ---------------------------------------------------------------------------

/**
 * SMI-5445 C2: Maximum number of sibling-quarantine auto-clears per recheck run.
 * Once this many sibling-recovered rows have been cleared in a single run, further
 * PASS-3 candidates get a 'deferred-cap' outcome instead of being cleared — they
 * stay quarantined and are retried in the next run. This bounds the blast radius
 * of a mass auto-clear event (e.g. reputation laundering via evidence scrub).
 *
 * Overridable via RECHECK_MAX_SIBLING_CLEARS env (must be a positive integer).
 * Default: 25. Values outside [1, 500] are clamped to [1, 500].
 */
export function getRecheckMaxSiblingClears(): number {
  const raw = process.env.RECHECK_MAX_SIBLING_CLEARS
  if (!raw) return 25
  const parsed = Math.trunc(Number(raw))
  if (!Number.isFinite(parsed) || parsed < 1) return 1
  return Math.min(500, parsed)
}

// ---------------------------------------------------------------------------
// H4: isSiblingFinding predicate
// ---------------------------------------------------------------------------

/**
 * SMI-5445 H4: Returns true if a security finding was written by the sibling
 * scanner (has a non-null, non-empty filePath). This is the provenance guard:
 * `filePath` on a persisted security_finding is set EXCLUSIVELY by
 * `mergeSiblingScans` in skill-processor.security.ts. Hand-reviewed, advisory,
 * or SKILL.md-only quarantine findings never carry a filePath.
 *
 * Used by PASS 3 client-side validation and tests.
 */
export function isSiblingFinding(f: unknown): boolean {
  if (f === null || typeof f !== 'object') return false
  const fp = (f as Record<string, unknown>).filePath
  return fp !== null && fp !== undefined && fp !== ''
}

/**
 * SMI-5445 C2-low: the single canonical predicate for "this row is a PASS-3
 * sibling-quarantine". A sibling-quarantine row is `quarantined === true`, carries a
 * non-null/non-stale (i.e. security) reason, AND has at least one security_finding
 * with a filePath (the provenance guard — set exclusively by mergeSiblingScans).
 *
 * BOTH the pass3_count inference (from the merged candidate list) and the
 * pass3_sibling_recovered sub-counter (from a processRow result row) key on THIS
 * predicate, so the two counters can never diverge (they used to: the recovered
 * sub-counter omitted the filePath-finding check, over-counting security rows with
 * no sibling finding).
 */
export function isSiblingQuarantineRow(row: StaleQuarantinedRow): boolean {
  return (
    row.quarantined === true &&
    row.quarantine_reason !== null &&
    row.quarantine_reason !== 'stale' &&
    Array.isArray(row.security_findings) &&
    (row.security_findings as unknown[]).some(isSiblingFinding)
  )
}

// ---------------------------------------------------------------------------
// H1: PASS-3 sibling-candidate loader (DB-predicate via RPC)
// ---------------------------------------------------------------------------

/**
 * SMI-5445 PASS 3 (H1): Load sibling-quarantined candidates via the DB-side
 * predicate RPC `get_recheck_sibling_candidates(cutoff, lim)`. This avoids the
 * starvation-correctness bug of the naive in-code post-filter: with a DB-side
 * predicate, `pageCandidates` only ever returns true sibling rows, so the cap
 * is fully consumed by the intended cohort.
 *
 * The RPC signature: `get_recheck_sibling_candidates(cutoff timestamptz, lim int)
 * RETURNS SETOF skills` — filters `quarantined AND last_seen_at < cutoff AND
 * repo_url ILIKE 'https://github.com/%' AND jsonb_path_exists(security_findings,
 * '$[*].filePath ? (@ != null && @ != "")')` ORDER BY last_seen_at ASC LIMIT lim.
 *
 * Maps returned skills rows to StaleQuarantinedRow shape (the RPC returns the
 * same columns as SELECT_COLUMNS in recheck.ts).
 *
 * @param db - Supabase admin client
 * @param cutoff - ISO 8601 timestamp; rows older than this are candidates
 * @param limit - max rows to return (leftover cap from PASS 1 + PASS 2)
 * @returns array of StaleQuarantinedRow, may be empty
 * @throws if the RPC call itself errors (caller wraps in try/catch)
 */
export async function loadPass3Candidates(
  db: SupabaseClient,
  cutoff: string,
  limit: number
): Promise<StaleQuarantinedRow[]> {
  if (limit <= 0) return []
  const { data, error } = await db.rpc('get_recheck_sibling_candidates', {
    cutoff,
    lim: limit,
  })
  if (error) {
    throw new Error(`Failed to load PASS 3 sibling candidates (RPC): ${error.message}`)
  }
  return (data ?? []) as unknown as StaleQuarantinedRow[]
}
