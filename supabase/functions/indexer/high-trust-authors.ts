/**
 * High-Trust Authors Configuration
 *
 * SMI-XXXX: Add verified skill sources from trusted publishers
 *
 * These repositories are explicitly indexed as "verified" trust tier.
 * Skills from these sources receive priority indexing and higher trust scores.
 *
 * License Compliance:
 * - All repositories listed here have been verified for compatible licensing
 * - Excluded skills are source-available (not open source) and cannot be indexed
 *
 * @see https://github.com/anthropics/skills - Mixed (Apache 2.0 + Source-Available)
 * @see https://github.com/huggingface/skills - Apache 2.0
 * @see https://github.com/vercel-labs/agent-skills - MIT
 */

export interface HighTrustAuthor {
  /** GitHub org/user name */
  owner: string
  /** Repository name */
  repo: string
  /** License identifier */
  license: 'Apache-2.0' | 'MIT' | 'Mixed'
  /** Base quality score (0-1) for skills from this author */
  baseQualityScore: number
  /** Skills to explicitly exclude (source-available, not open source) */
  excludeSkills?: string[]
  /** If set, only index these specific skills */
  includeSkills?: string[]
  /** Description for audit logs */
  description: string
}

/**
 * High-trust authors configuration
 *
 * These are official company repositories with verified licenses.
 * All skills from these authors are marked as "verified" trust tier.
 */
export const HIGH_TRUST_AUTHORS: HighTrustAuthor[] = [
  {
    owner: 'anthropics',
    repo: 'skills',
    license: 'Mixed',
    baseQualityScore: 0.95,
    excludeSkills: [
      // Source-available, NOT open source - cannot index per license
      'docx',
      'pdf',
      'pptx',
      'xlsx',
    ],
    description: 'Official Anthropic Claude skills (Apache 2.0 licensed only)',
  },
  {
    owner: 'huggingface',
    repo: 'skills',
    license: 'Apache-2.0',
    baseQualityScore: 0.93,
    description: 'Official Hugging Face ML/AI skills',
  },
  {
    owner: 'vercel-labs',
    repo: 'agent-skills',
    license: 'MIT',
    baseQualityScore: 0.94,
    description: 'Official Vercel development and deployment skills',
  },
]

/**
 * Check if a skill should be excluded from indexing
 */
export function shouldExcludeSkill(author: HighTrustAuthor, skillName: string): boolean {
  // Check explicit exclusions
  if (author.excludeSkills?.includes(skillName)) {
    return true
  }

  // If includeSkills is set, exclude anything not in the list
  if (author.includeSkills && !author.includeSkills.includes(skillName)) {
    return true
  }

  return false
}

/**
 * Get the high-trust author config for a repository
 */
export function getHighTrustAuthor(owner: string, repo: string): HighTrustAuthor | undefined {
  return HIGH_TRUST_AUTHORS.find(
    (a) =>
      a.owner.toLowerCase() === owner.toLowerCase() && a.repo.toLowerCase() === repo.toLowerCase()
  )
}

/**
 * Check if a repository is from a high-trust author
 */
export function isHighTrustRepository(owner: string, repo: string): boolean {
  return getHighTrustAuthor(owner, repo) !== undefined
}
