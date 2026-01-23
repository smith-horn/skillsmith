/**
 * @fileoverview Recommend Tool Helper Functions
 * @module @skillsmith/mcp-server/tools/recommend.helpers
 */

import type { SkillRole } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { mapTrustTierFromDb } from '../utils/validation.js'
import type { SkillData } from './recommend.types.js'

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
// Skill Transformation
// ============================================================================

/**
 * Transform a database skill to SkillData format for matching
 * SMI-1632: Added installable field to filter out collections
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
    qualityScore: Math.round((skill.qualityScore ?? 0.5) * 100),
    trustTier: mapTrustTierFromDb(skill.trustTier),
    roles,
    // SMI-1632: Default to true if not explicitly set
    installable: skill.installable !== false,
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
