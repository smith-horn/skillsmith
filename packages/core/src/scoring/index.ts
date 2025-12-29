/**
 * Quality Scoring Module
 *
 * Provides comprehensive quality scoring for Claude Code skills.
 *
 * @module scoring
 */

export {
  QualityScorer,
  quickScore,
  scoreFromRepository,
  type QualityScoringInput,
  type QualityScoreBreakdown,
  type ScoringWeights,
} from './QualityScorer.js'
