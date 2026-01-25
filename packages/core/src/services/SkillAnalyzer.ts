/**
 * SMI-1788: SkillAnalyzer - Analyze skills for optimization patterns
 *
 * Detects optimization opportunities based on:
 * - Line count (>500 lines suggests decomposition)
 * - Tool usage patterns (heavy tool usage suggests subagent)
 * - Sequential Task() calls (can be parallelized)
 * - Large examples sections (can use progressive disclosure)
 *
 * Part of the Skillsmith Optimization Layer for transforming
 * community skills into more performant versions.
 */

// Re-export types for public API
export type {
  SkillAnalysis,
  ToolUsageAnalysis,
  TaskPatternAnalysis,
  ExtractableSection,
  OptimizationRecommendation,
  ParsedSection,
  ConfidenceLevel,
} from './SkillAnalyzer.types.js'

// Internal imports
import type {
  SkillAnalysis,
  ToolUsageAnalysis,
  TaskPatternAnalysis,
  ExtractableSection,
  OptimizationRecommendation,
  ParsedSection,
} from './SkillAnalyzer.types.js'

import {
  THRESHOLDS,
  detectTools,
  countCommandPatterns,
  shouldSuggestSubagent,
  getConfidenceLevel,
  estimateExamplesLines,
  countSequentialTaskCalls,
  calculateBatchSavings,
  getExtractionReason,
  calculateExtractionPriority,
} from './SkillAnalyzer.helpers.js'

// Re-export helpers for testing and advanced usage
export {
  TOOL_PATTERNS,
  THRESHOLDS,
  escapeRegex,
  getConfidenceLevel,
} from './SkillAnalyzer.helpers.js'

/**
 * Analyze a skill's content for optimization opportunities
 *
 * @param content - The full SKILL.md content
 * @returns Analysis of optimization potential
 * @remarks The lineCount for an empty string returns 1, matching standard
 * String.split('\n') behavior where ''.split('\n') yields ['']
 */
export function analyzeSkill(content: string): SkillAnalysis {
  const lines = content.split('\n')
  const lineCount = lines.length

  // Analyze sections
  const { mainContentLines, examplesLines, sections } = analyzeSections(content)

  // Analyze tool usage
  const toolUsage = analyzeToolUsage(content)

  // Analyze Task() patterns
  const taskPatterns = analyzeTaskPatterns(content)

  // Find extractable sections
  const extractableSections = findExtractableSections(sections, lineCount)

  // Generate recommendations
  const recommendations = generateRecommendations(
    lineCount,
    examplesLines,
    toolUsage,
    taskPatterns,
    extractableSections
  )

  // Calculate optimization score
  const optimizationScore = calculateOptimizationScore(
    lineCount,
    toolUsage,
    taskPatterns,
    recommendations
  )

  return {
    lineCount,
    mainContentLines,
    examplesLines,
    toolUsage,
    taskPatterns,
    extractableSections,
    recommendations,
    optimizationScore,
    shouldTransform: optimizationScore >= THRESHOLDS.minTransformScore,
  }
}

/**
 * Analyze sections within the skill content
 */
function analyzeSections(content: string): {
  mainContentLines: number
  examplesLines: number
  sections: ParsedSection[]
} {
  const lines = content.split('\n')
  const sections: ParsedSection[] = []

  let currentSection: { name: string; startLine: number; lines: string[] } | null = null
  let examplesStartLine = -1
  let examplesEndLine = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/)

    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        sections.push({
          name: currentSection.name,
          startLine: currentSection.startLine,
          endLine: i - 1,
          content: currentSection.lines.join('\n'),
        })
      }

      currentSection = {
        name: headerMatch[2].trim(),
        startLine: i,
        lines: [],
      }

      // Track examples section
      const sectionName = headerMatch[2].toLowerCase()
      if (sectionName.includes('example') || sectionName.includes('usage')) {
        examplesStartLine = i
      }
    }

    if (currentSection) {
      currentSection.lines.push(line)
    }
  }

  // Save last section
  if (currentSection) {
    sections.push({
      name: currentSection.name,
      startLine: currentSection.startLine,
      endLine: lines.length - 1,
      content: currentSection.lines.join('\n'),
    })

    if (examplesStartLine >= 0 && examplesEndLine < 0) {
      examplesEndLine = lines.length - 1
    }
  }

  // Calculate line counts
  const examplesLines =
    examplesStartLine >= 0
      ? examplesEndLine - examplesStartLine + 1
      : estimateExamplesLines(content)
  const mainContentLines = lines.length - examplesLines

  return { mainContentLines, examplesLines, sections }
}

/**
 * Analyze tool usage patterns in the content
 */
function analyzeToolUsage(content: string): ToolUsageAnalysis {
  const { tools: detectedTools, totalWeight } = detectTools(content)
  const { bashCommandCount, fileReadCount, fileWriteCount } = countCommandPatterns(content)

  const suggestsSubagent = shouldSuggestSubagent(
    bashCommandCount,
    fileReadCount + fileWriteCount,
    totalWeight
  )

  const confidence = getConfidenceLevel(detectedTools.length)

  return {
    detectedTools,
    bashCommandCount,
    fileReadCount,
    fileWriteCount,
    suggestsSubagent,
    confidence,
  }
}

/**
 * Analyze Task() call patterns
 */
