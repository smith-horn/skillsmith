/**
 * SMI-5437 Wave 2: sibling re-scan helper for the recheck path.
 * SMI-5445 Wave 1: C1 — merged-score gate added to runSiblingRescan so recovery
 * is symmetric with the quarantine criterion (mergedScore >= 40 OR siblingRejectable).
 *
 * Extracted from revalidate-stale-quarantines.ts to keep that file ≤500 lines.
 * Imported by processRow (revalidate-stale-quarantines.ts) when a quarantined
 * row with a sibling finding reaches the SKILL.md-clean branch.
 *
 * Fail-closed semantics: a transient fetch error on ANY sibling returns
 * `{ status: 'unknown' }` immediately, aborting remaining fetches. The skill
 * stays quarantined and retries on the next cycle. A 404 (`{ removed: true }`)
 * is a positive removal signal — the skill can be cleared if all siblings are
 * removed or scan clean.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  enumerateSiblingTargets,
  fetchSiblingContent,
  DOC_CLASS_BASENAMES,
  mergeSiblingScans,
  type SiblingEdgeScan,
} from './skill-processor.security.ts'
import { scanSkillContent, summarizeFindings } from './_shared/security-scanner-edge.ts'
import type { EdgeScanResult, SecurityFinding } from './_shared/security-scanner-edge.ts'
import type { RateLimitTelemetry } from './_shared/rate-limit.ts'
import type { StaleQuarantinedRow } from './revalidate-stale-quarantines.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SiblingRescanStatus = 'clean' | 'malicious' | 'unknown'

export interface SiblingRescanResult {
  status: SiblingRescanStatus
  findings?: SecurityFinding[]
  siblingPath?: string
  /** SMI-5445 C1: recomputed merged risk score (root + all siblings). Present when status is 'clean' or 'malicious'. */
  mergedScore?: number
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * SMI-5437 Wave 2: Re-scan all sibling targets for a skill whose SKILL.md
 * is now clean.
 * SMI-5445 C1: Now accepts the fresh SKILL.md scan from processRow and applies
 * the collective merged-score gate (root + all siblings). A 'clean' verdict
 * requires BOTH (a) no siblingRejectable AND (b) mergedScore < QUARANTINE_THRESHOLD.
 *
 * Returns:
 *   - `{ status: 'unknown' }` if any sibling fetch fails (fail-closed; stays
 *     quarantined, retries next cycle), OR if `rootScan` was not supplied on the
 *     clear path (SMI-5445 C1-low fail-closed — a missing root scan must never
 *     yield 'clean').
 *   - `{ status: 'malicious', findings, siblingPath, mergedScore }` the MOMENT any
 *     non-doc sibling has code_execution or obfuscated_directive findings — the
 *     loop breaks immediately and remaining siblings are NOT fetched (rejectable ⇒
 *     malicious regardless of score; SMI-5437 early-abort + GitHub fetch-budget).
 *     `mergedScore` here is the PARTIAL merged score over root + the siblings
 *     fetched so far (not necessarily >= 40).
 *   - `{ status: 'malicious', findings: merged.findings, mergedScore }` if the loop
 *     completes with NO rejectable sibling but the collective merged score over
 *     root + ALL siblings is >= QUARANTINE_THRESHOLD (40) — the C1 score gate.
 *   - `{ status: 'clean', mergedScore }` if the loop completes with no rejectable
 *     sibling AND the full merged score is < QUARANTINE_THRESHOLD.
 *
 * Fetches are sequential (BUNDLED_SCAN_FILES order). A transient error on an
 * early file aborts the entire rescan — intentionally fail-closed.
 */
