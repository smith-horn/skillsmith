/**
 * Skill Matching Module
 * @module @skillsmith/core/matching
 *
 * Provides semantic skill matching and overlap detection.
 *
 * @see SMI-602: Recommend skills based on codebase analysis
 * @see SMI-604: Trigger phrase overlap detection
 */

export { SkillMatcher, default as DefaultSkillMatcher } from './SkillMatcher.js'
export type { MatchableSkill, SkillMatchResult, SkillMatcherOptions } from './SkillMatcher.js'

export { OverlapDetector, default as DefaultOverlapDetector } from './OverlapDetector.js'
export type {
  TriggerPhraseSkill,
  OverlapResult,
  FilteredSkillsResult,
  OverlapDetectorOptions,
} from './OverlapDetector.js'