function analyzeTaskPatterns(content: string): TaskPatternAnalysis {
  const taskCalls = content.match(/Task\s*\([^)]+\)/g) || []
  const taskCallCount = taskCalls.length

  const sequentialCalls = countSequentialTaskCalls(content)
  const canBatch = sequentialCalls >= THRESHOLDS.sequentialTaskThreshold
  const batchSavingsPercent = calculateBatchSavings(sequentialCalls)

  return {
    taskCallCount,
    sequentialCalls,
    canBatch,
    batchSavingsPercent,
  }
}

/**
 * Find sections that could be extracted as sub-skills
 */
function findExtractableSections(
  sections: ParsedSection[],
  totalLines: number
): ExtractableSection[] {
  const extractable: ExtractableSection[] = []

  for (const section of sections) {
    const lineCount = section.endLine - section.startLine + 1

    // Skip small sections
    if (lineCount < THRESHOLDS.minSectionLines) {
      continue
    }

    const priority = calculateExtractionPriority(lineCount, totalLines)
    const reason = getExtractionReason(section.name, lineCount)

    extractable.push({
      name: section.name,
      startLine: section.startLine,
      endLine: section.endLine,
      lineCount,
      priority,
      reason,
    })
  }

  // Sort by priority
  return extractable.sort((a, b) => a.priority - b.priority)
}

/**
 * Generate optimization recommendations
 */
function generateRecommendations(
  lineCount: number,
  examplesLines: number,
  toolUsage: ToolUsageAnalysis,
  taskPatterns: TaskPatternAnalysis,
  extractableSections: ExtractableSection[]
): OptimizationRecommendation[] {
  const recommendations: OptimizationRecommendation[] = []

  // Recommend decomposition for large skills
  if (lineCount > THRESHOLDS.maxLinesBeforeDecompose) {
    const sectionNames = extractableSections.slice(0, 3).map((s) => s.name)
    recommendations.push({
      type: 'decompose',
      description: `Skill has ${lineCount} lines (threshold: ${THRESHOLDS.maxLinesBeforeDecompose}). Decompose into main SKILL.md + sub-skills.`,
      estimatedSavings: Math.min(70, Math.floor((lineCount - 400) / 10)),
      priority: 1,
      affectedAreas: sectionNames.length > 0 ? sectionNames : ['full-content'],
    })
  }

  // Recommend subagent for heavy tool usage
  if (toolUsage.suggestsSubagent) {
    recommendations.push({
      type: 'subagent',
      description: `Heavy tool usage detected (${toolUsage.bashCommandCount} bash, ${toolUsage.fileReadCount} reads). Generate companion subagent for context isolation.`,
      estimatedSavings: 40,
      priority: 2,
      affectedAreas: toolUsage.detectedTools,
    })
  }

  // Recommend parallelization for sequential Task() calls
  if (taskPatterns.canBatch) {
    recommendations.push({
      type: 'parallelize',
      description: `${taskPatterns.sequentialCalls} sequential Task() calls detected. Batch into single message for parallel execution.`,
      estimatedSavings: taskPatterns.batchSavingsPercent,
      priority: 2,
      affectedAreas: ['Task-calls'],
    })
  }

  // Recommend progressive disclosure for large examples
  if (examplesLines > THRESHOLDS.largeExamplesThreshold) {
    recommendations.push({
      type: 'progressive-disclosure',
      description: `Large examples section (${examplesLines} lines). Move to sub-skill for on-demand loading.`,
      estimatedSavings: Math.min(60, Math.floor(examplesLines / 5)),
      priority: 3,
      affectedAreas: ['examples'],
    })
  }

  // Sort by priority
  return recommendations.sort((a, b) => a.priority - b.priority)
}

/**
 * Calculate overall optimization score
 */
function calculateOptimizationScore(
  lineCount: number,
  toolUsage: ToolUsageAnalysis,
  taskPatterns: TaskPatternAnalysis,
  recommendations: OptimizationRecommendation[]
): number {
  let score = 0

  // Line count factor (0-40 points)
  if (lineCount > THRESHOLDS.maxLinesBeforeDecompose) {
    score += Math.min(40, Math.floor((lineCount - 400) / 10))
  } else if (lineCount > 300) {
    score += Math.floor((lineCount - 300) / 20)
  }

  // Tool usage factor (0-30 points)
  if (toolUsage.suggestsSubagent) {
    score += 20
  }
  score += Math.min(10, toolUsage.detectedTools.length * 2)

  // Task pattern factor (0-20 points)
  if (taskPatterns.canBatch) {
    score += Math.min(20, taskPatterns.sequentialCalls * 5)
  }

  // Recommendation impact (0-10 points)
  score += Math.min(10, recommendations.length * 3)

  return Math.min(100, score)
}

/**
 * Quick check if a skill needs transformation without full analysis
 *
 * @param content - The full SKILL.md content
 * @returns Whether quick transformation check passed
 */
export function quickTransformCheck(content: string): boolean {
  const lineCount = content.split('\n').length

  // Quick checks that indicate transformation needed
  if (lineCount > THRESHOLDS.maxLinesBeforeDecompose) {
    return true
  }

  // Check for heavy tool usage patterns
  const heavyToolPatterns = ['npm ', 'npx ', 'git ', 'docker', 'Bash(']
  let heavyToolCount = 0
  for (const pattern of heavyToolPatterns) {
    if (content.includes(pattern)) {
      heavyToolCount++
    }
  }
  if (heavyToolCount >= 3) {
    return true
  }

  // Check for sequential Task() calls
  const taskMatches = content.match(/Task\s*\(/g) || []
  if (taskMatches.length >= THRESHOLDS.sequentialTaskThreshold) {
    return true
  }

  return false
}

export default { analyzeSkill, quickTransformCheck }
