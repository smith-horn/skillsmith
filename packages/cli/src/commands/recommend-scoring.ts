/**
 * SMI-1299: CLI Recommend Scoring Helpers
 *
 * Role inference and overlap detection for skill recommendations.
 *
 * @module @skillsmith/cli/commands/recommend-scoring
 */

import type { SkillRole } from '@skillsmith/core'
import type { SkillRecommendation, InstalledSkill } from './recommend.types.js'

// ============================================================================
// Role Inference
// ============================================================================

/**
 * SMI-1631: Infer skill roles from tags when not explicitly set
 */
export function inferRolesFromTags(tags: string[]): SkillRole[] {
  const roleMapping: Record<string, SkillRole> = {
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
    docs: 'documentation',
    documentation: 'documentation',
    readme: 'documentation',
    jsdoc: 'documentation',
    typedoc: 'documentation',
    changelog: 'documentation',
    api: 'documentation',
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
    security: 'security',
    audit: 'security',
    vulnerability: 'security',
    cve: 'security',
    secrets: 'security',
    authentication: 'security',
    auth: 'security',
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
// Overlap Detection
// ============================================================================

/**
 * Normalize a skill name for comparison (SMI-1358)
 */
export function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]/g, '')
    .replace(/^skill/, '')
    .replace(/skill$/, '')
    .replace(/^helper/, '')
    .replace(/helper$/, '')
    .trim()
}

/**
 * Check if two skills overlap in functionality (SMI-1358)
 */
export function skillsOverlap(
  installed: InstalledSkill,
  recommended: SkillRecommendation
): boolean {
  const installedName = normalizeSkillName(installed.name)
  const recommendedName = normalizeSkillName(recommended.name)
  const recommendedId = recommended.skill_id.toLowerCase()

  if (installedName === recommendedName) return true
  if (recommendedId.includes(installed.name)) return true

  if (installedName.includes(recommendedName) || recommendedName.includes(installedName)) {
    if (installedName.length >= 4 && recommendedName.length >= 4) return true
  }

  if (installed.tags.length > 0) {
    const recommendedNameParts = recommended.name.toLowerCase().split(/[-_\s]+/)
    const hasTagOverlap = installed.tags.some(
      (tag) => recommendedNameParts.includes(tag) || recommendedName.includes(tag)
    )
    if (hasTagOverlap) return true
  }

  return false
}

/**
 * Filter recommendations to remove overlaps with installed skills (SMI-1358)
 */
export function filterOverlappingSkills(
  recommendations: SkillRecommendation[],
  installedSkills: InstalledSkill[]
): { filtered: SkillRecommendation[]; overlapCount: number } {
  if (installedSkills.length === 0) {
    return { filtered: recommendations, overlapCount: 0 }
  }

  const filtered: SkillRecommendation[] = []
  let overlapCount = 0

  for (const rec of recommendations) {
    const hasOverlap = installedSkills.some((installed) => skillsOverlap(installed, rec))
    if (hasOverlap) {
      overlapCount++
    } else {
      filtered.push(rec)
    }
  }

  return { filtered, overlapCount }
}
