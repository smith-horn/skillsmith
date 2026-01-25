/**
 * SMI-1788: SkillDecomposer - Decompose large skills into sub-skills
 *
 * Transforms skills >500 lines into a main SKILL.md + sub-skills structure
 * following the Skillsmith optimization standard:
 * - Main SKILL.md: <500 lines, contains header + navigation + core content
 * - Sub-skills: Extracted sections loaded on-demand
 *
 * Part of the Skillsmith Optimization Layer for transforming
 * community skills into more performant versions.
 */

import type { SkillAnalysis } from './SkillAnalyzer.js'

// Re-export types for public API
export type {
  DecompositionResult,
  DecomposedSkill,
  SubSkill,
  DecompositionStats,
  SkillMetadata,
  DecomposerOptions,
} from './SkillDecomposer.types.js'

// Internal imports
import type { DecompositionResult, DecomposerOptions } from './SkillDecomposer.types.js'

import {
  DEFAULT_OPTIONS,
  resolveOptions,
  parseSkillContent,
  determineSectionsToExtract,
  createSubSkills,
  createMainSkill,
  calculateStats,
  addAttributionToContent,
  formatBatchedTasks,
} from './SkillDecomposer.helpers.js'

// Re-export helpers for testing and advanced usage
export { DEFAULT_EXTRACT_KEYWORDS, sanitizeFilename } from './SkillDecomposer.helpers.js'

/**
 * Decompose a skill into main + sub-skills based on analysis
 *
 * @param content - The original SKILL.md content
 * @param analysis - Analysis from SkillAnalyzer
 * @param options - Decomposition options
 * @returns Decomposition result with main skill and sub-skills
 */
export function decomposeSkill(
  content: string,
  analysis: SkillAnalysis,
  options?: DecomposerOptions
): DecompositionResult {
  const opts = resolveOptions(options)

  // If skill doesn't need decomposition, return as-is with attribution
  if (!analysis.shouldTransform || analysis.lineCount <= opts.maxMainSkillLines) {
    return createNonDecomposedResult(content, analysis, opts)
  }

  // Parse the skill content
  const { metadata, sections, frontmatter } = parseSkillContent(content)

  // Determine which sections to extract
  const sectionsToExtract = determineSectionsToExtract(sections, analysis.extractableSections, opts)

  // Create sub-skills from extracted sections
  const subSkills = createSubSkills(sectionsToExtract, metadata.name || 'skill')

  // Create the main skill with remaining content
  const mainSkill = createMainSkill(frontmatter, sections, sectionsToExtract, subSkills, opts)

  // Calculate statistics
  const stats = calculateStats(content, mainSkill, subSkills)

  return {
    mainSkill,
    subSkills,
    wasDecomposed: true,
    stats,
  }
}

/**
 * Create result for skills that don't need decomposition
 */
function createNonDecomposedResult(
  content: string,
  analysis: SkillAnalysis,
  opts: typeof DEFAULT_OPTIONS
): DecompositionResult {
  let finalContent = content

  // Add attribution if enabled
  if (opts.addAttribution && !content.includes('Optimized by Skillsmith')) {
    finalContent = addAttributionToContent(content)
  }

  return {
    mainSkill: {
      filename: 'SKILL.md',
      content: finalContent,
      lineCount: finalContent.split('\n').length,
      subSkillRefs: [],
    },
    subSkills: [],
    wasDecomposed: false,
    stats: {
      originalLines: analysis.lineCount,
      mainSkillLines: finalContent.split('\n').length,
      subSkillLines: 0,
      subSkillCount: 0,
      tokenReductionPercent: 0,
    },
  }
}

/**
 * Parallelize sequential Task() calls in skill content
 *
 * @param content - The skill content
 * @returns Content with Task() calls batched for parallel execution
 */
export function parallelizeTaskCalls(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  const taskBuffer: string[] = []
  let inCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Track code blocks
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock

      // Flush task buffer before code blocks
      if (taskBuffer.length > 0) {
        result.push(...formatBatchedTasks(taskBuffer))
        taskBuffer.length = 0
      }
      result.push(line)
      continue
    }

    // In code blocks, look for sequential Task() calls
    if (inCodeBlock && line.includes('Task(')) {
      taskBuffer.push(line)
      continue
    }

    // Flush task buffer when we hit a non-Task line in code block
    if (inCodeBlock && taskBuffer.length > 0 && !line.includes('Task(')) {
      result.push(...formatBatchedTasks(taskBuffer))
      taskBuffer.length = 0
    }

    result.push(line)
  }

  // Flush any remaining tasks
  if (taskBuffer.length > 0) {
    result.push(...formatBatchedTasks(taskBuffer))
  }

  return result.join('\n')
}

export default { decomposeSkill, parallelizeTaskCalls }
