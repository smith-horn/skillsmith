/**
 * @fileoverview Shared derivation of a `SecuritySummary` from an API skill row,
 * and from a pre-computed local-DB-shaped skill row.
 * @module @skillsmith/core/api/security-summary
 * @see SMI-4240: original inline derivation in mcp-server's get-skill.ts
 * @see SMI-5562: extracted to mcp-server's utils/security-summary.ts so
 *   get-skill.ts, recommend.ts, and search.ts share a single implementation
 *   instead of triplicating the logic.
 * @see SMI-5897 (C-15): moved here from mcp-server so `SkillsmithApiClient.toSkill()`
 *   (CLI path) can share the exact same derivation instead of hardcoding
 *   `riskScore: null, securityFindingsCount: 0, securityScannedAt: null,
 *   securityPassed: null` for every API-sourced skill — which caused CLI
 *   `info`/`search` to show "Not scanned" for skills MCP correctly reported
 *   as passed. Both `toSkill()` and mcp-server's tool call sites now import
 *   this one function, so the two surfaces cannot re-diverge.
 * @see SMI-5897 (Wave 4 fix): `deriveSecuritySummaryFromSkillRow()` added
 *   alongside `deriveSecuritySummaryFromApiSkill()` — the local-DB-path
 *   sibling for the SAME undefined-when-never-scanned contract, but over the
 *   pre-computed `securityPassed`/`riskScore`/`securityFindingsCount`/
 *   `securityScannedAt` field shape (as opposed to the raw API row's
 *   `last_scanned_at`/`quarantined`/`security_score`/`security_findings`
 *   columns). `recommend.helpers.ts`'s `buildDbFallbackRecommendation` had
 *   this exact ternary inline already; `search.helpers.ts`'s
 *   `mapLocalSkillToSearchResult` and `get-skill.ts`'s local-DB branch built
 *   the security object unconditionally, violating the contract for a
 *   never-scanned skill. All three now share this one function.
 */

import type { ApiSkill } from './types.js'
import type { SecuritySummary } from '../types.js'

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

/**
 * Derive a `SecuritySummary` from a local-DB-shaped skill row's PRE-COMPUTED
 * flat security fields (`securityPassed`/`riskScore`/`securityFindingsCount`/
 * `securityScannedAt` — a different shape from {@link deriveSecuritySummaryFromApiSkill}'s
 * raw API-row columns).
 *
 * Same contract as {@link deriveSecuritySummaryFromApiSkill}: returns
 * `undefined` when the skill has never been scanned (`securityScannedAt ==
 * null`) — never scanned is a distinct state from "scanned but no verdict"
 * and callers must not conflate the two by shipping a placeholder
 * `{ passed: null, ... }` object for skills that were never scanned at all.
 * `passed`/`riskScore` pass through RAW — never coerce/default to a
 * fabricated value, which would misread as "confirmed clean/scanned."
 *
 * @param skill - Object carrying the pre-computed flat security fields
 *   present on both a local `Skill` repository row and `SkillData`
 *   (mcp-server's recommend matcher shape).
 * @returns The derived summary, or `undefined` when never scanned.
 */
export function deriveSecuritySummaryFromSkillRow(skill: {
  securityPassed: boolean | null
  riskScore: number | null
  securityFindingsCount: number
  securityScannedAt: string | null
}): SecuritySummary | undefined {
  if (skill.securityScannedAt == null) {
    return undefined
  }

  return {
    passed: skill.securityPassed,
    riskScore: skill.riskScore,
    findingsCount: skill.securityFindingsCount,
    scannedAt: skill.securityScannedAt,
  }
}
