/**
 * Sibling-scan plumbing for the Node indexer skill-processor, extracted
 * from skill-processor.security.ts (SMI-5436 Wave 2).
 * @module scripts/indexer/skill-processor.security.sibling
 *
 * SMI-6033 Wave 2 (Gap 8) adversarial-review fix (2026-08-16): the new
 * `isExtended` rejection-gating logic pushed `skill-processor.security.ts`
 * to 534/500 lines. This section — `enumerateSiblingTargets`,
 * `fetchSiblingContent`, `mergeSiblingScans`, `buildMergedQuarantineReason`,
 * and their supporting types/constants — moved here verbatim (behavior
 * unchanged), the same small-sibling extraction precedent as
 * `skill-processor.security.tree.ts`. Re-exported from
 * `skill-processor.security.ts` so the public API is unchanged for every
 * existing caller.
 *
 * `BUNDLED_SCAN_FILES` is imported back from `skill-processor.security.ts`
 * — a circular import, but a safe one: it's a plain top-level array literal
 * only ever READ inside a function body here (`enumerateSiblingTargets`),
 * never at this module's own top-level, so ESM's live-binding semantics
 * resolve it correctly regardless of which module finishes initializing
 * first. Parity with the Deno twin (`supabase/functions/indexer/
 * skill-processor.security.sibling.ts`) is enforced by parity.test.ts.
 */

