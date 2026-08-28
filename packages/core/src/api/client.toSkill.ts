/**
 * @fileoverview SkillsmithApiClient.toSkill() implementation.
 * @module @skillsmith/core/api/client.toSkill
 * @see client.toSkill.test.ts (SMI-5897 C-15 — security-status field derivation coverage)
 * @see client.health.ts / client.private-registry.ts — the existing
 *   companion-module convention used to keep client.ts under the 500-line
 *   standard.
 *
 * Pure mapping function extracted from client.ts — no instance state is
 * needed (it never reads `this`), so it lives standalone rather than as an
 * inline static method body.
 */

import type { Skill } from '../types/skill.js'
import type { ApiSearchResult } from './client.types.js'
import { deriveSecuritySummaryFromApiSkill } from './security-summary.js'

// SMI-1577: optional field defaults. SMI-825: security scan fields default to not-scanned.
export function toSkillImpl(result: ApiSearchResult): Skill {
  // Sentinel value for missing timestamps - clearly indicates unknown date
  const UNKNOWN_DATE = '1970-01-01T00:00:00.000Z'
  // SMI-5897 (C-15): derive real security-status fields via the shared
  // helper instead of hardcoding "not scanned" for every API-sourced
  // skill — this is what made CLI `info`/`search` show "Not scanned" for
  // skills MCP correctly reported as passed (both now derive from the
  // same underlying last_scanned_at/quarantined/security_score fields).
  // `security` is `undefined` when the skill has never been scanned;
  // the flat Skill shape signals that the same way MCP's nested
  // SecuritySummary does — securityPassed: null, securityScannedAt: null.
  const security = deriveSecuritySummaryFromApiSkill(result)
  return {
    id: result.id,
    name: result.name,
    description: result.description,
    author: result.author,
    repoUrl: result.repo_url ?? null,
    qualityScore: result.quality_score,
    trustTier: result.trust_tier,
    tags: result.tags || [],
    installable: result.installable ?? false,
    // SMI-825: Security scan fields
    riskScore: security?.riskScore ?? null,
    securityFindingsCount: security?.findingsCount ?? 0,
    securityScannedAt: security?.scannedAt ?? null,
    securityPassed: security?.passed ?? null,
    createdAt: result.created_at ?? UNKNOWN_DATE,
    updatedAt: result.updated_at ?? UNKNOWN_DATE,
  }
}
