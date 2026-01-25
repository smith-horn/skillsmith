/**
 * SMI-1788: SkillAnalyzer Helpers
 *
 * Tool detection patterns, thresholds, and utility functions
 * for skill analysis and optimization.
 */

import type { ConfidenceLevel } from './SkillAnalyzer.types.js'

/**
 * Tool detection patterns for analyzing skill content
 */
export const TOOL_PATTERNS: Record<string, { patterns: string[]; weight: number }> = {
  Read: {
    patterns: ['read file', 'read the file', 'examine', 'view file', 'cat ', 'Read tool'],
    weight: 1,
  },
  Write: {
    patterns: [
      'write file',
      'create file',
      'save to',
      'output to file',
      'Write tool',
      'write the file',
    ],
    weight: 2,
  },
  Edit: {
    patterns: ['edit file', 'modify file', 'update file', 'patch', 'Edit tool', 'replace in'],
    weight: 2,
  },
  Bash: {
    patterns: [
      'bash',
      'npm ',
      'npx ',
      'git ',
      'docker',
      'yarn ',
      'pnpm ',
      'execute command',
      'run command',
      'terminal',
      'shell',
      'Bash tool',
    ],
    weight: 3,
  },
  Grep: {
    patterns: ['grep', 'search for', 'find text', 'pattern match', 'Grep tool'],
    weight: 1,
  },
  Glob: {
    patterns: ['glob', 'find file', 'file pattern', 'list files', 'Glob tool'],
    weight: 1,
  },
  WebFetch: {
    patterns: ['fetch', 'http', 'api call', 'url', 'WebFetch', 'download', 'request'],
    weight: 2,
  },
  WebSearch: {
    patterns: ['web search', 'search online', 'lookup online', 'WebSearch'],
    weight: 2,
  },
  Task: {
    patterns: ['Task(', 'Task tool', 'spawn agent', 'delegate to', 'subagent'],
    weight: 3,
  },
}

/**
 * Thresholds for optimization decisions
 */
export const THRESHOLDS = {
  /** Maximum lines before recommending decomposition */
  maxLinesBeforeDecompose: 500,

  /** Minimum lines for an extractable section */
  minSectionLines: 50,

  /** Heavy tool usage count that suggests subagent */
  heavyToolUsageCount: 5,

  /** Sequential Task() calls that should be parallelized */
  sequentialTaskThreshold: 2,

  /** Minimum optimization score to recommend transformation */
  minTransformScore: 30,

  /** Large examples section threshold */
  largeExamplesThreshold: 200,
} as const

/**
 * Escape special regex characters in a string
 * @param str - String to escape
 * @returns Escaped string safe for use in RegExp
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Determine confidence level based on match count
 * @param matchCount - Number of detected tools
 * @returns Confidence level
 */
export function getConfidenceLevel(matchCount: number): ConfidenceLevel {
  if (matchCount >= 4) return 'high'
  if (matchCount >= 2) return 'medium'
  return 'low'
}

/**
 * Estimate examples lines by looking for code blocks
 * @param content - Full skill content
 * @returns Estimated number of lines in code blocks
 */
export function estimateExamplesLines(content: string): number {
  const codeBlockMatches = content.match(/```[\s\S]*?```/g) || []
  let totalLines = 0

  for (const block of codeBlockMatches) {
    totalLines += block.split('\n').length
  }

  return totalLines
}

/**
 * Detect tools in content
 * @param content - Skill content to analyze
 * @returns Object with detected tools and total weight
 */
export function detectTools(content: string): { tools: string[]; totalWeight: number } {
  const detectedTools: string[] = []
  let totalWeight = 0

  for (const [tool, config] of Object.entries(TOOL_PATTERNS)) {
    for (const pattern of config.patterns) {
      // Use word-boundary regex to avoid false positives
      const regex = new RegExp(`\\b${escapeRegex(pattern)}\\b`, 'i')
      if (regex.test(content)) {
        if (!detectedTools.includes(tool)) {
          detectedTools.push(tool)
          totalWeight += config.weight
        }
        break
      }
    }
  }

  return { tools: detectedTools, totalWeight }
}

