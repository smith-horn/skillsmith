/**
 * @fileoverview AIDefence learning loop feedback tests
 * @see SMI-3873: AIDefence Learning Loop
 */

import { describe, it, expect, vi } from 'vitest'
import { recordAiDefenceFeedback } from '../../src/services/skill-installation.feedback.js'
import type { AiDefenceFeedback } from '../../src/services/skill-installation.types.js'
import type { ScanReport } from '../../src/security/index.js'

function makeScanReport(overrides?: Partial<ScanReport>): ScanReport {
  return {
    skillId: 'test/skill',
    findings: [],
    riskScore: 5,
    riskBreakdown: {
      jailbreak: 0,
      socialEngineering: 0,
      promptLeaking: 0,
      dataExfiltration: 0,
      privilegeEscalation: 0,
      suspiciousCode: 0,
      sensitivePaths: 0,
      externalUrls: 0,
      aiDefence: 0,
      ssrf: 0,
      pii: 0,
    },
    passed: true,
    scannedAt: new Date(),
    scanDurationMs: 1,
    ...overrides,
  }
}

describe('recordAiDefenceFeedback', () => {
  it('should call feedback on successful install (true_negative)', async () => {
    const feedback: AiDefenceFeedback = { recordFeedback: vi.fn().mockResolvedValue(undefined) }
    recordAiDefenceFeedback({
      feedback,
      skillMdContent: 'Safe content',
      scanReport: makeScanReport(),
      blocked: false,
    })
    await vi.waitFor(() => {
      expect(feedback.recordFeedback).toHaveBeenCalledOnce()
    })
    expect(feedback.recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'true_negative', mitigation: 'log' })
    )
  })

  it('should call feedback on blocked install (true_positive)', async () => {
    const feedback: AiDefenceFeedback = { recordFeedback: vi.fn().mockResolvedValue(undefined) }
    const report = makeScanReport({
      passed: false,
      findings: [
        {
          type: 'jailbreak',
          severity: 'critical',
          message: 'Jailbreak',
          lineNumber: 1,
          confidence: 'high',
        },
      ],
    })
    recordAiDefenceFeedback({
      feedback,
      skillMdContent: 'Bad content',
      scanReport: report,
      blocked: true,
    })
    await vi.waitFor(() => {
      expect(feedback.recordFeedback).toHaveBeenCalledOnce()
    })
    expect(feedback.recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'true_positive', mitigation: 'block' })
    )
  })

  it('should not call feedback when callback is not provided', () => {
    recordAiDefenceFeedback({
      feedback: undefined,
      skillMdContent: 'c',
      scanReport: makeScanReport(),
      blocked: false,
    })
  })

  it('should not call feedback when scanReport is undefined', () => {
    const feedback: AiDefenceFeedback = { recordFeedback: vi.fn().mockResolvedValue(undefined) }
    recordAiDefenceFeedback({
      feedback,
      skillMdContent: 'c',
      scanReport: undefined,
      blocked: false,
    })
    expect(feedback.recordFeedback).not.toHaveBeenCalled()
  })

  it('should swallow errors (best-effort)', async () => {
    const feedback: AiDefenceFeedback = {
      recordFeedback: vi.fn().mockRejectedValue(new Error('fail')),
    }
    recordAiDefenceFeedback({
      feedback,
      skillMdContent: 'c',
      scanReport: makeScanReport(),
      blocked: false,
    })
    await new Promise((r) => setTimeout(r, 10))
  })

  it('should truncate input to 1000 chars', async () => {
    const feedback: AiDefenceFeedback = { recordFeedback: vi.fn().mockResolvedValue(undefined) }
    recordAiDefenceFeedback({
      feedback,
      skillMdContent: 'x'.repeat(2000),
      scanReport: makeScanReport(),
      blocked: false,
    })
    await vi.waitFor(() => {
      expect(feedback.recordFeedback).toHaveBeenCalledOnce()
    })
    const call = (feedback.recordFeedback as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.input.length).toBe(1000)
  })
})
