/**
 * Repository-to-skill-row mapping, extracted from skill-processor.ts.
 * @module scripts/indexer/skill-processor.repository-mapping
 *
 * SMI-6033 Wave 2 (Gap 8) adversarial-review fix (2026-08-16): the new
 * `scan_coverage_incomplete`/`scan_coverage_note` fields pushed
 * `skill-processor.ts` to 503/500 lines. `sanitizeSkillName` + `repositoryToSkill`
 * moved here verbatim (behavior unchanged) — the same small-sibling extraction
 * precedent as `skill-processor.security.tree.ts` and
 * `skill-processor.helpers.ts`. Both are re-exported from `skill-processor.ts`
 * so the public API is unchanged for every existing caller.
 *
 * `SkillMdValidation` is imported `type`-only from `skill-processor.ts`, so
 * this does not create a real circular runtime import (type-only imports are
 * erased at compile time).
 */

import { shouldQuarantine, QUARANTINE_THRESHOLD } from './_shared/security-scanner-edge.ts'
import { deriveCompatibility } from './compatibility-map.ts'
import type { HighTrustAuthor } from './high-trust-authors.ts'
import type { GitHubRepository } from './topic-search.ts'
import {
  resolveSkillName,
  selectTrustTier,
  computeIntrinsicQuality,
  computeQualityScore,
} from './skill-processor.helpers.ts'
import { buildQuarantineReason, buildMergedQuarantineReason } from './skill-processor.security.ts'
import type { SkillMdValidation } from './skill-processor.ts'

/**
 * SMI-2406: Sanitize skill name from frontmatter for use as identifier.
 * Converts to lowercase, replaces spaces/underscores with hyphens,
 * strips non-alphanumeric characters (except hyphens), and collapses
 * multiple hyphens.
 */
export function sanitizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces/underscores -> hyphens
    .replace(/[^a-z0-9-]/g, '') // strip special chars
    .replace(/-{2,}/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
}

/**
 * Convert repository to skill data
 * Uses cached SKILL.md validation metadata if available
 * SMI-2272: Now includes security scan results
 * SMI-2384: Now includes quarantine_reason for author visibility
 */
