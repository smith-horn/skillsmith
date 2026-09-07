/**
 * Quarantine-decision + summary helpers for the Node edge scanner twin.
 * @module scripts/indexer/_shared/security-scanner-edge.quarantine
 *
 * Extracted from security-scanner-edge.ts (SMI-6020's multilineTruncated
 * enforcement pushed it over the 500-line gate) -- same small-sibling
 * extraction precedent as .exec.ts/.compound.ts/.patterns.ts. Re-exported
 * from security-scanner-edge.ts so the public API is unchanged for every
 * existing import site. Byte-identical body across both _shared twins
 * (parity test), aside from this header and the import specifiers below.
 */

import type { EdgeScanResult } from './security-scanner-edge.ts'
import type { SecurityFinding } from './security-scanner-edge.context.ts'
import { classifyEvidence } from './security-scanner-edge.evidence.ts'
import { safeRegexTest } from './security-scanner-edge.regex-utils.ts'
import { JAILBREAK_PATTERNS } from './security-scanner-edge.patterns.ts'
import { QUARANTINE_THRESHOLD } from './security-scanner-edge.ts'

/**
 * SMI-5879 (design §5): quickSecurityCheck is a fast pre-filter, not the full
 * scan — a bare mention-tier match (a documentation page discussing
 * "jailbreak" or "DAN") should not by itself fail the quick path. Derived
 * ONCE at module load, not hand-maintained, so it can never silently drift
 * from JAILBREAK_PATTERNS' own evidence-tier classification.
 */
export const DIRECTIVE_JAILBREAK_PATTERNS: readonly RegExp[] = JAILBREAK_PATTERNS.filter(
  (p) => classifyEvidence(p) !== 'mention'
)

/**
 * Quick check for critical patterns only (fast path)
 * Use this for quick rejection before full scan
 *
 * SMI-2391: Split content into lines before testing. Previously passed entire
 * content as a single string to safeRegexTest, which truncates at MAX_LINE_LENGTH
 * (10KB). Content after 10KB was never scanned, allowing jailbreak patterns
 * placed after that offset to bypass detection.
 *
 * SMI-5879 (design §5): tests only the directive-tier derived subset (a bare
 * mention like "jailbreak" or "DAN" alone should not fail the quick path —
 * see DIRECTIVE_JAILBREAK_PATTERNS above).
 *
 * @param content - Content to check
 * @returns true if content appears safe, false if critical pattern found
 */
export function quickSecurityCheck(content: string): boolean {
  const lines = content.split('\n')
  for (const line of lines) {
    for (const pattern of DIRECTIVE_JAILBREAK_PATTERNS) {
      if (safeRegexTest(pattern, line)) {
        return false
      }
    }
  }
  return true
}

/**
 * Check if a skill should be quarantined based on scan result
 *
 * SMI-4960: quarantine is purely score-driven — riskScore >= QUARANTINE_THRESHOLD
 * (40). This is the single prod quarantine gate; it does not consult `passed`.
 */
export function shouldQuarantine(scanResult: EdgeScanResult): boolean {
  return scanResult.riskScore >= QUARANTINE_THRESHOLD
}

/** SMI-6020 (design §3.3.6): the scan hit MAX_MULTILINE_ITERATIONS_PER_PATTERN,
 *  so riskScore is a known under-count. Absent/undefined == not truncated. */
export function isScanTruncated(scan: Pick<EdgeScanResult, 'multilineTruncated'>): boolean {
  return scan.multilineTruncated === true
}

/** SMI-6020 (design §3.3.6): the quarantine gate hardened for scan integrity.
 *  EVERY write path must call this; `shouldQuarantine` remains the pure score
 *  predicate pinned by SMI-5358 and must not be called from a write path. */
export function shouldQuarantineFailClosed(scan: EdgeScanResult): boolean {
  return shouldQuarantine(scan) || isScanTruncated(scan)
}

/** SMI-6020: stable label for the primary (SKILL.md) scan in truncation provenance. */
export const ROOT_SCAN_LABEL = 'SKILL.md'

/**
 * SMI-2384: Create a concise human-readable summary of security findings.
 *
 * Groups findings by type and lists each with its line number (if available).
 * Output is capped at `maxFindings` entries to keep the summary brief.
 *
 * @param findings - Array of SecurityFinding objects from a scan
 * @param maxFindings - Maximum number of individual findings to list (default 5)
 * @returns A summary string, or empty string if there are no findings
 */
export function summarizeFindings(findings: SecurityFinding[], maxFindings = 5): string {
  if (findings.length === 0) {
    return ''
  }

  const listed = findings.slice(0, maxFindings)
  const parts = listed.map((f) => {
    const location = f.lineNumber ? ` (line ${f.lineNumber})` : ''
    return `${f.type}${location}`
  })

  let summary = `Patterns found: ${parts.join(', ')}`
  if (findings.length > maxFindings) {
    summary += `, and ${findings.length - maxFindings} more`
  }

  return summary
}
