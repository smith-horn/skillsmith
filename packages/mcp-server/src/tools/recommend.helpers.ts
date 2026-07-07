/**
 * @fileoverview Recommend Tool Helper Functions
 * @module @skillsmith/mcp-server/tools/recommend.helpers
 */

import type { SkillRole, ApiSearchResult } from '@skillsmith/core'
import type { SkillMatchResult } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { mapTrustTierFromDb } from '../utils/validation.js'
import { deriveSecuritySummaryFromApiSkill } from '../utils/security-summary.js'
import type { SkillData, SkillRecommendation } from './recommend.types.js'
import type { LocalSkill } from '../indexer/LocalIndexer.js'

// ============================================================================
// Empty-Result Guidance (SMI-5556)
// ============================================================================

/**
 * Build a `suggestion` string for a zero-recommendation response, explaining
 * that candidates_considered: 0 does not indicate a registry/backend fault
 * and pointing at concrete next steps.
 */
export function buildEmptyRecommendationSuggestion(context: {
  installedCount: number
  hasProjectContext: boolean
  roleFilter?: SkillRole
}): string {
  const lines = [
    'No recommendations found. This does not indicate a registry/backend problem — ' +
      'candidates_considered reflects no matches from any candidate source (registry API, ' +
      'local skill cache, local ~/.claude/skills scan) for this input.',
  ]
  if (context.installedCount === 0) {
    lines.push('Try passing installed_skills explicitly for better matching.')
  }
  if (!context.hasProjectContext) {
    lines.push('Provide project_context for more relevant results.')
  }
  if (context.roleFilter) {
    lines.push(`Try removing the role filter (currently: ${context.roleFilter}).`)
  }
  lines.push(
    'As a fallback, try the search tool directly with a short single-topic query ' +
      '(e.g. "testing") — it queries the registry independently of recommendation matching.'
  )
  return lines.join(' ')
}

// ============================================================================
// Role Inference
// ============================================================================

/**
 * SMI-1631: Infer skill roles from tags when not explicitly set
 * Maps common tags to skill roles for better filtering
 * SMI-1725: Handles null/undefined input gracefully
 */
export function inferRolesFromTags(tags: string[]): SkillRole[] {
  // Defensive: handle null/undefined input
  if (!tags || !Array.isArray(tags)) {
    return []
  }

  const roleMapping: Record<string, SkillRole> = {
    // Code quality
    lint: 'code-quality',
    linting: 'code-quality',
    format: 'code-quality',
    formatting: 'code-quality',
    prettier: 'code-quality',
    eslint: 'code-quality',
    'code-review': 'code-quality',
    review: 'code-quality',
    refactor: 'code-quality',
    refactoring: 'code-quality',
    'code-style': 'code-quality',
    // Testing
    test: 'testing',
    testing: 'testing',
    jest: 'testing',
    vitest: 'testing',
    mocha: 'testing',
    playwright: 'testing',
    cypress: 'testing',
    e2e: 'testing',
    unit: 'testing',
    integration: 'testing',
    tdd: 'testing',
    // Documentation
    docs: 'documentation',
    documentation: 'documentation',
    readme: 'documentation',
    jsdoc: 'documentation',
    typedoc: 'documentation',
    changelog: 'documentation',
    api: 'documentation',
    // Workflow
    git: 'workflow',
    commit: 'workflow',
    pr: 'workflow',
    'pull-request': 'workflow',
    ci: 'workflow',
    cd: 'workflow',
    'ci-cd': 'workflow',
    deploy: 'workflow',
    deployment: 'workflow',
    automation: 'workflow',
    workflow: 'workflow',
    // Security
    security: 'security',
    audit: 'security',
    vulnerability: 'security',
    cve: 'security',
    secrets: 'security',
    authentication: 'security',
    auth: 'security',
    // Development partner
    ai: 'development-partner',
    assistant: 'development-partner',
    helper: 'development-partner',
    copilot: 'development-partner',
    productivity: 'development-partner',
    scaffold: 'development-partner',
    generator: 'development-partner',
  }

  const inferredRoles = new Set<SkillRole>()
  for (const tag of tags) {
    const normalizedTag = tag.toLowerCase().replace(/[-_]/g, '')
    for (const [keyword, role] of Object.entries(roleMapping)) {
      if (normalizedTag.includes(keyword.replace(/[-_]/g, ''))) {
        inferredRoles.add(role)
      }
    }
  }

  return [...inferredRoles]
}

