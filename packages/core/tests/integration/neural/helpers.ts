/**
 * SMI-1535: Neural Test Infrastructure - Helpers
 *
 * Provides signal generation utilities and test data factories
 * for the Recommendation Learning Loop integration tests.
 *
 * @see packages/core/src/learning/interfaces.ts
 * @see packages/core/src/learning/types.ts
 */

import { randomUUID } from 'node:crypto'
import {
  type SignalEvent,
  type RecommendationContext,
  type SignalMetadata,
  SignalType,
  DismissReason,
  SkillCategory,
} from '../../../src/learning/types.js'

/**
 * Options for generating a signal event
 */
export interface SignalGeneratorOptions {
  type?: SignalType
  skillId?: string
  timestamp?: number
  category?: SkillCategory
  trustTier?: string
  originalScore?: number
  installedSkills?: string[]
  dismissReason?: DismissReason
  metadata?: SignalMetadata
}

/**
 * Generate a single signal event with sensible defaults
 */
export function generateSignal(options: SignalGeneratorOptions = {}): SignalEvent {
  const type = options.type ?? SignalType.ACCEPT
  const skillId = options.skillId ?? `skill-${randomUUID().slice(0, 8)}`
  const timestamp = options.timestamp ?? Date.now()

  const context: RecommendationContext = {
    installed_skills: options.installedSkills ?? [],
    original_score: options.originalScore ?? Math.random(),
    category: options.category,
    trust_tier: options.trustTier,
  }

  return {
    id: randomUUID(),
    type,
    skill_id: skillId,
    timestamp,
    context,
    metadata: options.metadata,
    dismiss_reason: options.dismissReason,
  }
}

/**
 * Generate multiple signal events in a batch
 */
export function generateSignalBatch(
  count: number,
  options: SignalGeneratorOptions = {}
): SignalEvent[] {
  const signals: SignalEvent[] = []
  const baseTimestamp = options.timestamp ?? Date.now()

  for (let i = 0; i < count; i++) {
    signals.push(
      generateSignal({
        ...options,
        timestamp: baseTimestamp - i * 1000, // 1 second apart
      })
    )
  }

  return signals
}

/**
 * Generate a sequence of signals simulating realistic user behavior
 * Returns signals in chronological order
 */
export function generateUserJourney(
  skillId: string,
  outcome: 'successful' | 'abandoned' | 'uninstalled',
  category?: SkillCategory
): SignalEvent[] {
  const now = Date.now()
  const signals: SignalEvent[] = []

  // Day 0: Skill recommended and accepted
  signals.push(
    generateSignal({
      type: SignalType.ACCEPT,
      skillId,
      category,
      trustTier: 'community',
      originalScore: 0.85,
      timestamp: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    })
  )

  switch (outcome) {
    case 'successful':
      // Day 1: First usage
      signals.push(
        generateSignal({
          type: SignalType.USAGE_DAILY,
          skillId,
          category,
          timestamp: now - 29 * 24 * 60 * 60 * 1000,
        })
      )
      // Week 1-4: Regular usage
      for (let week = 1; week <= 4; week++) {
        signals.push(
          generateSignal({
            type: SignalType.USAGE_WEEKLY,
            skillId,
            category,
            timestamp: now - (30 - week * 7) * 24 * 60 * 60 * 1000,
          })
        )
      }
      break

    case 'abandoned':
      // No usage signals - skill was installed but never used
      // Day 30: Marked as abandoned
      signals.push(
        generateSignal({
          type: SignalType.ABANDONED,
          skillId,
          category,
          timestamp: now,
          metadata: { extra: { days_since_install: 30 } },
        })
      )
      break

    case 'uninstalled':
      // Day 1: Brief usage
      signals.push(
        generateSignal({
          type: SignalType.USAGE_DAILY,
          skillId,
          category,
          timestamp: now - 29 * 24 * 60 * 60 * 1000,
        })
      )
      // Day 15: Uninstalled
      signals.push(
        generateSignal({
          type: SignalType.UNINSTALL,
          skillId,
          category,
          timestamp: now - 15 * 24 * 60 * 60 * 1000,
          metadata: { extra: { days_since_install: 15 } },
        })
      )
      break
  }

  // Sort by timestamp ascending (chronological)
  return signals.sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Generate signals representing a mix of user interactions across categories
 */
export function generateMixedCategorySignals(
  signalsPerCategory: number
): Map<SkillCategory, SignalEvent[]> {
  const result = new Map<SkillCategory, SignalEvent[]>()
  const categories = Object.values(SkillCategory)

  for (const category of categories) {
    const signals: SignalEvent[] = []
    const now = Date.now()

    for (let i = 0; i < signalsPerCategory; i++) {
      // Mix of signal types: 60% accept, 20% dismiss, 20% usage
      const rand = Math.random()
      let type: SignalType
      if (rand < 0.6) {
        type = SignalType.ACCEPT
      } else if (rand < 0.8) {
        type = SignalType.DISMISS
      } else {
        type = Math.random() < 0.5 ? SignalType.USAGE_DAILY : SignalType.USAGE_WEEKLY
      }

      signals.push(
        generateSignal({
          type,
          category,
          skillId: `${category}-skill-${i}`,
          timestamp: now - i * 60 * 60 * 1000, // 1 hour apart
        })
      )
    }

    result.set(category, signals)
  }

  return result
}

/**
 * Generate dismiss signals with various reasons
 */
export function generateDismissSignals(count: number, category?: SkillCategory): SignalEvent[] {
  const reasons = Object.values(DismissReason)
  const signals: SignalEvent[] = []
  const now = Date.now()

  for (let i = 0; i < count; i++) {
    const reason = reasons[i % reasons.length]
    signals.push(
      generateSignal({
        type: SignalType.DISMISS,
        category,
        skillId: `dismissed-skill-${i}`,
        dismissReason: reason,
        timestamp: now - i * 1000,
      })
    )
  }

  return signals
}

/**
 * Create a timestamp offset by a number of days from now
 */
export function daysAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000
}

