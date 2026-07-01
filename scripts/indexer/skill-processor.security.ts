/**
 * Security helpers for the Node indexer skill-processor (SMI-5436 Wave 0+2).
 *
 * Wave 0: extracted buildQuarantineReason + readResponseWithLimit from
 * skill-processor.ts to keep that file ≤500 lines.
 * Wave 2: adds sibling-scan plumbing — enumerateSiblingTargets,
 * fetchSiblingContent, mergeSiblingScans, buildMergedQuarantineReason.
 *
 * Parity with supabase/functions/indexer/skill-processor.security.ts is
 * enforced by parity.test.ts.
 */

import {
  QUARANTINE_THRESHOLD,
  shouldQuarantine,
  summarizeFindings,
  type EdgeScanResult,
  type SecurityFinding,
} from './_shared/security-scanner-edge.ts'
import { calculateRiskScore } from './_shared/security-scanner-edge.context.ts'
import { withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'

// sync: packages/core/src/services/skill-installation.policy.ts BUNDLED_SCAN_FILES
export const BUNDLED_SCAN_FILES = [
  'README.md',
  'examples.md',
  'config.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
  'package.json',
] as const

export type BundledScanFile = (typeof BUNDLED_SCAN_FILES)[number]

/**
 * SMI-2384: Build a human-readable quarantine reason for authors.
 *
 * When a skill is quarantined, this produces a message summarizing:
 * - Number of findings and risk score
 * - Types of patterns found with line numbers (max 5)
 * - Appeal URL with the skill identifier pre-filled
 */
export function buildQuarantineReason(
  scanResult: EdgeScanResult,
  owner: string,
  name: string
): string {
  if (!shouldQuarantine(scanResult)) {
    return ''
  }

  const findingSummary = summarizeFindings(scanResult.findings)
  const appealUrl = `https://www.skillsmith.app/contact?topic=quarantine&skill=${encodeURIComponent(`${owner}/${name}`)}`

  return `Security scan detected ${scanResult.findings.length} finding${scanResult.findings.length === 1 ? '' : 's'} (risk score: ${scanResult.riskScore}/100). ${findingSummary}. Appeal at ${appealUrl}`
}

/**
 * SMI-2283: Read response body with byte-counted limit to prevent memory exhaustion.
 * Streams the body and aborts if the accumulated size exceeds the limit.
 * @throws Error if response body exceeds maxBytes
 */
export async function readResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is not readable')
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        reader.cancel()
        throw new Error(`Response body exceeds maximum size of ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const decoder = new TextDecoder()
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}

// =============================================================================
// SMI-5436 Wave 2: Sibling-scan plumbing
// =============================================================================

/** Max CDN fetches per skill (latency cap, not a rate-budget guard — CDN costs zero core quota). */
export const MAX_SIBLING_BLOB_FETCHES_PER_SKILL = BUNDLED_SCAN_FILES.length

/** Max content bytes per sibling (same as MAX_SKILL_CONTENT_SIZE). */
export const MAX_SIBLING_CONTENT_BYTES = 256_000

/** Files that are doc-class: we scan them but do NOT reject on findings (consistent with Phase 2 B1). */
export const DOC_CLASS_BASENAMES = new Set(['README.md', 'examples.md'])

export interface SiblingEdgeScan {
  relPath: string
  scan: EdgeScanResult
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
 * Rejection criterion for siblings: code_execution or obfuscated_directive only
 * (not full shouldQuarantine) — consistent with Phase 2 B1. Benign idioms like
 * `chmod 755 ./bin/cli` fire privilege_escalation:critical in non-doc context,
 * so we restrict to the explicit exec/obfuscation categories. Doc-class files
 * (README.md, examples.md) are scanned but never trigger sibling rejection.
 */
export function mergeSiblingScans(
  root: EdgeScanResult,
  siblings: SiblingEdgeScan[]
): MergedEdgeScanResult {
  const siblingFindings = siblings.flatMap(({ relPath, scan }) =>
    scan.findings.map((f) => ({ ...f, filePath: relPath }))
  )
  const allFindings = [...root.findings, ...siblingFindings]
  const mergedScore = calculateRiskScore(allFindings)

  const rejectableSibling = siblings.find(({ relPath, scan }) => {
    const basename = relPath.split('/').pop() ?? relPath
    return (
      !DOC_CLASS_BASENAMES.has(basename) &&
      scan.findings.some((f) => f.type === 'code_execution' || f.type === 'obfuscated_directive')
    )
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