export function repositoryToSkill(
  repo: GitHubRepository,
  highTrustAuthor?: HighTrustAuthor,
  validation?: SkillMdValidation,
  // SMI-4651: tri-state. `true` → owner is a GitHub-verified vendor org and
  // Branch B should promote to `curated` with `quality_score >= VENDOR_VERIFIED_FLOOR`.
  // `false`/`undefined` → preserve existing behavior (stars heuristic).
  // Last-positional so existing call sites compile without change.
  orgIsVerified?: boolean
): Record<string, unknown> {
  const validationMetadata = validation?.metadata
  // SMI-2402: trustTier selects the score band; computeIntrinsicQuality
  // spreads within it. Tier selection is unchanged from the prior model.
  const trustTier = selectTrustTier(repo, highTrustAuthor, orgIsVerified)
  const qualityScore = computeQualityScore(
    trustTier,
    computeIntrinsicQuality(validation?.content, validationMetadata, repo)
  )
  if (process.env.SKILLSMITH_LOG_QUALITY_SCORE === 'true') {
    console.log(
      `[QualityScore] ${repo.fullName} tier=${trustTier} stars=${repo.stars} -> score=${qualityScore.toFixed(4)}`
    )
  }

  // SMI-4858: name fallback chain (see resolveSkillName).
  // SMI-5930 Wave 4: Pass skillPath for leaf-segment fallback defense-in-depth.
  const name = resolveSkillName(validationMetadata?.name, repo, sanitizeSkillName, repo.skillPath)
  const description =
    validationMetadata?.description || repo.description || `${name} — a Claude Code skill`

  let tags = [...repo.topics]
  if (validationMetadata?.triggers && validationMetadata.triggers.length > 0) {
    const triggerTags = validationMetadata.triggers.map((t) => t.toLowerCase().replace(/\s+/g, '-'))
    tags = [...new Set([...tags, ...triggerTags])]
  }
  if (validationMetadata?.frontmatterTags && validationMetadata.frontmatterTags.length > 0) {
    const fmTags = validationMetadata.frontmatterTags.map((t) =>
      t.toLowerCase().replace(/\s+/g, '-')
    )
    tags = [...new Set([...tags, ...fmTags])]
  }
  if (validationMetadata?.frontmatterCategory) {
    tags = [...new Set([...tags, validationMetadata.frontmatterCategory])]
  }

  const securityScan = validation?.securityScan
  const mergedScan = validation?.mergedSecurityScan

  // SMI-5436 Wave 2: prefer merged scan (SKILL.md + siblings) when available
  const quarantined = mergedScan
    ? mergedScan.quarantine
    : securityScan
      ? shouldQuarantine(securityScan)
      : false

  const quarantineReason = mergedScan
    ? buildMergedQuarantineReason(mergedScan, repo.owner, name)
    : securityScan
      ? buildQuarantineReason(securityScan, repo.owner, name)
      : null

  if (quarantined) {
    console.log(
      `[SecurityScan] QUARANTINE: ${repo.fullName} riskScore=${mergedScan?.riskScore ?? securityScan?.riskScore} threshold=${QUARANTINE_THRESHOLD}`
    )
  }

  // SMI-2723: Only set repo_url when the skill is installable (SKILL.md confirmed present).
  // Skills that passed discovery but failed SKILL.md validation (installable: false) must
  // have repo_url = null so they appear as discovery-only entries rather than broken installs.
  const repoUrl = repo.installable ? repo.url : null
  if (!repo.installable) {
    console.log(
      `[IndexerHardening] SMI-2723: ${repo.fullName} has no valid SKILL.md — setting repo_url=null (discovery-only)`
    )
  }

  return {
    name,
    description,
    author: validationMetadata?.author || repo.owner,
    publisher: repo.owner,
    repo_url: repoUrl,
    quality_score: qualityScore,
    trust_tier: trustTier,
    tags,
    stars: repo.stars,
    installable: repo.installable,
    indexed_at: new Date().toISOString(),
    // SMI-5849: prefer validation.contentHash (set whenever content was fetched,
    // independent of whether a security scan ran) over securityScan.contentHash.
    content_hash: validation?.contentHash ?? securityScan?.contentHash ?? null,
    last_scanned_at: securityScan?.scannedAt ?? null,
    security_score: mergedScan?.riskScore ?? securityScan?.riskScore ?? null,
    security_findings: mergedScan?.findings ?? securityScan?.findings ?? [],
    quarantined,
    quarantine_reason: quarantineReason || null,
    // SMI-6033 Wave 2 (Gap 8): partial-scan observability — never silently
    // dropped when the extended sibling-file scan couldn't cover everything.
    scan_coverage_incomplete: validation?.scanCoverage?.incomplete ?? false,
    scan_coverage_note: validation?.scanCoverage?.note ?? null,
    last_seen_at: new Date().toISOString(),
    // SMI-4846: Skip-gate; future runs with matching repo.updatedAt bypass validateSkillMd.
    repo_updated_at: repo.updatedAt ?? null,
    // SMI-2663: Cross-ecosystem discovery columns (migration 055)
    source_format: 'skill-md', // Phase 1: always skill-md; Phase 2 will detect format
    // SMI-5286 Wave 1b (R-2): persist the in-memory discovery provenance tag
    // (e.g. 'subdirectory_search:…', 'backfill_trees:<facet>') stamped at the
    // discovery site. Column added in 20260617000001_skills_discovery_path.sql;
    // load-bearing for the backfill §Rollback tag-keyed DELETE + count ACs.
    // `?? null` so pre-tag callers (and any path that forgot to stamp) land NULL.
    discovery_path: repo.discoveryPath ?? null,
    license: repo.license ?? null,
    // SMI-4387: Default to '' (empty string, explicit root marker) instead of null.
    // Migration 055's CHECK constraint allows empty string; new rows never land as NULL.
    // Legacy NULLs remain as-is (cohort marker for SMI-4385 before/after yield measurement).
    skill_path: repo.skillPath ?? '',
    // SMI-5177 (Phase 2a): forward-populate compatibility from skill_path so the
    // migration backfill only ever covers pre-existing rows. Same matrix as the
    // backfill CASE (scripts/indexer/compatibility-map.ts). [] = unknown/unscoped.
    compatibility: deriveCompatibility(repo.skillPath ?? ''),
    tree_hash: repo.treeHash ?? null, // SMI-4861 Wave 1 — migration 20260512000001
    last_tree_hash_check: repo.treeHash ? new Date().toISOString() : null,
  }
}