/**
 * Create a timestamp offset by a number of hours from now
 */
export function hoursAgo(hours: number): number {
  return Date.now() - hours * 60 * 60 * 1000
}

/**
 * Create a timestamp offset by a number of minutes from now
 */
export function minutesAgo(minutes: number): number {
  return Date.now() - minutes * 60 * 1000
}

/**
 * Generate a recommendation context for testing
 */
export function generateContext(
  options: {
    installedSkills?: string[]
    originalScore?: number
    category?: SkillCategory
    trustTier?: string
    projectContext?: string
  } = {}
): RecommendationContext {
  return {
    installed_skills: options.installedSkills ?? ['existing-skill-1', 'existing-skill-2'],
    original_score: options.originalScore ?? 0.75,
    category: options.category,
    trust_tier: options.trustTier ?? 'community',
    project_context: options.projectContext,
  }
}

/**
 * Generate metadata for signal events
 */
export function generateMetadata(
  options: {
    timeToAction?: number
    suggestionCount?: number
    extra?: Record<string, unknown>
  } = {}
): SignalMetadata {
  return {
    time_to_action: options.timeToAction ?? Math.floor(Math.random() * 10000) + 1000,
    suggestion_count: options.suggestionCount ?? Math.floor(Math.random() * 5) + 1,
    extra: options.extra,
  }
}

/**
 * Generate test skill data for personalization testing
 */
export function generateSkillData(
  id: string,
  options: {
    category?: SkillCategory
    trustTier?: string
    keywords?: string[]
    triggerPhrases?: string[]
  } = {}
): {
  id: string
  category?: string
  trustTier?: string
  keywords?: string[]
  triggerPhrases?: string[]
} {
  return {
    id,
    category: options.category ?? SkillCategory.TESTING,
    trustTier: options.trustTier ?? 'community',
    keywords: options.keywords ?? ['test', 'helper'],
    triggerPhrases: options.triggerPhrases ?? ['run tests', 'test this'],
  }
}

/**
 * Generate a set of skills with varied categories for recommendation testing
 */
export function generateSkillSet(count: number): Array<{
  skill_id: string
  base_score: number
  skill_data: {
    category?: string
    trustTier?: string
    keywords?: string[]
  }
}> {
  const categories = Object.values(SkillCategory)
  const trustTiers = ['verified', 'community', 'experimental', 'unknown']
  const skills: Array<{
    skill_id: string
    base_score: number
    skill_data: {
      category?: string
      trustTier?: string
      keywords?: string[]
    }
  }> = []

  for (let i = 0; i < count; i++) {
    skills.push({
      skill_id: `skill-${i}`,
      base_score: 0.5 + Math.random() * 0.5, // 0.5 to 1.0
      skill_data: {
        category: categories[i % categories.length],
        trustTier: trustTiers[i % trustTiers.length],
        keywords: [`keyword-${i}`, 'common'],
      },
    })
  }

  return skills
}

/**
 * Assert that signals are in chronological order
 */
export function assertChronological(signals: SignalEvent[]): void {
  for (let i = 1; i < signals.length; i++) {
    if (signals[i].timestamp < signals[i - 1].timestamp) {
      throw new Error(
        `Signals not in chronological order at index ${i}: ` +
          `${signals[i - 1].timestamp} > ${signals[i].timestamp}`
      )
    }
  }
}

/**
 * Wait for a specified number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
