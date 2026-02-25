/**
 * @fileoverview Update risk scorer for skill version upgrades
 * @module @skillsmith/core/versioning/update-risk
 * @see SMI-skill-version-tracking Wave 2
 *
 * Produces a RiskLevel and Recommendation for a proposed skill update
 * based on change severity, risk score delta, local modification status,
 * trust tier, and changelog availability.
 *
 * Scoring table (additive):
 *   change_type === 'major'      → +30
 *   riskScoreDelta > 0           → +20
 *   hasLocalModifications        → +20
 *   trustTier === 'verified'     → -20
 *   hasChangelog                 → -10
 *
 * Buckets:
 *   low      0–20   → auto-update
 *   medium  21–40   → review-then-update
 *   high    41–60   → manual-review-required
 *   critical 61+    → manual-review-required
 */

// ============================================================================
// Types
// ============================================================================

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type Recommendation = 'auto-update' | 'review-then-update' | 'manual-review-required'

export interface UpdateRisk {
  /** Human-readable risk bucket */
  level: RiskLevel
  /** Raw additive risk score (may be negative — clamped to 0 for level mapping) */
  score: number
  /** Suggested action for the caller */
  recommendation: Recommendation
}

// ============================================================================
// Scoring constants
// ============================================================================

const SCORE_MAJOR_CHANGE = 30
const SCORE_RISK_DELTA_INCREASE = 20
const SCORE_LOCAL_MODIFICATIONS = 20
const SCORE_VERIFIED_TRUST = -20
const SCORE_HAS_CHANGELOG = -10

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute the update risk for a pending skill upgrade.
 *
 * @param params.changeType         Semantic change type from classifyChange()
 * @param params.riskScoreDelta     newRiskScore - oldRiskScore (optional)
 * @param params.hasLocalModifications  Whether the user has edited the skill
 * @param params.trustTier          Registry trust tier for the skill
 * @param params.hasChangelog       Whether the skill includes a changelog entry
 * @returns UpdateRisk with level, score, and recommendation
 */
export function computeUpdateRisk(params: {
  changeType: 'major' | 'minor' | 'patch' | 'unknown'
  riskScoreDelta?: number
  hasLocalModifications: boolean
  trustTier: 'verified' | 'community' | 'experimental'
  hasChangelog: boolean
}): UpdateRisk {
  const { changeType, riskScoreDelta, hasLocalModifications, trustTier, hasChangelog } = params

  let score = 0

  if (changeType === 'major') score += SCORE_MAJOR_CHANGE
  if (typeof riskScoreDelta === 'number' && riskScoreDelta > 0) score += SCORE_RISK_DELTA_INCREASE
  if (hasLocalModifications) score += SCORE_LOCAL_MODIFICATIONS
  if (trustTier === 'verified') score += SCORE_VERIFIED_TRUST
  if (hasChangelog) score += SCORE_HAS_CHANGELOG

  const level = scoreToLevel(score)
  const recommendation = scoreToRecommendation(score)

  return { level, score, recommendation }
}

// ============================================================================
// Helpers
// ============================================================================

function scoreToLevel(score: number): RiskLevel {
  if (score <= 20) return 'low'
  if (score <= 40) return 'medium'
  if (score <= 60) return 'high'
  return 'critical'
}

function scoreToRecommendation(score: number): Recommendation {
  if (score <= 20) return 'auto-update'
  if (score <= 50) return 'review-then-update'
  return 'manual-review-required'
}
