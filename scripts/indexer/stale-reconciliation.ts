/**
 * Stale skill verification and quarantine (Node port)
 * @module scripts/indexer/stale-reconciliation
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/stale-reconciliation.ts`.
 * Behaviorally aligned with the Deno twin apart from the npm import, relative
 * `_shared` paths, and `process.env` vs `Deno.env` reads.
 *
 * SMI-2379: Originally marked skills not seen for N consecutive days as
 * stale-quarantined. SMI-5551 replaced that direct destructive write with
 * VERIFICATION-BASED quarantine: an expired `last_seen_at` heartbeat is a
 * *validation candidate*, not proof of death — the registry's re-sighting
 * mechanisms (discovery topic rotation, refresh-metadata) cannot cover the
 * full ~345k corpus inside the staleness window, so "not rediscovered
 * recently" routinely describes live skills (4th recurrence: SMI-3540,
 * SMI-4200/4202/4203, SMI-5279/5280/5281, SMI-5551 — +12,223 false
 * quarantines in one week).
 *
 * Each candidate past the threshold is now verified DIRECTLY against its
 * stored `repo_url` (same fetch/scan pattern as recheck.ts /
 * revalidate-stale-quarantines.ts):
 *   - genuinely-terminal outcome (unparseable URL, repo/SKILL.md 404) →
 *     quarantine with FINDING_STALE/'stale', same as before;
 *   - transient fetch error (rate limit, 5xx, network) → row left untouched,
 *     retried next cycle — NEVER quarantined;
 *   - live + clean scan → `last_seen_at` refreshed (heartbeat repaired);
 *   - live + malicious scan → quarantined with the REAL finding, not 'stale'.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { quarantineSkillsBatch, FINDING_STALE } from './_shared/quarantine.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { parseSkillMdUrl, fetchSkillMd } from './_shared/skill-md-fetch.ts'
import {
  scanSkillContent,
  shouldQuarantine,
  summarizeFindings,
} from './_shared/security-scanner-edge.ts'

// ---------------------------------------------------------------------------
// Canonical stale-threshold policy (SMI-5551 item 3)
// ---------------------------------------------------------------------------

/** Default threshold for the once-daily maintenance sweep (SMI-4203 production value). */
export const MAINTENANCE_STALE_DEFAULT_DAYS = 7

/** Default threshold for discovery's phase-3 finalize sweep (3x/day). */
export const DISCOVERY_STALE_DEFAULT_DAYS = 30

/**
 * Canonical stale-threshold resolver — the ONE place threshold policy lives
 * (SMI-5551 item 3). Both consumers of the stale sweep route through this:
 *
 *   - maintenance (`maintenance-helpers.ts` `resolveMaintenanceStaleThreshold`)
 *     passes `MAINTENANCE_STALE_DEFAULT_DAYS` (7);
 *   - discovery phase 3 (`discovery-orchestrator.phase-split.ts`
 *     `runStaleReconciliationPhase`) passes `DISCOVERY_STALE_DEFAULT_DAYS` (30).
 *
 * Any positive finite numeric override is honored; everything else (missing,
 * NaN, Infinity, zero/negative, non-number) falls back to the caller's
 * default. Note: discovery's previous inline resolution accepted Infinity and
 * non-positive numbers and relied on `reconcileStaleSkills`' downstream 1-90
 * clamp; unifying on the stricter validation means such garbage now resolves
 * to the caller default instead of clamping to an extreme (a negative value
 * clamping to a 1-day threshold would have quarantined nearly everything).
 */
export function resolveStaleThresholdDays(raw: unknown, defaultDays: number): number {
  if (typeof raw === 'number' && !isNaN(raw) && isFinite(raw) && raw > 0) {
    return raw
  }
  return defaultDays
}

// ---------------------------------------------------------------------------
// Incident brake (SMI-5551 item 1)
// ---------------------------------------------------------------------------

/**
 * SMI-5551 item 1: incident brake. When set (`1`/`true`, case-insensitive),
 * `reconcileStaleSkills()` short-circuits before ANY query or write — no
 * candidate load, no verification fetches, no quarantine. Registered in
 * docs/internal/process/guards-and-opt-outs.md. Unprefixed name follows the
 * indexer/edge-function env convention (`RECHECK_ENABLED`, `STALE_DAYS`,
 * `SCAN_COVERAGE_ALERT_DISABLE`).
 */
export const STALE_QUARANTINE_DISABLE_ENV = 'STALE_QUARANTINE_DISABLE'

