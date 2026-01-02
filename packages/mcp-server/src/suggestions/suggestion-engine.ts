/**
 * @fileoverview Contextual Skill Suggestion Engine
 * @module @skillsmith/mcp-server/suggestions/suggestion-engine
 * @see SMI-913: Contextual skill suggestions after first success
 *
 * Provides intelligent skill recommendations based on project context detection.
 * Implements rate limiting, opt-out functionality, and persistent state management.
 *
 * @example
 * import { SuggestionEngine } from './suggestion-engine.js'
 * import { detectProjectContext } from '../context/project-detector.js'
 *
 * const engine = new SuggestionEngine()
 * const context = detectProjectContext()
 * const suggestions = engine.getSuggestions(context, ['installed/skill1'])
 *
 * if (suggestions.length > 0) {
 *   console.log(`Suggestion: ${suggestions[0].skillName} - ${suggestions[0].reason}`)
 *   engine.recordSuggestionShown()
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ProjectContext } from '../context/project-detector.js'
import type { SkillSuggestion, SuggestionConfig, SuggestionState } from './types.js'

/** Cooldown period between suggestions in milliseconds (5 minutes) */
const SUGGESTION_COOLDOWN_MS = 5 * 60 * 1000

/** Maximum suggestions per day per user */
const MAX_SUGGESTIONS_PER_DAY = 3

/** Default directory for storing Skillsmith configuration and state */
const DEFAULT_SUGGESTIONS_DIR = join(homedir(), '.skillsmith')

/** Default configuration values */
const DEFAULT_CONFIG: SuggestionConfig = {
  cooldownMs: SUGGESTION_COOLDOWN_MS,
  maxSuggestionsPerDay: MAX_SUGGESTIONS_PER_DAY,
  enableOptOut: true,
}

/**
 * Rule definition for skill suggestions based on project context
 */
interface SuggestionRule {
  /** Function to evaluate if this rule matches the context */
  condition: (ctx: ProjectContext) => boolean
  /** Full skill identifier */
  skillId: string
  /** Short skill name */
  skillName: string
  /** Human-readable reason for the suggestion */
  reason: string
  /** Priority (1 = highest) */
  priority: number
}

/**
 * Skill suggestion rules based on project context
 *
 * Rules are evaluated in order. Each rule checks for specific project
 * characteristics and suggests relevant skills.
 */
const SUGGESTION_RULES: SuggestionRule[] = [
  {
    condition: (ctx) => ctx.hasDocker && ctx.hasNativeModules,
    skillId: 'community/docker',
    skillName: 'docker',
    reason: 'Your project uses native modules - Docker ensures consistent builds',
    priority: 1,
  },
  {
    condition: (ctx) => ctx.hasLinear,
    skillId: 'user/linear',
    skillName: 'linear',
    reason: 'Automate Linear issue updates from your commits',
    priority: 2,
  },
  {
    condition: (ctx) => ctx.hasGitHub,
    skillId: 'anthropic/review-pr',
    skillName: 'review-pr',
    reason: 'Get AI-powered code review suggestions for your PRs',
    priority: 2,
  },
  {
    condition: (ctx) => ctx.testFramework === 'jest',
    skillId: 'community/jest-helper',
    skillName: 'jest-helper',
    reason: 'Generate and improve Jest tests automatically',
    priority: 3,
  },
  {
    condition: (ctx) => ctx.testFramework === 'vitest',
    skillId: 'community/vitest-helper',
    skillName: 'vitest-helper',
    reason: 'Generate and improve Vitest tests automatically',
    priority: 3,
  },
  {
    condition: (ctx) => ctx.apiFramework === 'express' || ctx.apiFramework === 'nextjs',
    skillId: 'community/api-docs',
    skillName: 'api-docs',
    reason: 'Generate OpenAPI documentation for your API endpoints',
    priority: 4,
  },
]

/**
 * Engine for generating contextual skill suggestions
 *
 * Manages suggestion state, rate limiting, and skill recommendations
 * based on detected project context.
 *
 * @example
 * const engine = new SuggestionEngine({ cooldownMs: 10 * 60 * 1000 })
 * const context = detectProjectContext('/path/to/project')
 * const suggestions = engine.getSuggestions(context, ['installed/skill'])
 */
export class SuggestionEngine {
  private config: SuggestionConfig
  private state: SuggestionState
  private stateDir: string
  private stateFile: string

  /**
   * Create a new SuggestionEngine instance
   *
   * @param config - Partial configuration to override defaults
   *
   * @example
   * // Use defaults
   * const engine = new SuggestionEngine()
   *
   * // Override cooldown
   * const engine = new SuggestionEngine({ cooldownMs: 10 * 60 * 1000 })
   *
   * // Custom state directory (for testing)
   * const engine = new SuggestionEngine({ stateDir: '/tmp/test-state' })
   */
  constructor(config: Partial<SuggestionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.stateDir = config.stateDir || DEFAULT_SUGGESTIONS_DIR
    this.stateFile = join(this.stateDir, 'suggestions-state.json')
    this.state = this.loadState()
  }

  /**
   * Load suggestion state from disk
   *
   * Resets daily count if it's a new day.
   *
   * @returns Loaded or default suggestion state
   */
  private loadState(): SuggestionState {
    if (existsSync(this.stateFile)) {
      try {
        const data = JSON.parse(readFileSync(this.stateFile, 'utf-8')) as SuggestionState
        // Reset daily count if new day
        const today = new Date().toDateString()
        const lastDay = new Date(data.lastSuggestionTime || 0).toDateString()
        if (today !== lastDay) {
          data.suggestionsToday = 0
        }
        return data
      } catch (error) {
        console.warn(
          '[suggestion-engine] Failed to load state:',
          this.stateFile,
          error instanceof Error ? error.message : String(error)
        )
        return this.getDefaultState()
      }
    }
    return this.getDefaultState()
  }