// ============================================================================
// SkillRecommendation Construction (SMI-5562)
// ============================================================================
// Extracted from recommend.ts's three construction sites to keep that file
// under the 500-line governance limit. Each function owns the description +
// security wiring for its data path.

/**
 * SMI-1837: Convert a disk-scanned LocalSkill to SkillRecommendation format.
 * SMI-5562: `security` is intentionally left unset (undefined) — local skills
 * are never registry-scanned, so absence is the honest signal, distinct from
 * `security.passed === null` ("scanned, no verdict yet").
 */
export function buildLocalSkillRecommendation(
  skill: LocalSkill,
  matchReason: string
): SkillRecommendation {
  const roles = inferRolesFromTags(skill.tags)
  return {
    skill_id: skill.id,
    name: skill.name,
    reason: matchReason,
    similarity_score: 0.7, // Local skills get a default similarity score
    trust_tier: 'local',
    quality_score: skill.qualityScore,
    roles,
    // SMI-5178 (C2): local skills are always installable (they live on disk).
    installable: true,
    description: skill.description || '',
  }
}

/**
 * Build a SkillRecommendation from a registry API recommendation row.
 * SMI-5562: description + security summary — skills-recommend hydrates
 * security_score/last_scanned_at/security_findings/quarantined server-side.
 */
export function buildApiRecommendation(
  skill: ApiSearchResult,
  stack: string[]
): SkillRecommendation {
  const skillRoles = inferRolesFromTags(skill.tags || [])
  return {
    skill_id: skill.id,
    name: skill.name,
    reason: `Matches your stack: ${stack.slice(0, 3).join(', ')}`,
    similarity_score: 0.8, // API doesn't return similarity score, use default
    trust_tier: mapTrustTierFromDb(skill.trust_tier),
    quality_score: Math.round((skill.quality_score ?? 0.5) * 100),
    roles: skillRoles,
    // SMI-5178 (C2): thread installable from the API result (repo_url present = installable).
    installable: skill.installable ?? skill.repo_url != null,
    description: skill.description || '',
    security: deriveSecuritySummaryFromApiSkill(skill),
  }
}

/**
 * Build a SkillRecommendation from a local-DB semantic match result
 * (the offline/API-failure fallback path).
 *
 * SMI-5562 (safety-critical): `security` is `undefined` when the row was
 * never scanned (`securityScannedAt == null`) — mirrors
 * `deriveSecuritySummaryFromApiSkill`'s API-path semantics exactly. A
 * defined-but-null object here would narrate as "scanned, no verdict yet"
 * under the tool description's 3-state contract, which is false for a skill
 * that was never scanned at all. When a summary IS returned, riskScore/
 * scannedAt/passed pass through RAW from SkillData — never coerce/default to
 * 0/a fabricated timestamp, which would read as "confirmed clean."
 */
