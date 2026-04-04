/**
 * @fileoverview Canonical quality score computation for skills
 * @module @skillsmith/core/scoring/quality-score
 * @see SMI-3864: Security-informed quality scoring
 *
 * Computes a quality score (0-1) for a skill based on:
 * - Security health (30%)
 * - Documentation quality (35%, including examples signal)
 * - Provenance (25%)
 * - Completeness (10%)
 *
 * This is the single canonical formula. All callers (indexer, install,
 * import scripts) should use this function instead of ad-hoc formulas.
 */

/**
 * Input signals for quality score computation.
 * All fields are optional-friendly — null/undefined/0 get partial or zero credit.
 */
export interface QualityScoreInput {
  /** Risk score from SecurityScanner (0-100). Null if not scanned. */
  riskScore: number | null
  /** Number of security findings */
  securityFindingsCount: number
  /** Whether security scan passed */
  securityPassed: boolean | null
  /** Skill description text (for length scoring) */
  description: string | null
  /** Number of tags */
  tagCount: number
  /** Whether the skill has a repo URL */
  hasRepoUrl: boolean
  /** Author name present */
  hasAuthor: boolean
  /** Trust tier */
  trustTier: string
  /** Whether the skill has examples (examples.md or ## Examples section) */
  hasExamples: boolean
}

/**
 * Compute a quality score (0-1) for a skill based on multiple signals.
 *
 * Weight distribution (Review #12):
 * - Security health: 30% (reduced from 40% to avoid double-counting with riskScore)
 * - Documentation quality: 35% (increased, added hasExamples signal)
 * - Provenance: 25%
 * - Completeness: 10%
 */
export function computeQualityScore(input: QualityScoreInput): number {
  let score = 0
  let maxScore = 0

  // Security health (30% weight)
  maxScore += 30
  if (input.securityPassed === true) score += 20
  else if (input.securityPassed === null) score += 8 // not scanned = partial credit
  if (input.riskScore !== null) {
    score += Math.max(0, 10 * (1 - input.riskScore / 100))
  } else {
    score += 4
  }

  // Documentation quality (35% weight)
  maxScore += 35
  const descLen = input.description?.length ?? 0
  score += Math.min(12, descLen / 25) // up to 12 points for 300+ char description
  score += Math.min(8, input.tagCount * 2) // up to 8 points for 4+ tags
  if (input.hasAuthor) score += 5
  if (input.hasExamples) score += 10

  // Provenance (25% weight)
  maxScore += 25
  if (input.hasRepoUrl) score += 12
  const tierScores: Record<string, number> = {
    verified: 13,
    curated: 10,
    community: 6,
    experimental: 2,
    unknown: 0,
  }
  score += tierScores[input.trustTier] ?? 0

  // Completeness bonus (10% weight)
  maxScore += 10
  const fields = [
    input.description,
    input.hasRepoUrl,
    input.hasAuthor,
    input.tagCount > 0,
    input.hasExamples,
  ]
  const completeness = fields.filter(Boolean).length / fields.length
  score += completeness * 10

  return Math.round((score / maxScore) * 100) / 100 // 0.00 - 1.00
}
