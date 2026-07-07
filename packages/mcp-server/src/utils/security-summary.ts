/**
 * @fileoverview Shared derivation of a `SecuritySummary` from an API skill row.
 * @module @skillsmith/mcp-server/utils/security-summary
 * @see SMI-4240: original inline derivation in get-skill.ts
 * @see SMI-5562: extracted here so get-skill.ts, recommend.ts, and search.ts
 *   share a single implementation instead of triplicating the logic.
 */

import type { ApiSkill, SecuritySummary } from '@skillsmith/core'

/**
 * Derive a `SecuritySummary` from an API skill row's flat security columns.
 *
 * Returns `undefined` when the skill has never been scanned
 * (`last_scanned_at == null`) — never scanned is a distinct state from
 * "scanned but no verdict" and callers must not conflate the two by
 * shipping a placeholder `{ passed: null, ... }` object for skills that
 * were never scanned at all.
 *
 * `security_findings_count` is not a stored column — `findingsCount` is
 * always derived from the length of the `security_findings` jsonb array
 * (defensively 0 when the value is missing or not an array).
 *
 * @param apiSkill - Object carrying the flat security columns from an
 *   `ApiSkill`/`ApiSearchResult` row (registry API response shape).
 * @returns The derived summary, or `undefined` when never scanned.
 */
export function deriveSecuritySummaryFromApiSkill(
  apiSkill: Pick<
    ApiSkill,
    'last_scanned_at' | 'quarantined' | 'security_score' | 'security_findings'
  >
): SecuritySummary | undefined {
  if (apiSkill.last_scanned_at == null) {
    return undefined
  }

  return {
    passed: apiSkill.quarantined === true ? false : apiSkill.security_score == null ? null : true,
    riskScore: apiSkill.security_score ?? null,
    findingsCount: Array.isArray(apiSkill.security_findings)
      ? apiSkill.security_findings.length
      : 0,
    scannedAt: apiSkill.last_scanned_at,
  }
}
