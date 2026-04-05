/**
 * @fileoverview Risk trend detection for supply chain attack monitoring
 * @module @skillsmith/core/security/risk-trend
 * @see SMI-3874: Risk Trend Detection
 */

import type { RiskScoreSnapshot } from '../repositories/RiskScoreHistoryRepository.js'

export interface RiskTrendResult {
  anomaly: boolean
  message: string
  currentScore: number
  previousScore: number | null
  delta: number
}

/**
 * Detect anomalous risk score changes that may indicate supply chain attacks.
 * Thresholds: 20pt warning, 35pt critical, 40pt boundary crossing.
 */
export function detectRiskTrend(
  currentScore: number,
  history: RiskScoreSnapshot[],
  options?: { isNewCategoryBaseline?: boolean }
): RiskTrendResult {
  if (history.length === 0) {
    return {
      anomaly: false,
      message: 'No prior scan history for comparison.',
      currentScore,
      previousScore: null,
      delta: 0,
    }
  }

  const previous = history[0]
  const delta = currentScore - previous.riskScore

  if (options?.isNewCategoryBaseline) {
    return {
      anomaly: false,
      message:
        'New scanner category baseline (' +
        previous.riskScore +
        ' -> ' +
        currentScore +
        '). Not flagged as anomaly.',
      currentScore,
      previousScore: previous.riskScore,
      delta,
    }
  }

  const crossesBoundary = previous.riskScore < 40 && currentScore >= 40
  const isLargeJump = delta >= 20
  const isCriticalJump = delta >= 35
  const anomaly = isLargeJump || crossesBoundary

  let message: string
  if (isCriticalJump) {
    message =
      'CRITICAL: Risk score jumped from ' +
      previous.riskScore +
      ' to ' +
      currentScore +
      ' (+' +
      delta +
      '). Possible supply chain compromise.'
  } else if (crossesBoundary) {
    message =
      'WARNING: Risk score crossed safety threshold (' +
      previous.riskScore +
      ' -> ' +
      currentScore +
      '). Review recent changes.'
  } else if (isLargeJump) {
    message =
      'WARNING: Risk score increased by ' +
      delta +
      ' points (' +
      previous.riskScore +
      ' -> ' +
      currentScore +
      ').'
  } else {
    message =
      'Risk score stable (' +
      previous.riskScore +
      ' -> ' +
      currentScore +
      ', delta: ' +
      (delta >= 0 ? '+' : '') +
      delta +
      ').'
  }

  return { anomaly, message, currentScore, previousScore: previous.riskScore, delta }
}
