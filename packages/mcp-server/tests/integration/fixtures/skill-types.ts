/**
 * SMI-903: Test skill type definitions
 * Shared types for test skill fixtures
 */

/**
 * Test skill data structure matching SkillRepository.createBatch expectations
 */
export interface TestSkillData {
  id: string
  name: string
  description: string
  author: string
  repoUrl: string
  qualityScore: number
  trustTier: 'verified' | 'community' | 'experimental' | 'unknown'
  tags: string[]
}
