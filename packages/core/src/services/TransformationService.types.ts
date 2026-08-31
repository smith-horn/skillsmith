/**
 * Type definitions for `TransformationService.ts` — split out (SMI-6276)
 * when the `client` parameter threaded through by Wave 6 Step 1 pushed the
 * combined file past the 500-line standard. Re-exported verbatim from
 * `TransformationService.ts` so its own public import path is unaffected.
 */

import type { SkillAnalysis } from './SkillAnalyzer.js'
import type { SubagentDefinition } from './SubagentGenerator.js'

/**
 * Full transformation result for a skill
 */
export interface TransformationResult {
  /** Whether transformation was applied */
  transformed: boolean

  /** The optimized main SKILL.md content */
  mainSkillContent: string

  /** Sub-skills (if decomposed) */
  subSkills: Array<{
    filename: string
    content: string
  }>

  /** Companion subagent (if generated) */
  subagent?: SubagentDefinition

  /** CLAUDE.md integration snippet */
  claudeMdSnippet?: string

  /** Transformation statistics */
  stats: TransformationStats

  /** Analysis that informed the transformation */
  analysis: SkillAnalysis

  /** Attribution footer added to content */
  attribution: string
}

/**
 * Statistics about the transformation
 */
export interface TransformationStats {
  /** Original content line count */
  originalLines: number

  /** Optimized main skill line count */
  optimizedLines: number

  /** Number of sub-skills extracted */
  subSkillCount: number

  /** Whether Task() calls were parallelized */
  tasksParallelized: boolean

  /** Whether subagent was generated */
  subagentGenerated: boolean

  /** Estimated token reduction percentage */
  tokenReductionPercent: number

  /** Transformation duration in ms */
  transformDurationMs: number
}

/**
 * Cached transformation entry
 */
export interface CachedTransformation {
  result: TransformationResult
  skillHash: string
  cachedAt: string
  version: string
}

/**
 * Configuration for TransformationService
 */
export interface TransformationServiceOptions {
  /** Cache TTL in seconds (default: 3600 = 1 hour) */
  cacheTtl?: number

  /** Enable caching (default: true) */
  enableCache?: boolean

  /** Force re-transformation even if cached (default: false) */
  forceTransform?: boolean

  /** Transformation version for cache invalidation */
  version?: string
}