import {
  QUARANTINE_THRESHOLD,
  summarizeFindings,
  type EdgeScanResult,
  type SecurityFinding,
} from './_shared/security-scanner-edge.ts'
import { calculateRiskScore } from './_shared/security-scanner-edge.context.ts'
import { withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { BUNDLED_SCAN_FILES, readResponseWithLimit } from './skill-processor.security.ts'

/** Max content bytes per sibling (same as MAX_SKILL_CONTENT_SIZE). */
export const MAX_SIBLING_CONTENT_BYTES = 256_000

/** Files that are doc-class: we scan them but do NOT reject on findings (consistent with Phase 2 B1). */
export const DOC_CLASS_BASENAMES = new Set(['README.md', 'examples.md'])

export interface SiblingEdgeScan {
  relPath: string
  scan: EdgeScanResult
  /**
   * SMI-6033 Wave 2 (Gap 8) fix: true for a sibling drawn from the NEW
   * extended (`scripts/`/`src/`/`bin/`/top-level operational-code) scan
   * surface, false/omitted for one of the original 7 `BUNDLED_SCAN_FILES`.
   * `mergeSiblingScans` uses this to apply a narrower rejection rule to
   * extended siblings only — see its own header for why.
   */
  isExtended?: boolean
}

export interface MergedEdgeScanResult {
  findings: SecurityFinding[]
  riskScore: number
  /** True if the merged scan triggers the quarantine gate. */
  quarantine: boolean
  /** True if a non-doc sibling has code_execution or obfuscated_directive findings. */
  siblingRejectable: boolean
  /** Relative path of the first non-doc sibling that triggered rejection, or null. */
  primarySiblingPath: string | null
}

/**
 * Return the sibling paths to fetch for a given skill directory.
 * Each entry is a repo-relative path (e.g. "my-skill/.mcp.json" or ".mcp.json" for root skills).
 */
export function enumerateSiblingTargets(skillDir: string): readonly string[] {
  const prefix = skillDir ? `${skillDir}/` : ''
  return BUNDLED_SCAN_FILES.map((f) => `${prefix}${f}`)
}

/**
 * SMI-5437 Wave 1: Discriminated return type for fetchSiblingContent.
 * Distinguishes confirmed removal (404) from transient failures (429 / network error / oversized).
 * The recheck unquarantine path requires this distinction: 404 is a positive removal signal,
 * while a network error must not release a quarantine (fail-closed).
 */
export type FetchSiblingResult = { content: string } | { removed: true } | null

/**
 * SMI-5436 Wave 2: Fetch a sibling file via raw.githubusercontent.com CDN (zero core quota).
 * SMI-5437 Wave 1: Returns a discriminated result (FetchSiblingResult) to distinguish
 * confirmed removal (404) from transient failures (429 / network error / oversized).
 *
 * Returns:
 *   - `{ content: string }` — successful fetch
 *   - `{ removed: true }` — HTTP 404 (file confirmed absent; positive signal for recheck path)
 *   - `null` — HTTP 429, oversized, or network error (unknown state; fail-open / fail-closed
 *     semantics differ by caller: quarantine path is fail-open, unquarantine path is fail-closed)
 */
export async function fetchSiblingContent(
  owner: string,
  repo: string,
  branch: string,
  relPath: string,
  telemetry: RateLimitTelemetry
): Promise<FetchSiblingResult> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${relPath}`
  try {
    const response = await withRateLimitTracking(telemetry, url, {
      headers: await buildGitHubHeaders(),
      _throwOnRateLimit: false,
    })
    // 429 = transient; silently skip (same as validateSkillMd transient handling)
    if (response.status === 429) return null
    // 404 = file confirmed absent from repo (positive removal signal for recheck path)
    if (response.status === 404) return { removed: true }
    if (!response.ok) return null
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > MAX_SIBLING_CONTENT_BYTES) return null
    const text = await readResponseWithLimit(response, MAX_SIBLING_CONTENT_BYTES)
    return { content: text }
  } catch {
    return null
  }
}

/**
 * SMI-5436 Wave 2: Merge SKILL.md scan with sibling scans.
 *
 * Rejection criterion for the original 7 `BUNDLED_SCAN_FILES` siblings:
 * code_execution or obfuscated_directive at ANY severity (not full
 * shouldQuarantine) — consistent with Phase 2 B1. Benign idioms like
 * `chmod 755 ./bin/cli` fire privilege_escalation:critical in non-doc context,
 * so we restrict to the explicit exec/obfuscation categories. Doc-class files
 * (README.md, examples.md) are scanned but never trigger sibling rejection.
 * UNCHANGED by SMI-6033 Wave 2 — see the plan's own "Rejection criterion
 * unchanged" requirement.
 *
 * SMI-6033 Wave 2 (Gap 8) fix (adversarial review finding, 2026-08-16):
 * that same type-only rule is NOT safe to apply unchanged to the new
 * extended (`isExtended: true`) siblings. The original 7 files are
 * config/doc formats where a literal `curl | bash` string is inherently
 * anomalous; the extended surface includes actual shell/install scripts,
 * where `curl | bash` is the industry-standard installer idiom (rustup,
 * Homebrew, nvm, bun...) — exactly the case the plan's own Reconciliation
 * table (`docs/internal/implementation/smi-6033-clawhavoc-scanner-gaps.md`
 * §9) says must NEVER standalone-quarantine ("curl | bash alone — co-signal
 * required, keep at medium alone — no change"). `scanCodeExecution` emits
 * `code_execution` at `medium` by design for exactly this pattern; only the
 * existing co-signal escalation model (Waves 1/3/4) upgrades it to
 * `critical` when a REAL additional signal (chmod-on-fetched-file, sensitive
 * path access, decoy misdirection, etc.) is present nearby. So: for an
 * extended sibling, `code_execution` only drives rejection at `critical`
 * severity (i.e. only once the existing escalation machinery has already
 * decided this instance is not a bare installer); `obfuscated_directive`
 * remains rejectable at any severity on extended siblings too — it is
 * delta-gated against a real decode step and has no legitimate-installer
 * false-positive shape (confirmed by adversarial review).
 *
 * SMI-6033 Wave 1 (Gap 7): `extraFindings` folds in typosquat findings (or
 * any other skill-level, non-sibling-scoped findings) using the exact same
 * allFindings + calculateRiskScore merge as sibling findings. Optional and
 * additive — omitted, this is byte-identical to the pre-SMI-6033 behavior.
 */
export function mergeSiblingScans(
  root: EdgeScanResult,
  siblings: SiblingEdgeScan[],
  extraFindings: SecurityFinding[] = []
): MergedEdgeScanResult {
  const siblingFindings = siblings.flatMap(({ relPath, scan }) =>
    scan.findings.map((f) => ({ ...f, filePath: relPath }))
  )
  const allFindings = [...root.findings, ...siblingFindings, ...extraFindings]
  const mergedScore = calculateRiskScore(allFindings)

  const rejectableSibling = siblings.find(({ relPath, scan, isExtended }) => {
    const basename = relPath.split('/').pop() ?? relPath
    if (DOC_CLASS_BASENAMES.has(basename)) return false
    return scan.findings.some((f) => {
      if (f.type === 'obfuscated_directive') return true
      if (f.type !== 'code_execution') return false
      // Extended (Gap 8) siblings: a bare medium code_execution (e.g. a
      // legitimate curl|bash installer) must NOT standalone-reject — only a
      // co-signal-escalated critical finding does. Original 7 fixed
      // siblings: unchanged, any severity rejects (as before this wave).
      return isExtended ? f.severity === 'critical' : true
    })
  })

  const siblingRejectable = rejectableSibling !== undefined

  return {
    findings: allFindings,
    riskScore: mergedScore,
    quarantine: mergedScore >= QUARANTINE_THRESHOLD || siblingRejectable,
    siblingRejectable,
    primarySiblingPath: rejectableSibling?.relPath ?? null,
  }
}

/**
 * SMI-5436 Wave 2: Build quarantine reason for merged (SKILL.md + sibling) scans.
 *
 * When the primary trigger is a sibling file, the reason names it so authors
 * can identify which file triggered the quarantine.
 */
export function buildMergedQuarantineReason(
  merged: MergedEdgeScanResult,
  owner: string,
  name: string
): string {
  if (!merged.quarantine) return ''

  const locationStr = merged.primarySiblingPath ? ` in ${merged.primarySiblingPath}` : ''
  const findingSummary = summarizeFindings(merged.findings)
  const appealUrl = `https://www.skillsmith.app/contact?topic=quarantine&skill=${encodeURIComponent(`${owner}/${name}`)}`

  return `Security scan detected ${merged.findings.length} finding${merged.findings.length === 1 ? '' : 's'}${locationStr} (risk score: ${merged.riskScore}/100). ${findingSummary}. Appeal at ${appealUrl}`
}