/**
 * Count specific command patterns in content
 * @param content - Skill content to analyze
 * @returns Counts for bash, read, and write commands
 */
export function countCommandPatterns(content: string): {
  bashCommandCount: number
  fileReadCount: number
  fileWriteCount: number
} {
  const bashCommandCount = (content.match(/\b(npm|npx|git|docker|yarn|pnpm)\s/gi) || []).length
  const fileReadCount = (content.match(/\b(read|cat|head|tail|grep|find)\s/gi) || []).length
  const fileWriteCount = (content.match(/\b(write|edit|modify|create)\s+file/gi) || []).length

  return { bashCommandCount, fileReadCount, fileWriteCount }
}

/**
 * Determine if tool usage suggests a subagent would be beneficial
 * @param bashCount - Number of bash commands
 * @param fileOpCount - Total file operations (read + write)
 * @param totalWeight - Total tool weight
 * @returns Whether subagent is suggested
 */
export function shouldSuggestSubagent(
  bashCount: number,
  fileOpCount: number,
  totalWeight: number
): boolean {
  return (
    bashCount >= THRESHOLDS.heavyToolUsageCount ||
    fileOpCount >= THRESHOLDS.heavyToolUsageCount ||
    totalWeight >= 10
  )
}

/**
 * Count sequential Task() calls in content
 * @param content - Skill content to analyze
 * @returns Count of sequential Task calls
 */
export function countSequentialTaskCalls(content: string): number {
  const lines = content.split('\n')
  let sequentialCalls = 0
  let consecutiveTaskLines = 0

  for (const line of lines) {
    if (line.includes('Task(') || line.includes('Task (')) {
      consecutiveTaskLines++
    } else if (consecutiveTaskLines > 0) {
      if (consecutiveTaskLines >= THRESHOLDS.sequentialTaskThreshold) {
        sequentialCalls += consecutiveTaskLines
      }
      consecutiveTaskLines = 0
    }
  }

  // Check for final sequence
  if (consecutiveTaskLines >= THRESHOLDS.sequentialTaskThreshold) {
    sequentialCalls += consecutiveTaskLines
  }

  return sequentialCalls
}

/**
 * Calculate batch savings percentage
 * @param sequentialCalls - Number of sequential Task calls
 * @returns Estimated savings percentage
 */
export function calculateBatchSavings(sequentialCalls: number): number {
  // Batching reduces context overhead by ~30-50%
  return sequentialCalls >= THRESHOLDS.sequentialTaskThreshold
    ? Math.min(50, sequentialCalls * 10)
    : 0
}

/**
 * Determine extraction reason for a section
 * @param sectionName - Name of the section
 * @param lineCount - Number of lines in section
 * @returns Human-readable extraction reason
 */
export function getExtractionReason(sectionName: string, lineCount: number): string {
  const lowerName = sectionName.toLowerCase()

  if (lowerName.includes('api') || lowerName.includes('reference')) {
    return 'API reference sections can be loaded on-demand'
  }
  if (lowerName.includes('example') || lowerName.includes('usage')) {
    return 'Examples can be progressively disclosed'
  }
  if (lowerName.includes('advanced') || lowerName.includes('configuration')) {
    return 'Advanced topics are rarely needed in initial context'
  }
  if (lineCount > 100) {
    return 'Large section suitable for sub-skill extraction'
  }
  return 'Section size suggests separate loading benefit'
}

/**
 * Calculate extraction priority based on size ratio
 * @param lineCount - Section line count
 * @param totalLines - Total document lines
 * @returns Priority (1 = highest, 3 = lowest)
 */
export function calculateExtractionPriority(lineCount: number, totalLines: number): number {
  const sizeRatio = lineCount / totalLines

  if (sizeRatio > 0.3) return 1
  if (sizeRatio > 0.15) return 2
  return 3
}
