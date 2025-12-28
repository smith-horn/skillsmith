/**
 * Mock skill data for MVP
 * TODO: Replace with actual API calls when backend is ready
 */

export interface SkillData {
  id: string
  name: string
  description: string
  author: string
  category: string
  trustTier: string
  score: number
  repository?: string
}

/**
 * Mock skills for search and display
 * This data will be replaced with API calls in production
 */
export const MOCK_SKILLS: SkillData[] = [
  {
    id: 'governance',
    name: 'Governance',
    description:
      'Enforces engineering standards from standards.md. Ensures code quality and best practices.',
    author: 'skillsmith',
    category: 'development',
    trustTier: 'verified',
    score: 95,
    repository: 'https://github.com/skillsmith/governance-skill',
  },
  {
    id: 'linear-integration',
    name: 'Linear Integration',
    description:
      'Manages Linear issues, projects, and workflows. Sync tasks directly from VS Code.',
    author: 'skillsmith',
    category: 'productivity',
    trustTier: 'verified',
    score: 92,
    repository: 'https://github.com/skillsmith/linear-skill',
  },
  {
    id: 'docker-manager',
    name: 'Docker Manager',
    description: 'Container-based development for isolated, reproducible environments.',
    author: 'community',
    category: 'devops',
    trustTier: 'community',
    score: 88,
    repository: 'https://github.com/community/docker-skill',
  },
  {
    id: 'test-generator',
    name: 'Test Generator',
    description: 'Automatically generates unit tests for your code using AI.',
    author: 'skillsmith',
    category: 'testing',
    trustTier: 'standard',
    score: 85,
    repository: 'https://github.com/skillsmith/test-generator-skill',
  },
  {
    id: 'api-docs',
    name: 'API Documentation',
    description: 'Generates comprehensive API documentation from code comments and types.',
    author: 'community',
    category: 'documentation',
    trustTier: 'community',
    score: 82,
    repository: 'https://github.com/community/api-docs-skill',
  },
]

/**
 * Get skill data by ID
 * @param skillId - The skill ID to look up
 * @returns The skill data or a default "not found" skill
 */
export function getSkillById(skillId: string): SkillData {
  const skill = MOCK_SKILLS.find((s) => s.id === skillId)
  return (
    skill || {
      id: skillId,
      name: skillId,
      description: 'Skill details not available',
      author: 'Unknown',
      category: 'other',
      trustTier: 'unverified',
      score: 0,
    }
  )
}

/**
 * Search skills by query
 * @param query - The search query
 * @returns Matching skills
 */
export function searchSkills(query: string): SkillData[] {
  const normalizedQuery = query.toLowerCase().trim()

  if (!normalizedQuery) {
    return []
  }

  return MOCK_SKILLS.filter((skill) => {
    return (
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.description.toLowerCase().includes(normalizedQuery) ||
      skill.category.toLowerCase().includes(normalizedQuery) ||
      skill.author.toLowerCase().includes(normalizedQuery)
    )
  })
}
