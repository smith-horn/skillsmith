/**
 * SMI-1788: SkillAnalyzer Types
 *
 * Type definitions for skill analysis and optimization detection.
 * Used by the Skillsmith Optimization Layer for transforming
 * community skills into more performant versions.
 */

/**
 * Analysis result for a skill's optimization potential
 */
export interface SkillAnalysis {
  /** Total line count of the skill content */
  lineCount: number

  /** Number of lines in the main content (excluding examples) */
  mainContentLines: number

  /** Number of lines in examples section */
  examplesLines: number

  /** Tools detected in the skill content */
  toolUsage: ToolUsageAnalysis

  /** Task() call patterns detected */
  taskPatterns: TaskPatternAnalysis

  /** Sections that could be extracted as sub-skills */
  extractableSections: ExtractableSection[]

  /** Recommended optimizations to apply */
  recommendations: OptimizationRecommendation[]

  /** Overall optimization score (0-100) */
  optimizationScore: number

  /** Whether this skill would benefit from transformation */
  shouldTransform: boolean
}

/**
 * Tool usage analysis result
 */
export interface ToolUsageAnalysis {
  /** List of detected tools */
  detectedTools: string[]

  /** Number of Bash commands detected */
  bashCommandCount: number

  /** Number of file reads detected (Read/Glob/Grep) */
  fileReadCount: number

  /** Number of file writes detected (Write/Edit) */
  fileWriteCount: number

  /** Whether heavy tool usage suggests subagent */
  suggestsSubagent: boolean

  /** Confidence in tool detection */
  confidence: 'high' | 'medium' | 'low'
}

/**
 * Task() call pattern analysis
 */
export interface TaskPatternAnalysis {
  /** Total number of Task() calls detected */
  taskCallCount: number

  /** Number of sequential Task() calls that could be parallelized */
  sequentialCalls: number

  /** Whether Task() calls can be batched */
  canBatch: boolean

  /** Estimated token savings from batching (percentage) */
  batchSavingsPercent: number
}

/**
 * Section that could be extracted as a sub-skill
 */
export interface ExtractableSection {
  /** Section name/title */
  name: string

  /** Start line number */
  startLine: number

  /** End line number */
  endLine: number

  /** Number of lines */
  lineCount: number

  /** Extraction priority (1 = highest) */
  priority: number

  /** Reason for extraction recommendation */
  reason: string
}

/**
 * Optimization recommendation
 */
export interface OptimizationRecommendation {
  /** Recommendation type */
  type: 'decompose' | 'parallelize' | 'subagent' | 'progressive-disclosure'

  /** Human-readable description */
  description: string

  /** Estimated token savings (percentage) */
  estimatedSavings: number

  /** Priority (1 = highest) */
  priority: number

  /** Affected sections or patterns */
  affectedAreas: string[]
}

/**
 * Parsed section from skill content
 */
export interface ParsedSection {
  /** Section name/title */
  name: string

  /** Start line number */
  startLine: number

  /** End line number */
  endLine: number

  /** Full section content */
  content: string
}

/**
 * Confidence level type
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low'