/** True when the incident brake is engaged (Node reads `process.env`). */
function staleQuarantineDisabled(): boolean {
  const raw = process.env[STALE_QUARANTINE_DISABLE_ENV]
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of stale reconciliation.
 */
export interface StaleReconciliationResult {
  /** Skills quarantined with reason 'stale' (directly-verified dead: unparseable URL or 404). */
  staleQuarantined: number
  // SMI-3347: IDs of quarantined skills for bulk-quarantine author notification.
  // SMI-5551: includes BOTH confirmed-dead ('stale') and malicious quarantines.
  quarantinedIds: string[]
  errors: string[]
  /** SMI-5551: candidates whose repo fetched live + clean — heartbeat refreshed, NOT quarantined. */
  verifiedLive: number
  /** SMI-5551: candidates skipped on a transient fetch error — untouched, retried next cycle. */
  transientSkipped: number
  /** SMI-5551: candidates whose live SKILL.md failed the scanner — quarantined with the real finding. */
  maliciousQuarantined: number
}

/** A live `skills` row past the stale threshold, narrowed to verification columns. */
export interface StaleCandidateRow {
  id: string
  author: string | null
  name: string
  repo_url: string | null
  skill_path: string | null
  last_seen_at: string | null
}

/** Per-candidate outcome of direct verification. */
export type StaleVerifyOutcome =
  | 'confirmed-dead' // unparseable repo_url or SKILL.md 404 → quarantine 'stale'
  | 'transient' // rate limit / 5xx / network — row untouched, retried next cycle
  | 'live-refreshed' // live + clean scan → last_seen_at refreshed
  | 'malicious-quarantined' // live but scanner fails → quarantined with real finding
  | 'cas-skipped' // live-touch CAS lost (row quarantined/removed concurrently)
  | 'error' // DB write failed — row left as-is, counted in errors

// ---------------------------------------------------------------------------
// Per-candidate verification (SMI-5551 item 2)
// ---------------------------------------------------------------------------

/**
 * Verify a single stale candidate directly against its stored `repo_url`
 * and reconcile the row per the outcome. Mirrors the decision tree of
 * `revalidate-stale-quarantines.ts` `processRow` for the live cohort:
 * parse → fetch SKILL.md → scan → branch.
 *
 * Writes performed here:
 *  - malicious: quarantine with the real finding (match by id, fail-closed —
 *    the demanded end-state is quarantined regardless of concurrent writers);
 *  - live + clean: CAS heartbeat refresh (`.eq('quarantined', false)` guards
 *    against a row quarantined between load and write), also persisting
 *    `content_hash`/`security_score`/`last_scanned_at` like the
 *    revalidate-stale-quarantines live-touch branch (SMI-5849/SMI-5866).
 *
 * 'confirmed-dead' performs NO write — the caller batches those through
 * `quarantineSkillsBatch(..., FINDING_STALE, 'stale')` exactly as before.
 * A transient fetch error NEVER results in a write (see skill-md-fetch.ts:
 * a rate-limit blip must not feed a live skill into destructive quarantine).
 */
export async function verifyAndReconcileStaleSkill(
  supabase: SupabaseClient,
  row: StaleCandidateRow,
  headers: Record<string, string>
): Promise<StaleVerifyOutcome> {
  // Step 1: parse the repo URL into a GitHub Contents API URL.
  const parsed = parseSkillMdUrl(row.repo_url, row.skill_path)
  if (!parsed) return 'confirmed-dead'

  // Step 2: fetch SKILL.md directly from GitHub.
  const fetched = await fetchSkillMd(parsed, headers)
  if (fetched.kind === 'transient') return 'transient'
  if (fetched.kind === 'not-found') return 'confirmed-dead'

  // Step 3: scan the live content.
  const scan = await scanSkillContent(fetched.content)
  const now = new Date().toISOString()

  if (shouldQuarantine(scan)) {
    // Live repo, malicious content: quarantine with the REAL finding, not
    // 'stale'. Match by id only + set quarantined:true explicitly —
    // fail-closed (mirrors processRow's SMI-5377 requarantine branch).
    const summary = summarizeFindings(scan.findings) || 'security scan'
    const { error: updateErr } = await supabase
      .from('skills')
      .update({
        quarantined: true,
        quarantine_reason: summary,
        security_score: scan.riskScore,
        security_findings: scan.findings,
        last_scanned_at: now,
        content_hash: scan.contentHash,
      })
      .eq('id', row.id)
      .select('id')
    if (updateErr) {
      console.error(
        `[StaleDetection] ERROR quarantining malicious ${row.author ?? '?'}/${row.name}: ${updateErr.message}`
      )
      return 'error'
    }
    return 'malicious-quarantined'
  }

  // Live + clean: refresh the heartbeat. CAS on quarantined=false so a row
  // quarantined by a concurrent writer between load and write is left alone.
  const { data: touched, error: touchErr } = await supabase
    .from('skills')
    .update({
      last_seen_at: now,
      content_hash: scan.contentHash,
      security_score: scan.riskScore,
      last_scanned_at: now,
    })
    .eq('id', row.id)
    .eq('quarantined', false)
    .select('id')
  if (touchErr) {
    console.error(
      `[StaleDetection] ERROR touching ${row.author ?? '?'}/${row.name}: ${touchErr.message}`
    )
    return 'error'
  }
  if (!touched || touched.length === 0) return 'cas-skipped'
  return 'live-refreshed'
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** Small concurrency to stay polite to the GitHub API (mirrors revalidate-stale-quarantines.ts). */
const VERIFY_BATCH = 5

/**
 * Reconcile stale skills: verify every candidate past the threshold directly
 * against its stored `repo_url`, quarantining ONLY directly-verified terminal
 * outcomes (SMI-5551 item 2 — an expired heartbeat alone never quarantines).
 *
 * @param supabase - Supabase admin client
 * @param staleThresholdDays - Days without sighting before verification (1-90)
 */
export async function reconcileStaleSkills(
  supabase: SupabaseClient,
  staleThresholdDays: number
): Promise<StaleReconciliationResult> {
  const result: StaleReconciliationResult = {
    staleQuarantined: 0,
    quarantinedIds: [],
    errors: [],
    verifiedLive: 0,
    transientSkipped: 0,
    maliciousQuarantined: 0,
  }

  // SMI-5551 item 1: incident brake — short-circuit before ANY query or write.
  if (staleQuarantineDisabled()) {
    console.warn(
      `[StaleDetection] ${STALE_QUARANTINE_DISABLE_ENV} is set — destructive stale quarantine is disabled; skipping sweep entirely`
    )
    return result
  }

  // SMI-2572: Defense-in-depth — guard against NaN from non-numeric input
  const safeDays =
    typeof staleThresholdDays === 'number' && !isNaN(staleThresholdDays) ? staleThresholdDays : 30
  const clampedDays = Math.max(1, Math.min(safeDays, 90))
  const staleThreshold = new Date()
  staleThreshold.setDate(staleThreshold.getDate() - clampedDays)

  const STALE_BATCH_LIMIT = 500
  const { data: staleSkills, error: staleError } = await supabase
    .from('skills')
    .select('id, author, name, repo_url, skill_path, last_seen_at')
    .lt('last_seen_at', staleThreshold.toISOString())
    .eq('quarantined', false)
    .order('last_seen_at', { ascending: true })
    .limit(STALE_BATCH_LIMIT)

  if (staleError) {
    console.error('[StaleDetection] Failed to query stale skills:', staleError.message)
    return result
  }

  if (!staleSkills || staleSkills.length === 0) {
    console.log('[StaleDetection] No stale skills found')
    return result
  }

  console.log(
    `[StaleDetection] Found ${staleSkills.length} stale candidates (not seen in ${clampedDays}+ days) — verifying directly`
  )

  let headers: Record<string, string>
  try {
    headers = await buildGitHubHeaders()
  } catch (err) {
    // Fail-safe: without verification capability, do NOT quarantine anything.
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`Failed to build GitHub headers — verification sweep skipped: ${msg}`)
    return result
  }

  const rows = staleSkills as StaleCandidateRow[]
  const confirmedDeadIds: string[] = []
  const maliciousIds: string[] = []
  let errorRows = 0

  for (let i = 0; i < rows.length; i += VERIFY_BATCH) {
    const batch = rows.slice(i, i + VERIFY_BATCH)
    const outcomes = await Promise.all(
      batch.map(async (row) => ({
        row,
        outcome: await verifyAndReconcileStaleSkill(supabase, row, headers),
      }))
    )
    for (const { row, outcome } of outcomes) {
      switch (outcome) {
        case 'confirmed-dead':
          confirmedDeadIds.push(row.id)
          break
        case 'transient':
          result.transientSkipped++
          break
        case 'live-refreshed':
          result.verifiedLive++
          break
        case 'malicious-quarantined':
          result.maliciousQuarantined++
          maliciousIds.push(row.id)
          break
        case 'cas-skipped':
          // Row was quarantined/removed by a concurrent writer — nothing to do.
          break
        case 'error':
          errorRows++
          break
      }
    }
  }

  if (errorRows > 0) {
    result.errors.push(`Stale verification had ${errorRows} row write failures`)
  }

  // Quarantine ONLY the directly-verified dead rows, with the same shared
  // batch helper + 'stale' reason as before (RPC + fallback).
  // SMI-4431: pass 'stale' so quarantine_reason is recorded on every
  // stale-quarantined skill.
  if (confirmedDeadIds.length > 0) {
    const { quarantined, errors: batchErrors } = await quarantineSkillsBatch(
      supabase,
      confirmedDeadIds,
      FINDING_STALE,
      'stale'
    )
    if (batchErrors > 0) {
      result.errors.push(`Stale skill quarantine had ${batchErrors} batch failures`)
    }
    result.staleQuarantined = quarantined
    // SMI-3347: Store quarantined IDs for bulk-quarantine notification
    result.quarantinedIds = confirmedDeadIds.slice(0, quarantined)
  }

  // Malicious quarantines already wrote row-by-row; include them in the
  // notification set (their authors should hear about it too).
  result.quarantinedIds.push(...maliciousIds)

  console.log(
    `[StaleDetection] Verified ${rows.length} candidates: ` +
      `${result.staleQuarantined} confirmed-dead quarantined, ` +
      `${result.maliciousQuarantined} malicious-quarantined, ` +
      `${result.verifiedLive} live-refreshed, ` +
      `${result.transientSkipped} transient-skipped (${result.errors.length} errors)`
  )

  return result
}