  /**
   * Get default suggestion state
   *
   * @returns Fresh default state object
   */
  private getDefaultState(): SuggestionState {
    return {
      lastSuggestionTime: 0,
      suggestionsToday: 0,
      optedOut: false,
      dismissedSkills: [],
    }
  }

  /**
   * Save suggestion state to disk
   *
   * Creates the state directory if it doesn't exist.
   */
  private saveState(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true })
    }
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
  }

  /**
   * Check if suggestions can be shown based on rate limits
   *
   * Checks:
   * - User has not opted out
   * - Daily limit not reached
   * - Cooldown period has passed
   *
   * @returns True if suggestions are allowed
   *
   * @example
   * if (engine.canSuggest()) {
   *   const suggestions = engine.getSuggestions(context)
   *   // Show suggestion to user
   * }
   */
  canSuggest(): boolean {
    if (this.state.optedOut) return false
    if (this.state.suggestionsToday >= this.config.maxSuggestionsPerDay) return false

    const timeSinceLastSuggestion = Date.now() - this.state.lastSuggestionTime
    return timeSinceLastSuggestion >= this.config.cooldownMs
  }

  /**
   * Get skill suggestions based on project context
   *
   * Returns empty array if rate limited or opted out.
   * Filters out already installed and dismissed skills.
   * Returns at most one suggestion (the highest priority match).
   *
   * @param context - Detected project context from project-detector
   * @param installedSkills - Array of currently installed skill IDs
   * @returns Array of skill suggestions (at most one)
   *
   * @example
   * const context = detectProjectContext()
   * const suggestions = engine.getSuggestions(context, ['user/docker'])
   *
   * if (suggestions.length > 0) {
   *   console.log(`Try: ${suggestions[0].skillName}`)
   * }
   */
  getSuggestions(context: ProjectContext, installedSkills: string[] = []): SkillSuggestion[] {
    if (!this.canSuggest()) return []

    const suggestions: SkillSuggestion[] = []

    for (const rule of SUGGESTION_RULES) {
      // Skip if already installed
      if (installedSkills.some((s) => s.includes(rule.skillName))) continue

      // Skip if dismissed
      if (this.state.dismissedSkills.includes(rule.skillId)) continue

      // Check condition
      if (rule.condition(context)) {
        suggestions.push({
          skillId: rule.skillId,
          skillName: rule.skillName,
          reason: rule.reason,
          priority: rule.priority,
          contextMatch: this.getContextMatches(context),
        })
      }
    }

    // Sort by priority and return top suggestion
    return suggestions.sort((a, b) => a.priority - b.priority).slice(0, 1)
  }

  /**
   * Get list of context attributes that are true
   *
   * @param context - Project context to analyze
   * @returns Array of context match strings
   */
  private getContextMatches(context: ProjectContext): string[] {
    const matches: string[] = []
    if (context.hasDocker) matches.push('hasDocker')
    if (context.hasLinear) matches.push('hasLinear')
    if (context.hasGitHub) matches.push('hasGitHub')
    if (context.testFramework) matches.push(`testFramework:${context.testFramework}`)
    if (context.apiFramework) matches.push(`apiFramework:${context.apiFramework}`)
    if (context.hasNativeModules) matches.push('hasNativeModules')
    return matches
  }

  /**
   * Record that a suggestion was shown to the user
   *
   * Updates the last suggestion time and increments daily counter.
   * Should be called after displaying a suggestion.
   *
   * @example
   * const suggestions = engine.getSuggestions(context)
   * if (suggestions.length > 0) {
   *   displaySuggestion(suggestions[0])
   *   engine.recordSuggestionShown()
   * }
   */
  recordSuggestionShown(): void {
    this.state.lastSuggestionTime = Date.now()
    this.state.suggestionsToday++
    this.saveState()
  }

  /**
   * Dismiss a skill so it won't be suggested again
   *
   * User can dismiss skills they're not interested in.
   *
   * @param skillId - Full skill identifier to dismiss
   *
   * @example
   * // User clicks "Don't show again" on docker suggestion
   * engine.dismissSkill('community/docker')
   */
  dismissSkill(skillId: string): void {
    if (!this.state.dismissedSkills.includes(skillId)) {
      this.state.dismissedSkills.push(skillId)
      this.saveState()
    }
  }

  /**
   * Permanently opt out of all suggestions
   *
   * User can disable all suggestions. Use optIn() to reverse.
   *
   * @example
   * // User clicks "Never show suggestions"
   * engine.optOut()
   */
  optOut(): void {
    this.state.optedOut = true
    this.saveState()
  }

  /**
   * Opt back in to suggestions after opting out
   *
   * @example
   * // User re-enables suggestions in settings
   * engine.optIn()
   */
  optIn(): void {
    this.state.optedOut = false
    this.saveState()
  }

  /**
   * Reset all suggestion state to defaults
   *
   * Clears dismissed skills, resets counters, and re-enables suggestions.
   *
   * @example
   * // User clicks "Reset suggestions"
   * engine.resetState()
   */
  resetState(): void {
    this.state = this.getDefaultState()
    this.saveState()
  }

  /**
   * Get a deep copy of the current suggestion state
   *
   * @returns Deep copy of current state (modifications don't affect engine)
   *
   * @example
   * const state = engine.getState()
   * console.log(`Suggestions today: ${state.suggestionsToday}`)
   */
  getState(): SuggestionState {
    return {
      ...this.state,
      dismissedSkills: [...this.state.dismissedSkills],
    }
  }
}
