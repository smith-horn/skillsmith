/**
 * @fileoverview Type definitions for Contextual Skill Suggestions
 * @module @skillsmith/mcp-server/suggestions/types
 * @see SMI-913: Contextual skill suggestions after first success
 *
 * Defines interfaces for the suggestion engine that recommends relevant Tier 2 skills
 * after a user successfully uses a Tier 1 skill, based on project context.
 *
 * @example
 * import type { SkillSuggestion, SuggestionConfig, SuggestionState } from './types.js'
 *
 * const suggestion: SkillSuggestion = {
 *   skillId: 'community/docker',
 *   skillName: 'docker',
 *   reason: 'Your project uses native modules - Docker ensures consistent builds',
 *   priority: 1,
 *   contextMatch: ['hasDocker', 'hasNativeModules'],
 * }
 */

/**
 * A skill suggestion generated based on project context
 *
 * @example
 * const suggestion: SkillSuggestion = {
 *   skillId: 'community/docker',
 *   skillName: 'docker',
 *   reason: 'Your project uses native modules - Docker ensures consistent builds',
 *   priority: 1,
 *   contextMatch: ['hasDocker', 'hasNativeModules'],
 * }
 */
export interface SkillSuggestion {
  /** Full skill identifier (e.g., 'community/docker', 'user/linear') */
  skillId: string

  /** Short skill name for display (e.g., 'docker', 'linear') */
  skillName: string

  /** Human-readable reason why this skill is being suggested */
  reason: string

  /** Priority level (1 = highest priority, higher numbers = lower priority) */
  priority: number

  /** Context attributes that matched this suggestion (e.g., ['hasDocker', 'testFramework:jest']) */
  contextMatch: string[]
}

/**
 * Configuration options for the suggestion engine
 *
 * @example
 * const config: SuggestionConfig = {
 *   cooldownMs: 5 * 60 * 1000,  // 5 minutes
 *   maxSuggestionsPerDay: 3,
 *   enableOptOut: true,
 * }
 */
export interface SuggestionConfig {
  /** Minimum time between suggestions in milliseconds (default: 5 minutes) */
  cooldownMs: number

  /** Maximum number of suggestions per day (default: 3) */
  maxSuggestionsPerDay: number

  /** Whether to allow permanent opt-out from suggestions (default: true) */
  enableOptOut: boolean

  /** Custom state directory path (default: ~/.skillsmith) - primarily for testing */
  stateDir?: string
}

/**
 * Persistent state for the suggestion engine
 *
 * This state is persisted to disk in ~/.skillsmith/suggestions-state.json
 * and tracks suggestion history, rate limiting, and user preferences.
 *
 * @example
 * const state: SuggestionState = {
 *   lastSuggestionTime: Date.now(),
 *   suggestionsToday: 1,
 *   optedOut: false,
 *   dismissedSkills: ['community/docker'],
 * }
 */
export interface SuggestionState {
  /** Timestamp of the last suggestion shown (for cooldown calculation) */
  lastSuggestionTime: number

  /** Number of suggestions shown today (resets at midnight) */
  suggestionsToday: number

  /** Whether the user has permanently opted out of suggestions */
  optedOut: boolean

  /** Array of skill IDs the user has dismissed (won't be suggested again) */
  dismissedSkills: string[]
}
