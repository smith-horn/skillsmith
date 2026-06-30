/**
 * SMI-5437 Wave 2: sibling re-scan helper for the recheck path.
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
} from './skill-processor.security.ts'
import { scanSkillContent, summarizeFindings } from './_shared/security-scanner-edge.ts'
import type { SecurityFinding } from './_shared/security-scanner-edge.context.ts'
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
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * SMI-5437 Wave 2: Re-scan all sibling targets for a skill whose SKILL.md
 * is now clean. Returns:
 *   - `{ status: 'unknown' }` if any sibling fetch fails (fail-closed; stays
 *     quarantined, retries next cycle).
 *   - `{ status: 'malicious', findings, siblingPath }` if any non-doc sibling
 *     has code_execution or obfuscated_directive findings.
 *   - `{ status: 'clean' }` if all siblings are removed or scan clean.
 *
 * Fetches are sequential (BUNDLED_SCAN_FILES order). A transient error on an
 * early file aborts the entire rescan — intentionally fail-closed.
 */
export async function runSiblingRescan(
  owner: string,
  repo: string,
  branch: string,
  skillPath: string,
  telemetry: RateLimitTelemetry
): Promise<SiblingRescanResult> {
  const targets = enumerateSiblingTargets(skillPath ?? '')

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
    const basename = relPath.split('/').pop() ?? relPath
    const isDocClass = DOC_CLASS_BASENAMES.has(basename)
    const siblingRejectable =
      !isDocClass &&
      scan.findings.some((f) => f.type === 'code_execution' || f.type === 'obfuscated_directive')

    if (siblingRejectable) {
      console.warn(`[recheck-sibling] malicious sibling ${relPath} for ${owner}/${repo}`)
      return { status: 'malicious', findings: scan.findings, siblingPath: relPath }
    }
  }

  console.log(`[recheck-sibling] all siblings clean for ${owner}/${repo}`)
  return { status: 'clean' }
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
