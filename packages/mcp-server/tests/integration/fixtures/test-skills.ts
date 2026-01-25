/**
 * SMI-903: Comprehensive test skill fixtures
 * Provides 50+ skills across all categories and trust tiers for realistic testing
 *
 * This file aggregates skills from category-specific modules for backwards
 * compatibility with existing tests.
 */

import type { SkillRepository } from '@skillsmith/core'
import type { TestSkillData } from './skill-types.js'
import { VERIFIED_SKILLS } from './verified-skills.js'
import { TESTING_SKILLS } from './testing-skills.js'
import { DEVOPS_SKILLS } from './devops-skills.js'
import {
  DEVELOPMENT_SKILLS,
  DOCUMENTATION_SKILLS,
  DATABASE_SKILLS,
  OVERLAP_DETECTION_SKILLS,
} from './development-skills.js'
import { EXPERIMENTAL_SKILLS, UNKNOWN_SKILLS } from './experimental-skills.js'

// Re-export the type for backwards compatibility
export type { TestSkillData } from './skill-types.js'

// Re-export category-specific arrays
export { VERIFIED_SKILLS } from './verified-skills.js'
export { TESTING_SKILLS } from './testing-skills.js'
export { DEVOPS_SKILLS } from './devops-skills.js'
export {
  DEVELOPMENT_SKILLS,
  DOCUMENTATION_SKILLS,
  DATABASE_SKILLS,
  OVERLAP_DETECTION_SKILLS,
} from './development-skills.js'
export { EXPERIMENTAL_SKILLS, UNKNOWN_SKILLS } from './experimental-skills.js'

/**
 * Comprehensive test skills covering all categories and trust tiers
 * Total: 58 skills (updated for SMI-907)
 * - Categories: development, testing, documentation, devops, database, security, productivity, integration, ai-ml, other
 * - Trust tiers: verified (8), community (26), experimental (16), unknown (8)
 */
export const TEST_SKILLS: TestSkillData[] = [
  ...VERIFIED_SKILLS,
  ...TESTING_SKILLS,
  ...DEVOPS_SKILLS,
  ...DEVELOPMENT_SKILLS,
  ...DOCUMENTATION_SKILLS,
  ...DATABASE_SKILLS,
  ...EXPERIMENTAL_SKILLS,
  ...OVERLAP_DETECTION_SKILLS,
  ...UNKNOWN_SKILLS,
]

/**
 * Seed all test skills into the repository
 */
export function seedTestSkills(repo: SkillRepository): void {
  repo.createBatch(TEST_SKILLS)
}

/**
 * Get skills by category for targeted testing
 */
export function getSkillsByCategory(category: string): TestSkillData[] {
  return TEST_SKILLS.filter((skill) => skill.tags.includes(category))
}

/**
 * Get skills by trust tier for targeted testing
 */
export function getSkillsByTrustTier(
  tier: 'verified' | 'community' | 'experimental' | 'unknown'
): TestSkillData[] {
  return TEST_SKILLS.filter((skill) => skill.trustTier === tier)
}

/**
 * Summary statistics for test data validation
 */
export const TEST_SKILLS_STATS = {
  total: TEST_SKILLS.length,
  byTrustTier: {
    verified: TEST_SKILLS.filter((s) => s.trustTier === 'verified').length,
    community: TEST_SKILLS.filter((s) => s.trustTier === 'community').length,
    experimental: TEST_SKILLS.filter((s) => s.trustTier === 'experimental').length,
    unknown: TEST_SKILLS.filter((s) => s.trustTier === 'unknown').length,
  },
  byCategory: {
    development: TEST_SKILLS.filter((s) => s.tags.includes('development')).length,
    testing: TEST_SKILLS.filter((s) => s.tags.includes('testing')).length,
    documentation: TEST_SKILLS.filter((s) => s.tags.includes('documentation')).length,
    devops: TEST_SKILLS.filter((s) => s.tags.includes('devops')).length,
    database: TEST_SKILLS.filter((s) => s.tags.includes('database')).length,
    security: TEST_SKILLS.filter((s) => s.tags.includes('security')).length,
    productivity: TEST_SKILLS.filter((s) => s.tags.includes('productivity')).length,
    integration: TEST_SKILLS.filter((s) => s.tags.includes('integration')).length,
    'ai-ml': TEST_SKILLS.filter((s) => s.tags.includes('ai-ml')).length,
  },
}