export function buildDbFallbackRecommendation(
  result: SkillMatchResult,
  role: SkillRole | undefined
): SkillRecommendation {
  const skill = result.skill as SkillData
  const hasRoleMatch = role != null && skill.roles.includes(role)
  const boostedScore = hasRoleMatch
    ? Math.min(1, (skill.qualityScore ?? 0.5) + 0.3)
    : (skill.qualityScore ?? 0.5)

  return {
    skill_id: skill.id,
    name: skill.name,
    reason: hasRoleMatch ? `${result.matchReason} (role: ${role})` : result.matchReason,
    similarity_score: result.similarityScore,
    trust_tier: skill.trustTier,
    quality_score: Math.round(boostedScore * 100),
    roles: skill.roles,
    // SMI-5178 (C2): thread installable from SkillData (set by transformSkillToMatchData).
    installable: skill.installable !== false ? true : false,
    // SkillData.description is typed `string` (not nullable), so `??` (not `||`).
    description: skill.description ?? '',
    security:
      skill.securityScannedAt == null
        ? undefined
        : {
            passed: skill.securityPassed,
            riskScore: skill.riskScore,
            findingsCount: skill.securityFindingsCount,
            scannedAt: skill.securityScannedAt,
          },
  }
}

// ============================================================================
// Skill Transformation
// ============================================================================

/**
 * Transform a database skill to SkillData format for matching
 * SMI-1632: Added installable field to filter out collections
 * SMI-5562: Added flat security fields, copied straight through with no
 * defaulting — `loadSkillsFromDatabase` passes full repository `Skill` rows
 * (packages/core/src/types/skill.ts), so these are always present on input.
 */
export function transformSkillToMatchData(skill: {
  id: string
  name: string
  description: string | null
  tags: string[]
  qualityScore: number | null
  trustTier: string
  roles?: SkillRole[]
  installable: boolean
  riskScore: number | null
  securityFindingsCount: number
  securityScannedAt: string | null
  securityPassed: boolean | null
}): SkillData {
  // Generate trigger phrases from name and first few tags
  const triggerPhrases = [
    skill.name,
    `use ${skill.name}`,
    `${skill.name} help`,
    ...skill.tags.slice(0, 3).map((tag) => `${tag} ${skill.name}`),
  ]

  // SMI-1631: Use explicit roles or infer from tags
  const roles = skill.roles?.length ? skill.roles : inferRolesFromTags(skill.tags)

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description || '',
    triggerPhrases,
    keywords: skill.tags,
    // SMI-3864: Pass 0-1 scale directly (SkillMatcher no longer divides by 100)
    qualityScore: skill.qualityScore ?? 0.5,
    trustTier: mapTrustTierFromDb(skill.trustTier),
    roles,
    // SMI-1632: Default to true if not explicitly set
    installable: skill.installable !== false,
    // SMI-5562: Copied straight through — no `??`/`||` defaulting. `null` on
    // riskScore/securityScannedAt must stay `null` (never scanned), not be
    // coerced to 0/a fabricated timestamp, which would read as "confirmed safe."
    riskScore: skill.riskScore,
    securityFindingsCount: skill.securityFindingsCount,
    securityScannedAt: skill.securityScannedAt,
    securityPassed: skill.securityPassed,
  }
}

// ============================================================================
// Data Loading
// ============================================================================

/**
 * Load skills from database via ToolContext
 * Returns skills transformed to SkillData format for matching
 * Note: Collection filtering is done in the candidate filter using naming patterns (SMI-1632)
 */
export async function loadSkillsFromDatabase(
  context: ToolContext,
  limit: number = 500
): Promise<SkillData[]> {
  const result = context.skillRepository.findAll(limit, 0)
  return result.items.map(transformSkillToMatchData)
}

// ============================================================================
// Collection Detection
// ============================================================================

/**
 * Collection name patterns to filter out
 */
export const COLLECTION_PATTERNS = [
  '-skills',
  '-collection',
  '-pack',
  'skill-collection',
  'skills-repo',
]

/**
 * Check if a skill is a collection based on naming patterns
 */
export function isSkillCollection(skillIdName: string, description: string): boolean {
  return (
    COLLECTION_PATTERNS.some((pattern) => skillIdName.includes(pattern)) ||
    (description.toLowerCase().includes('collection of') &&
      description.toLowerCase().includes('skill'))
  )
}
