/**
 * @fileoverview MCP Get Skill Tool for retrieving detailed skill information
 * @module @skillsmith/mcp-server/tools/get-skill
 * @see {@link https://github.com/wrsmith108/skillsmith|Skillsmith Repository}
 *
 * Retrieves comprehensive details for a specific skill including:
 * - Basic metadata (name, author, version, category)
 * - Quality scores with breakdown (quality, popularity, maintenance, security, documentation)
 * - Trust tier with explanation
 * - Repository link and tags
 * - Installation command
 *
 * @example
 * // Get skill by ID
 * const response = await executeGetSkill({ id: 'anthropic/commit' });
 * console.log(response.skill.description);
 *
 * @example
 * // Format for terminal display
 * const response = await executeGetSkill({ id: 'community/jest-helper' });
 * console.log(formatSkillDetails(response));
 */

import {
  type MCPSkill as Skill,
  type GetSkillResponse,
  type MCPTrustTier as TrustTier,
  TrustTierDescriptions,
  SkillsmithError,
  ErrorCodes,
} from '@skillsmith/core'

/**
 * Get skill tool schema for MCP
 */
export const getSkillToolSchema = {
  name: 'get_skill',
  description: 'Get full details for a specific skill by ID',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'The skill ID (e.g., "anthropic/commit" or UUID)',
      },
    },
    required: ['id'],
  },
}

/**
 * Mock skill database for development
 * In production, this would query the SQLite database
 */
const mockSkillDatabase: Record<string, Skill> = {
  'anthropic/commit': {
    id: 'anthropic/commit',
    name: 'commit',
    description:
      'Generate semantic commit messages following conventional commits specification. Analyzes staged changes and produces clear, descriptive commit messages.',
    author: 'anthropic',
    repository: 'https://github.com/anthropics/claude-code-skills',
    version: '1.2.0',
    category: 'development',
    trustTier: 'verified',
    score: 95,
    scoreBreakdown: {
      quality: 98,
      popularity: 95,
      maintenance: 92,
      security: 96,
      documentation: 94,
    },
    tags: ['git', 'commit', 'conventional-commits', 'automation'],
    installCommand: 'claude skill add anthropic/commit',
    createdAt: '2024-01-15T00:00:00Z',
    updatedAt: '2024-12-01T00:00:00Z',
  },
  'anthropic/review-pr': {
    id: 'anthropic/review-pr',
    name: 'review-pr',
    description:
      'Comprehensive pull request review with code analysis, security checks, and improvement suggestions. Provides actionable feedback for better code quality.',
    author: 'anthropic',
    repository: 'https://github.com/anthropics/claude-code-skills',
    version: '1.1.0',
    category: 'development',
    trustTier: 'verified',
    score: 93,
    scoreBreakdown: {
      quality: 95,
      popularity: 92,
      maintenance: 90,
      security: 95,
      documentation: 93,
    },
    tags: ['git', 'pull-request', 'code-review', 'quality'],
    installCommand: 'claude skill add anthropic/review-pr',
    createdAt: '2024-02-01T00:00:00Z',
    updatedAt: '2024-11-15T00:00:00Z',
  },
  'community/jest-helper': {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description:
      'Generate Jest test cases for React components with comprehensive coverage. Supports testing hooks, async operations, and component interactions.',
    author: 'community',
    repository: 'https://github.com/skillsmith-community/jest-helper',
    version: '2.0.1',
    category: 'testing',
    trustTier: 'community',
    score: 87,
    scoreBreakdown: {
      quality: 88,
      popularity: 90,
      maintenance: 85,
      security: 84,
      documentation: 88,
    },
    tags: ['jest', 'testing', 'react', 'unit-tests'],
    installCommand: 'claude skill add community/jest-helper',
    createdAt: '2024-03-10T00:00:00Z',
    updatedAt: '2024-10-20T00:00:00Z',
  },
}

/**
 * Input parameters for the get skill operation
 * @interface GetSkillInput
 */
export interface GetSkillInput {
  /** Skill ID in format "author/skill-name" or UUID */
  id: string
}

/**
 * Validate skill ID format.
 *
 * Accepts two formats:
 * - Author/name format: `anthropic/commit`, `community/jest-helper`
 * - UUID format: `550e8400-e29b-41d4-a716-446655440000`
 *
 * @param id - Skill ID to validate
 * @returns True if ID matches valid format
 * @internal
 */
function isValidSkillId(id: string): boolean {
  // Format: author/skill-name or UUID
  const authorSlashName = /^[a-z0-9-]+\/[a-z0-9-]+$/i
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  return authorSlashName.test(id) || uuid.test(id)
}

