// Scorer implementations for EvoSkill benchmarks
// Multi-tolerance exact-match (OfficeQA/DABStep) and LLM-judge (SEAL-QA)

import type { ScorerFn } from './types.js'

/** LLM judge client interface — injected to avoid SDK dependency in core */
export interface LlmJudgeClient {
  judge(params: {
    model: string
    question: string
    predicted: string
    groundTruth: string
  }): Promise<number>
}

/**
 * Normalize a string for comparison:
 * - lowercase
 * - strip leading/trailing whitespace
 * - remove trailing punctuation (., !, ?)
 */
function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^["']+|["']+$/g, '') // strip surrounding quotes
    .trim()
    .replace(/[.!?]+$/, '')
}

/**
 * Check if two numeric strings are within tolerance.
 * Returns true if both parse as numbers and |a - b| <= tolerance.
 */
function numericMatch(a: string, b: string, tolerance = 0.01): boolean {
  const numA = parseFloat(a)
  const numB = parseFloat(b)
  if (isNaN(numA) || isNaN(numB)) return false
  return Math.abs(numA - numB) <= tolerance
}

/**
 * Generate variations of a string for matching:
 * - Original normalized
 * - Without units (strip trailing alphabetic suffix)
 * - Without commas (e.g., "1,000" → "1000")
 * - Without percentage sign
 */
function variations(s: string): string[] {
  const norm = normalize(s)
  const result = [norm]

  // Without trailing units (e.g., "42 kg" → "42")
  const withoutUnits = norm.replace(/\s+[a-z%]+$/, '')
  if (withoutUnits !== norm) result.push(withoutUnits)

  // Without commas
  const withoutCommas = norm.replace(/,/g, '')
  if (withoutCommas !== norm) result.push(withoutCommas)

  // Without percentage
  const withoutPercent = norm.replace(/%$/, '')
  if (withoutPercent !== norm) result.push(withoutPercent)

  return result
}

/**
 * Multi-tolerance exact-match scorer for OfficeQA/DABStep.
 * Handles:
 * - Case-insensitive comparison
 * - Trailing punctuation removal
 * - With/without units
 * - Numeric tolerance (±0.01)
 * - Comma-separated alternatives in ground truth
 *
 * Returns 1.0 if any variation matches, 0.0 otherwise.
 */
export const exactMatchScorer: ScorerFn = (_question, predicted, groundTruth) => {
  const predVariations = variations(predicted)

  // Ground truth may contain comma-space-separated alternatives
  // Use ', ' (not bare ',') to avoid splitting numbers like '1,000'
  const truthAlternatives = groundTruth.split(', ').map((s) => s.trim())

  for (const truth of truthAlternatives) {
    const truthVariations = variations(truth)

    // Check exact match between any variation pair
    for (const pv of predVariations) {
      for (const tv of truthVariations) {
        if (pv === tv) return 1.0
      }
    }

    // Check numeric match
    for (const pv of predVariations) {
      for (const tv of truthVariations) {
        if (numericMatch(pv, tv)) return 1.0
      }
    }
  }

  return 0.0
}

/**
 * LLM-judge scorer for SEAL-QA.
 * Accepts an injected LlmJudgeClient to avoid @anthropic-ai/sdk dependency in core.
 * The CLI package provides the concrete implementation.
 *
 * Judge model is pinned via JUDGE_MODEL_ID constant — never the agent model.
 * Returns a score 0.0–1.0.
 */
export function createLlmJudgeScorer(client: LlmJudgeClient, judgeModelId: string): ScorerFn {
  return async (question: string, predicted: string, groundTruth: string) => {
    const score = await client.judge({ model: judgeModelId, question, predicted, groundTruth })
    return Math.max(0, Math.min(1, score))
  }
}

/**
 * Get the appropriate scorer for a benchmark.
 * For LLM-judged benchmarks, requires an injected LlmJudgeClient.
 */
export function getScorerForBenchmark(
  benchmark: 'officeqa' | 'sealqa' | 'browsecomp',
  judgeModelId: string,
  llmClient?: LlmJudgeClient
): ScorerFn {
  switch (benchmark) {
    case 'officeqa':
      return exactMatchScorer
    case 'sealqa':
    case 'browsecomp':
      if (!llmClient) {
        throw new Error(`LLM judge client required for ${benchmark} benchmark`)
      }
      return createLlmJudgeScorer(llmClient, judgeModelId)
  }
}
