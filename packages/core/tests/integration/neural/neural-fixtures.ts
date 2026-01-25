/**
 * SMI-1535: Neural Test Infrastructure - Fixtures
 *
 * Test fixtures and default profile creation for neural tests.
 *
 * @see packages/core/src/learning/types.ts
 */

import {
  type UserPreferenceProfile,
  SkillCategory,
  COLD_START_WEIGHTS,
} from '../../../src/learning/types.js'

/**
 * Create a default empty user preference profile
 *
 * Note: COLD_START_WEIGHTS only defines weights for a subset of SkillCategory values
 * (TESTING, GIT, DEVOPS, DOCUMENTATION, FRONTEND, BACKEND). Categories not in
 * COLD_START_WEIGHTS (DATABASE, SECURITY, PRODUCTIVITY, ANALYSIS) will have
 * undefined weights, which is handled gracefully by the learning algorithm
 * by defaulting to 0 when accessing missing keys.
 */
export function createDefaultProfile(): UserPreferenceProfile {
  // Start with cold start weights and ensure all categories have explicit defaults
  const categoryWeights: Partial<Record<SkillCategory, number>> = {
    ...COLD_START_WEIGHTS.category_weights,
  }

  // Add missing categories with neutral (0) weights for completeness
  const allCategories = Object.values(SkillCategory)
  for (const category of allCategories) {
    if (categoryWeights[category] === undefined) {
      categoryWeights[category] = 0
    }
  }

  return {
    version: 1,
    last_updated: Date.now(),
    signal_count: 0,
    category_weights: categoryWeights,
    trust_tier_weights: { ...COLD_START_WEIGHTS.trust_tier_weights },
    keyword_weights: {},
    negative_patterns: {
      keywords: [],
      categories: [],
      skill_ids: [],
    },
    usage_patterns: {
      avg_time_to_first_use_ms: 0,
      utilization_rate: 0,
      top_categories: [],
    },
  }
}
