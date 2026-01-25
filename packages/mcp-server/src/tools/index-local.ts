/**
 * @fileoverview MCP Tool for indexing local skills from ~/.claude/skills/
 * @module @skillsmith/mcp-server/tools/index-local
 * @see SMI-1809: Local skill indexing for MCP server
 *
 * Provides manual re-indexing of local skills with detailed results.
 *
 * @example
 * // Trigger re-indexing
 * const result = await executeIndexLocal({}, context);
 * console.log(`Indexed ${result.count} skills`);
 *
 * @example
 * // Force re-index (bypass cache)
 * const result = await executeIndexLocal({ force: true }, context);
 */

import { z } from 'zod'
import { LocalIndexer, type LocalSkill } from '../indexer/LocalIndexer.js'
import type { ToolContext } from '../context.js'

/**
 * Tool schema for MCP
 */
export const indexLocalToolSchema = {
  name: 'index_local',
  description:
    'Index local skills from ~/.claude/skills/ directory. Returns count and details of indexed skills.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      force: {
        type: 'boolean',
        description: 'Force re-indexing even if cache is valid (default: false)',
      },
      skillsDir: {
        type: 'string',
        description: 'Custom skills directory path (defaults to ~/.claude/skills/)',
      },
    },
    required: [],
  },
}

/**
 * Zod schema for input validation
 */
export const indexLocalInputSchema = z.object({
  force: z.boolean().optional().default(false),
  skillsDir: z.string().optional(),
})

/**
 * Input parameters for the index_local operation
 */
export interface IndexLocalInput {
  /** Force re-indexing even if cache is valid */
  force?: boolean
  /** Custom skills directory path */
  skillsDir?: string
}

/**
 * Summary of an indexed skill for response
 */
export interface IndexedSkillSummary {
  /** Skill ID (local/{name}) */
  id: string
  /** Skill name */
  name: string
  /** Quality score (0-100) */
  qualityScore: number
  /** Whether SKILL.md was found */
  hasSkillMd: boolean
  /** Number of tags */
  tagCount: number
}

/**
 * Response from index_local operation
 */
export interface IndexLocalResponse {
  /** Number of skills indexed */
  count: number
  /** Path to skills directory */
  skillsDir: string
  /** Summary of indexed skills */
  skills: IndexedSkillSummary[]
  /** Timing information */
  timing: {
    indexMs: number
    totalMs: number
  }
  /** Whether result was from cache */
  fromCache: boolean
}

/**
 * Execute local skill indexing.
 *
 * Scans ~/.claude/skills/ (or custom directory), parses SKILL.md files,
 * and returns indexed skill information.
 *
 * @param input - Index parameters
 * @param _context - Tool context (unused but required for consistency)
 * @returns Promise resolving to index response
 *
 * @example
 * const response = await executeIndexLocal({}, context);
 * console.log(`Found ${response.count} local skills`);
 */
export async function executeIndexLocal(
  input: IndexLocalInput,
  _context: ToolContext
): Promise<IndexLocalResponse> {
  const startTime = performance.now()
  const indexStart = performance.now()

  // Create indexer with optional custom directory
  const indexer = new LocalIndexer(input.skillsDir)

  // Check if we'll get cached results
  const wasCached = !input.force && indexer['cachedSkills'] !== null

  // Perform indexing
  const skills: LocalSkill[] = await indexer.index(input.force)

  const indexEnd = performance.now()

  // Create summaries
  const summaries: IndexedSkillSummary[] = skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    qualityScore: skill.qualityScore,
    hasSkillMd: skill.hasSkillMd,
    tagCount: skill.tags.length,
  }))

  const endTime = performance.now()

  return {
    count: skills.length,
    skillsDir: indexer.getSkillsDir(),
    skills: summaries,
    timing: {
      indexMs: Math.round(indexEnd - indexStart),
      totalMs: Math.round(endTime - startTime),
    },
    fromCache: wasCached && !input.force,
  }
}

/**
 * Format index results for terminal/CLI display.
 *
 * @param response - Index response from executeIndexLocal
 * @returns Formatted string suitable for terminal output
 */
export function formatIndexLocalResults(response: IndexLocalResponse): string {
  const lines: string[] = []

  lines.push('\n=== Local Skills Index ===\n')
  lines.push(`Directory: ${response.skillsDir}`)
  lines.push(`Found: ${response.count} skill(s)`)

  if (response.fromCache) {
    lines.push('(from cache)')
  }

  lines.push('')

  if (response.skills.length === 0) {
    lines.push('No skills found in the local skills directory.')
    lines.push('')
    lines.push('To add skills:')
    lines.push('  1. Create a directory in ~/.claude/skills/')
    lines.push('  2. Add a SKILL.md file with frontmatter')
    lines.push('')
  } else {
    for (const skill of response.skills) {
      const quality = skill.qualityScore >= 80 ? '[HIGH]' : skill.qualityScore >= 50 ? '[MED]' : '[LOW]'
      const skillMd = skill.hasSkillMd ? '' : ' (no SKILL.md)'
      lines.push(`  ${skill.name} ${quality} - Score: ${skill.qualityScore}/100${skillMd}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push(`Index: ${response.timing.indexMs}ms | Total: ${response.timing.totalMs}ms`)

  return lines.join('\n')
}
