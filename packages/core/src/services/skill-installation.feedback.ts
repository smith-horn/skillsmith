/**
 * @fileoverview AIDefence feedback + risk trend helpers for install pipeline
 * @module @skillsmith/core/services/skill-installation.feedback
 * @see SMI-3873: AIDefence Learning Loop
 * @see SMI-3874: Risk Trend Detection
 */

import type { ScanReport } from '../security/index.js'
import type { RiskScoreHistoryRepository } from '../repositories/RiskScoreHistoryRepository.js'
import type { AiDefenceFeedback } from './skill-installation.types.js'
import { detectRiskTrend } from '../security/risk-trend.js'

/** SMI-3873: Record AIDefence learning feedback. Best-effort, non-blocking. */
export function recordAiDefenceFeedback(params: {
  feedback: AiDefenceFeedback | undefined
  skillMdContent: string
  scanReport: ScanReport | undefined
  blocked: boolean
}): void {
  if (!params.feedback || !params.scanReport) return
  const report = params.scanReport
  params.feedback
    .recordFeedback({
      input: params.skillMdContent.slice(0, 1000),
      wasAccurate: true,
      verdict: params.blocked ? 'true_positive' : report.passed ? 'true_negative' : 'true_positive',
      threatType: !report.passed ? report.findings[0]?.type : undefined,
      mitigation: params.blocked ? 'block' : report.passed ? 'log' : 'block',
      mitigationSuccess: true,
    })
    .catch(() => {}) // best-effort
}

/** SMI-3874: Collect risk trend warnings from scan history. */
export function collectTrendWarnings(params: {
  historyRepo: RiskScoreHistoryRepository | undefined
  skillId: string
  scanReport: ScanReport
  contentHash: string | null
}): string[] {
  if (!params.historyRepo) return []
  try {
    const history = params.historyRepo.getHistory(params.skillId, 5)
    const trend = detectRiskTrend(params.scanReport.riskScore, history)
    return trend.anomaly ? [trend.message] : []
  } catch {
    return []
  }
}
