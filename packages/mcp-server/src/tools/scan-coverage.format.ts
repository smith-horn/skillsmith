/**
 * @fileoverview Shared terminal/CLI formatting for the SMI-6033 Wave 2
 * (Gap 8) partial-scan coverage caveat.
 * @module @skillsmith/mcp-server/tools/scan-coverage.format
 *
 * `scanCoverageNote` on the wire is a `'; '`-joined list of machine-readable
 * cause TOKENS (`scripts/indexer/skill-processor.security.tree.ts`'s
 * `ScanCoverageCause` — e.g. `'count_cap'`, `'size_cap; tree_truncated'`), not
 * prose — deliberately, so the persisted `skills.scan_coverage_note` column
 * stays stable and greppable. This module is the ONE place that translates
 * those tokens to human-readable phrasing for terminal/CLI display, shared by
 * `get-skill.format.ts` and `search.formatter.ts` so the two surfaces cannot
 * silently diverge in wording. Unrecognized tokens (e.g. a future cause added
 * indexer-side without updating this map) fall through unchanged rather than
 * being dropped, so drift is visible instead of silently swallowed.
 */

const SCAN_COVERAGE_CAUSE_PROSE: Record<string, string> = {
  count_cap: 'too many candidate files',
  size_cap: 'a file exceeded the size limit',
  sibling_fetch_transient: 'a file could not be fetched',
  tree_fetch_failed: 'the file listing could not be fetched',
  tree_truncated: 'the file listing was truncated',
  tree_budget_exhausted: 'the scan budget for this run was exhausted',
}

/** Render a `scanCoverageNote` token list as a human-readable phrase. */
export function formatScanCoverageNote(note: string): string {
  return note
    .split('; ')
    .map((token) => SCAN_COVERAGE_CAUSE_PROSE[token] ?? token)
    .join('; ')
}

/** The standard partial-scan caveat line, or `null` when coverage was complete. */
export function formatScanCoverageCaveat(
  scanCoverageIncomplete: boolean | undefined,
  scanCoverageNote: string | null | undefined
): string | null {
  if (scanCoverageIncomplete !== true) return null
  return (
    'Note: partial scan — some files could not be analyzed' +
    (scanCoverageNote ? ' (' + formatScanCoverageNote(scanCoverageNote) + ')' : '')
  )
}