export async function runSiblingRescan(
  owner: string,
  repo: string,
  branch: string,
  skillPath: string,
  telemetry: RateLimitTelemetry,
  rootScan?: EdgeScanResult
): Promise<SiblingRescanResult> {
  const targets = enumerateSiblingTargets(skillPath ?? '')

  // SMI-5445 C1: accumulate every fetched sibling scan so the collective merged
  // score can include all sibling findings on the no-rejectable path (mirrors
  // mergeSiblingScans in skill-processor.security.ts).
  const fetchedSiblingScans: SiblingEdgeScan[] = []

  // SMI-5445 C1-low: fail-closed on a missing rootScan. rootScan is always passed
  // on the recheck path (processRow supplies the fresh SKILL.md scan); this is
  // defense-in-depth — a missing root scan must NOT be able to yield 'clean', or
  // the merged-score gate would silently degrade to sibling-only. Treat it as
  // 'unknown' so the row stays quarantined and retries next cycle.
  if (rootScan === undefined) {
    console.warn(
      `[recheck-sibling] rootScan missing for ${owner}/${repo} — failing closed (staying quarantined)`
    )
    return { status: 'unknown' }
  }

  for (const relPath of targets) {
    const sibResult = await fetchSiblingContent(owner, repo, branch, relPath, telemetry)

    if (sibResult === null) {
      // Transient: network error, 429, or oversized — fail-closed.
      console.warn(
        `[recheck-sibling] transient fetch error on ${relPath} for ${owner}/${repo} — staying quarantined`
      )
      return { status: 'unknown' }
    }

    if ('removed' in sibResult) {
      // 404: file confirmed absent from repo — positive removal signal.
      console.log(`[recheck-sibling] ${relPath} confirmed removed for ${owner}/${repo}`)
      continue
    }

    // Successful fetch: scan the content.
    const scan = await scanSkillContent(sibResult.content)
    fetchedSiblingScans.push({ relPath, scan })

    const basename = relPath.split('/').pop() ?? relPath
    const isDocClass = DOC_CLASS_BASENAMES.has(basename)
    const siblingRejectable =
      !isDocClass &&
      scan.findings.some((f) => f.type === 'code_execution' || f.type === 'obfuscated_directive')

    if (siblingRejectable) {
      // SMI-5437 early-abort: a rejectable sibling ⇒ malicious regardless of the
      // score, so there is no reason to scan further. Break immediately to stop
      // fetching remaining siblings (protects the GitHub fetch budget). Report the
      // PARTIAL merged score over root + siblings fetched so far.
      const merged = mergeSiblingScans(rootScan, fetchedSiblingScans)
      console.warn(`[recheck-sibling] malicious sibling ${relPath} for ${owner}/${repo}`)
      return {
        status: 'malicious',
        findings: scan.findings,
        siblingPath: relPath,
        mergedScore: merged.riskScore,
      }
    }
  }

  // SMI-5445 C1: no rejectable sibling was found — this is exactly the case C1
  // protects. Compute the collective merged score over root + ALL siblings using
  // the same mergeSiblingScans function that applied the original quarantine.
  const merged = mergeSiblingScans(rootScan, fetchedSiblingScans)

  // SMI-5445 C1: Gate (b) — collective merged score >= QUARANTINE_THRESHOLD (40).
  // merged.quarantine encodes (mergedScore >= QUARANTINE_THRESHOLD || siblingRejectable);
  // no siblingRejectable reached here, so this fires only on the score gate.
  if (merged.quarantine) {
    console.warn(
      `[recheck-sibling] merged score ${merged.riskScore} >= threshold for ${owner}/${repo} — staying quarantined`
    )
    return {
      status: 'malicious',
      findings: merged.findings,
      mergedScore: merged.riskScore,
    }
  }

  console.log(`[recheck-sibling] all siblings clean for ${owner}/${repo}`)
  return { status: 'clean', mergedScore: merged.riskScore }
}

// ---------------------------------------------------------------------------
// Quarantine reason builder
// ---------------------------------------------------------------------------

/**
 * SMI-5437 Wave 2 (C-2): Build a quarantine reason string for a recheck-triggered
 * sibling requarantine. The `[recheck-sibling]` prefix distinguishes this from the
 * initial indexer quarantine reason (produced by buildMergedQuarantineReason, which
 * has no prefix). Operators reading the `quarantine_reason` column can immediately
 * identify the trigger.
 */
export function buildSiblingQuarantineReason(
  sibRescan: SiblingRescanResult,
  owner: string,
  skillName: string
): string {
  const findings = sibRescan.findings ?? []
  const siblingPath = sibRescan.siblingPath ?? '(unknown)'
  const score = Math.min(100, findings.length * 20)
  const findingSummary = summarizeFindings(findings)
  const appealUrl = `https://www.skillsmith.app/contact?topic=quarantine&skill=${encodeURIComponent(`${owner}/${skillName}`)}`
  const n = findings.length
  return (
    `[recheck-sibling] Security scan detected ${n} finding${n === 1 ? '' : 's'} in ${siblingPath}` +
    ` (risk score: ${score}/100). ${findingSummary}. Appeal at ${appealUrl}`
  )
}

// ---------------------------------------------------------------------------
// DB write helper (sibling requarantine)
// ---------------------------------------------------------------------------

/**
 * SMI-5437 Wave 2: Write the DB update and audit row for a sibling-triggered
 * requarantine. Returns true if the update succeeded (rows affected > 0), false
 * on DB error (the caller returns 'error' in that case). Extracted from processRow
 * to keep revalidate-stale-quarantines.ts ≤500 lines.
 */
