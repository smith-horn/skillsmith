/**
 * @fileoverview Skillsmith Optimization Layer for skill installation
 * @module @skillsmith/mcp-server/tools/install.optimize
 * @see SMI-1788: Apply Skillsmith Optimization Layer
 * @see SMI-2741: Split from install.ts to meet 500-line standard
 *
 * Handles the optional Skillsmith optimization step during skill installation:
 * - Decomposition via TransformationService
 * - Sub-skill generation
 * - Subagent companion generation
 * - CLAUDE.md snippet generation
 */

import { TransformationService } from '@skillsmith/core'
import type { Database } from '@skillsmith/core'
import type { OptimizationInfo } from './install.types.js'

/**
 * Result of applying the Skillsmith optimization layer
 */
export interface OptimizeResult {
  /** Final (possibly transformed) SKILL.md content */
  finalSkillContent: string
  /** Generated sub-skill files */
  subSkillFiles: Array<{ filename: string; content: string }>
  /** Generated subagent content (optional) */
  subagentContent: string | undefined
  /** Generated CLAUDE.md snippet (optional) */
  claudeMdSnippet: string | undefined
  /** Optimization metadata */
  optimizationInfo: OptimizationInfo
}

/**
 * Apply Skillsmith Optimization Layer to a skill's content.
 *
 * SMI-1788: Runs the TransformationService to decompose and optimize the skill.
 * Falls back to original content if transformation fails.
 *
 * @param skillId - Skill identifier for the transformation
 * @param skillName - Extracted skill name
 * @param skillMdContent - Raw SKILL.md content
 * @param db - Database instance for caching
 * @returns Optimization result with transformed content and metadata
 */
export async function applySkillOptimization(
  skillId: string,
  skillName: string,
  skillMdContent: string,
  db: Database
): Promise<OptimizeResult> {
  try {
    const transformService = new TransformationService(db, {
      cacheTtl: 3600, // 1 hour cache
      version: '1.0.0',
    })

    // Extract skill name and description for transformation
    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m)
    const descMatch = skillMdContent.match(/^description:\s*(.+)$/m)
    const extractedName = nameMatch ? nameMatch[1].trim() : skillName
    const extractedDesc = descMatch ? descMatch[1].trim() : ''

    const transformResult = await transformService.transform(
      skillId,
      extractedName,
      extractedDesc,
      skillMdContent
    )

    if (transformResult.transformed) {
      return {
        finalSkillContent: transformResult.mainSkillContent,
        subSkillFiles: transformResult.subSkills,
        subagentContent: transformResult.subagent?.content,
        claudeMdSnippet: transformResult.claudeMdSnippet,
        optimizationInfo: {
          optimized: true,
          subSkills: transformResult.subSkills.map((s) => s.filename),
          subagentGenerated: !!transformResult.subagent?.content,
          tokenReductionPercent: transformResult.stats.tokenReductionPercent,
          originalLines: transformResult.stats.originalLines,
          optimizedLines: transformResult.stats.optimizedLines,
        },
      }
    }
  } catch (transformError) {
    // Transformation failed - continue with original content
    console.warn('[install] Optimization failed, using original content:', transformError)
  }

  return {
    finalSkillContent: skillMdContent,
    subSkillFiles: [],
    subagentContent: undefined,
    claudeMdSnippet: undefined,
    optimizationInfo: { optimized: false },
  }
}