/**
 * Retrieve full details for a specific skill by ID.
 *
 * Fetches comprehensive skill information including metadata, quality scores,
 * trust tier, repository link, and installation command.
 *
 * @param input - Input containing the skill ID to retrieve
 * @returns Promise resolving to skill details and install command
 * @throws {SkillsmithError} VALIDATION_REQUIRED_FIELD - When ID is empty
 * @throws {SkillsmithError} SKILL_INVALID_ID - When ID format is invalid
 * @throws {SkillsmithError} SKILL_NOT_FOUND - When skill doesn't exist
 *
 * @example
 * // Get a verified skill
 * const response = await executeGetSkill({ id: 'anthropic/commit' });
 * console.log(response.skill.score); // 95
 * console.log(response.installCommand); // 'claude skill add anthropic/commit'
 *
 * @example
 * // Handle not found
 * try {
 *   await executeGetSkill({ id: 'unknown/skill' });
 * } catch (error) {
 *   if (error.code === 'SKILL_NOT_FOUND') {
 *     console.log(error.suggestion); // 'Try searching for similar skills...'
 *   }
 * }
 */
export async function executeGetSkill(input: GetSkillInput): Promise<GetSkillResponse> {
  const startTime = performance.now()

  // Validate input
  if (!input.id || input.id.trim().length === 0) {
    throw new SkillsmithError(ErrorCodes.VALIDATION_REQUIRED_FIELD, 'Skill ID is required', {
      details: { field: 'id' },
    })
  }

  const skillId = input.id.trim().toLowerCase()

  // Validate ID format
  if (!isValidSkillId(skillId)) {
    throw new SkillsmithError(
      ErrorCodes.SKILL_INVALID_ID,
      'Invalid skill ID format: "' + input.id + '"',
      {
        details: { id: input.id },
        suggestion:
          'Skill IDs should be in format "author/skill-name" (e.g., "anthropic/commit") or a valid UUID',
      }
    )
  }

  // Look up skill
  const skill = mockSkillDatabase[skillId]

  if (!skill) {
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, 'Skill "' + input.id + '" not found', {
      details: { id: input.id },
      suggestion: 'Try searching for similar skills with the search tool',
    })
  }

  const endTime = performance.now()

  return {
    skill,
    installCommand: skill.installCommand || 'claude skill add ' + skill.id,
    timing: {
      totalMs: Math.round(endTime - startTime),
    },
  }
}

/**
 * Format skill details for terminal/CLI display.
 *
 * Produces a comprehensive human-readable string including:
 * - Basic info (ID, author, version, category)
 * - Full description
 * - Trust tier with explanation
 * - Visual score breakdown bars
 * - Repository and tags
 * - Installation command
 *
 * @param response - Get skill response from executeGetSkill
 * @returns Formatted string suitable for terminal output
 *
 * @example
 * const response = await executeGetSkill({ id: 'anthropic/commit' });
 * console.log(formatSkillDetails(response));
 * // Output:
 * // === commit ===
 * // ID: anthropic/commit
 * // Author: anthropic
 * // Version: 1.2.0
 * // ...
 */
export function formatSkillDetails(response: GetSkillResponse): string {
  const skill = response.skill
  const lines: string[] = []

  lines.push('\n=== ' + skill.name + ' ===\n')

  // Basic info
  lines.push('ID: ' + skill.id)
  lines.push('Author: ' + skill.author)
  lines.push('Version: ' + (skill.version || 'N/A'))
  lines.push('Category: ' + skill.category)
  lines.push('')

  // Description
  lines.push('Description:')
  lines.push('  ' + skill.description)
  lines.push('')

  // Trust tier with explanation
  lines.push('Trust Tier: ' + formatTrustTier(skill.trustTier))
  lines.push('  ' + TrustTierDescriptions[skill.trustTier])
  lines.push('')

  // Score breakdown
  lines.push('Overall Score: ' + skill.score + '/100')
  if (skill.scoreBreakdown) {
    lines.push('Score Breakdown:')
    lines.push('  Quality:       ' + formatScoreBar(skill.scoreBreakdown.quality))
    lines.push('  Popularity:    ' + formatScoreBar(skill.scoreBreakdown.popularity))
    lines.push('  Maintenance:   ' + formatScoreBar(skill.scoreBreakdown.maintenance))
    lines.push('  Security:      ' + formatScoreBar(skill.scoreBreakdown.security))
    lines.push('  Documentation: ' + formatScoreBar(skill.scoreBreakdown.documentation))
  }
  lines.push('')

  // Repository
  if (skill.repository) {
    lines.push('Repository: ' + skill.repository)
  }

  // Tags
  if (skill.tags && skill.tags.length > 0) {
    lines.push('Tags: ' + skill.tags.join(', '))
  }
  lines.push('')

  // Installation
  lines.push('--- Installation ---')
  lines.push('  ' + response.installCommand)
  lines.push('')

  // Timing
  lines.push('---')
  lines.push('Retrieved in ' + response.timing.totalMs + 'ms')

  return lines.join('\n')
}

/**
 * Format trust tier with visual indicator
 */
function formatTrustTier(tier: TrustTier): string {
  switch (tier) {
    case 'verified':
      return '[*] VERIFIED'
    case 'community':
      return '[+] COMMUNITY'
    case 'standard':
      return '[=] STANDARD'
    case 'unverified':
      return '[?] UNVERIFIED'
  }
}

/**
 * Format score as a visual bar
 */
function formatScoreBar(score: number): string {
  const filled = Math.round(score / 10)
  const empty = 10 - filled
  const bar = '='.repeat(filled) + '-'.repeat(empty)
  return '[' + bar + '] ' + score + '/100'
}