export async function writeSiblingRequarantine(
  db: SupabaseClient,
  row: StaleQuarantinedRow,
  sibRescan: SiblingRescanResult,
  sibReason: string
): Promise<'ok' | 'error' | 'no-op'> {
  const now = new Date().toISOString()
  const { data: updated, error: updateErr } = await db
    .from('skills')
    .update({
      quarantined: true,
      quarantine_reason: sibReason,
      last_scanned_at: now,
    })
    .eq('id', row.id)
    .select('id')

  if (updateErr) return 'error'
  if (!updated || updated.length === 0) return 'no-op'

  await db.from('audit_logs').insert({
    event_type: 'quarantine:requarantined',
    actor: 'system',
    resource: row.id,
    action: 'revalidate_stale_quarantines',
    result: 'success',
    metadata: {
      smi: 'SMI-5437',
      sweep: 'recheck-sibling',
      skill_id: row.id,
      author: row.author,
      name: row.name,
      repo_url: row.repo_url,
      sibling_path: sibRescan.siblingPath,
      new_reason: sibReason,
    },
  })
  return 'ok'
}

// ---------------------------------------------------------------------------
// DB write helper (sibling recovery / clear)
// ---------------------------------------------------------------------------

/**
 * SMI-5437 Wave 2 recovery mechanism + SMI-5445 forensic-persist: write the CAS
 * clear + audit row for a sibling-quarantined skill whose SKILL.md is clean and
 * whose siblings re-scan clean (runSiblingRescan → status 'clean').
 *
 * Extracted from processRow (SMI-5445) so revalidate-stale-quarantines.ts stays
 * under the 500-line gate — mirrors writeSiblingRequarantine above.
 *
 * The CAS clear guard `.eq('quarantined', true)` is load-bearing: a row
 * re-quarantined by maintenance between load and write must NOT be flipped clean.
 * Returns 'cas-skipped' when the guard no-ops (0 rows), 'error' on a DB error,
 * 'ok' on a successful clear.
 *
 * The recovery-clear EVENT is the SMI-5437 recovery mechanism, so the audit
 * `metadata.smi` stays 'SMI-5437'. The SMI-5445 additions are the NEW fields:
 *   - `merged_score` (M3): the recovery-time collective merged score.
 *   - `was_security_quarantine` (M2): distinguishes a PASS-3 sibling-recovered row
 *     (security reason) from a PASS-2 stale row.
 * M4: `security_findings` on the clear write persists the recovery-time merged
 * scan findings (from sibRescan), not `[]`, documenting WHY the row passed.
 */
export async function writeSiblingRecovery(
  db: SupabaseClient,
  row: StaleQuarantinedRow,
  sibRescan: SiblingRescanResult,
  scanRiskScore: number
): Promise<'ok' | 'error' | 'cas-skipped'> {
  const now = new Date().toISOString()

  // SMI-5445 M4: persist the recovery-time merged scan findings (root + siblings)
  // instead of []. For genuinely-clean rows this array is empty anyway; for
  // borderline rows that scraped under the threshold, the findings are retained
  // for the audit trail / forensic investigation.
  const recoveryFindings = sibRescan.findings ?? []

  // SMI-5445 M2: flag whether the row carried a security (non-stale/null) reason so
  // operators can distinguish PASS-3 sibling-recovered rows from PASS-2 stale rows.
  const wasSecurityQuarantine = row.quarantine_reason !== null && row.quarantine_reason !== 'stale'

  const { data: updated, error } = await db
    .from('skills')
    .update({
      quarantined: false,
      quarantine_reason: null,
      security_findings: recoveryFindings,
      security_score: scanRiskScore,
      last_scanned_at: now,
      last_seen_at: now,
    })
    .eq('id', row.id)
    .eq('quarantined', true)
    .select('id')

  if (error) return 'error'
  if (!updated || updated.length === 0) return 'cas-skipped'

  await db.from('audit_logs').insert({
    event_type: 'quarantine:cleared',
    actor: 'system',
    resource: row.id,
    action: 'revalidate_stale_quarantines',
    result: 'success',
    metadata: {
      // The recovery-clear event is the SMI-5437 recovery mechanism.
      smi: 'SMI-5437',
      sweep: 'recheck-sibling',
      skill_id: row.id,
      author: row.author,
      name: row.name,
      repo_url: row.repo_url,
      new_score: scanRiskScore,
      // SMI-5445 M3: recovery-time collective merged score.
      merged_score: sibRescan.mergedScore,
      prev_quarantine_reason: row.quarantine_reason,
      prev_security_findings: row.security_findings,
      // SMI-5445 M2: forensic flag — true when this was a security (non-stale) quarantine.
      was_security_quarantine: wasSecurityQuarantine,
    },
  })
  return 'ok'
}
