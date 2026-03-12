/**
 * @fileoverview FailureAnalyzer — categorize task failures from evaluations
 * @module @skillsmith/core/evaluation/FailureAnalyzer
 * @see SMI-3293, SMI-3294: Heuristic + LLM failure categorization
 *
 * Categorizes failures into 5 categories:
 *  - wrong_format: predicted type doesn't match ground truth type
 *  - missing_context: agent output signals insufficient information
 *  - tool_misuse: tool calls failed or no tools used when needed
 *  - reasoning_error: right type, wrong value (fallback category)
 *  - hallucination: high confidence + wrong answer (best-effort, least reliable)
 *
 * The hallucination category is a best-effort approximation using
 * detection-by-absence (no hedging language). It will produce false positives.
 * Do not use hallucination frequency alone to drive variant generation.
 */

import type {
  FailureAnalyzerConfig,
  FailureCategory,
  FailurePattern,
  TaskFailure,
} from './types.js'

/** Templates for suggested fixes per category */
const SUGGESTED_FIX_TEMPLATES: Record<FailureCategory, string> = {
  wrong_format:
    "Add explicit output format instructions: 'Always respond with a single number, no units'",
  missing_context: "Add context retrieval step: 'Before answering, search for relevant documents'",
  tool_misuse: "Add tool usage guidance: 'Use the file search tool to find data before reasoning'",
  reasoning_error:
    "Add step-by-step reasoning instruction: 'Break the problem into steps before answering'",
  hallucination: "Add confidence calibration: 'If uncertain, state your confidence level'",
}

/** Phrases signaling missing context in agent output */
const MISSING_CONTEXT_PHRASES = [
  "i don't have enough information",
  'cannot determine',
  'not provided',
  'no information available',
  'unable to find',
  'insufficient data',
  'not enough context',
  "i'm not sure",
  'no data available',
]

/** Hedging phrases that indicate uncertainty (absence → hallucination signal) */
const HEDGING_PHRASES = [
  "i'm not sure",
  'i think',
  'possibly',
  'it might be',
  'approximately',
  'i believe',
  'probably',
  'perhaps',
  'it seems',
  'my best guess',
  'uncertain',
  'likely',
  'not confident',
]

const DEFAULT_MAX_EXAMPLES = 5

export class FailureAnalyzer {
  private readonly mode: 'heuristic' | 'llm'
  private readonly maxExamples: number

  constructor(config?: Partial<FailureAnalyzerConfig>) {
    this.mode = config?.mode ?? 'heuristic'
    this.maxExamples = config?.maxExamplesPerCategory ?? DEFAULT_MAX_EXAMPLES
  }

  /**
   * Analyze a set of task failures and categorize them.
   * Returns patterns sorted by frequency descending.
   */
  analyze(failures: TaskFailure[]): FailurePattern[] {
    if (failures.length === 0) return []

    if (this.mode === 'llm') {
      return this.analyzeLlm(failures)
    }

    return this.analyzeHeuristic(failures)
  }

  private analyzeHeuristic(failures: TaskFailure[]): FailurePattern[] {
    const buckets = new Map<FailureCategory, TaskFailure[]>()

    for (const failure of failures) {
      const category = this.categorize(failure)
      const list = buckets.get(category) ?? []
      list.push(failure)
      buckets.set(category, list)
    }

    const patterns: FailurePattern[] = []
    for (const [category, examples] of buckets) {
      patterns.push({
        category,
        frequency: examples.length,
        examples: examples.slice(0, this.maxExamples),
        suggestedFix: SUGGESTED_FIX_TEMPLATES[category],
      })
    }

    // Sort by frequency descending
    patterns.sort((a, b) => b.frequency - a.frequency)
    return patterns
  }

  /**
   * LLM mode stub — returns heuristic results with a flag.
   * Full LLM implementation requires API client injection (Wave 1B optional).
   */
  private analyzeLlm(failures: TaskFailure[]): FailurePattern[] {
    // LLM mode falls back to heuristic for now
    // Future: send batches of 5 failures to Claude for nuanced categorization
    return this.analyzeHeuristic(failures)
  }

  /**
   * Categorize a single failure using heuristics.
   * Order matters — earlier checks take priority.
   */
  private categorize(failure: TaskFailure): FailureCategory {
    // 1. Wrong format: type mismatch between predicted and ground truth
    if (this.isWrongFormat(failure)) {
      return 'wrong_format'
    }

    // 2. Missing context: agent signals insufficient information
    if (this.isMissingContext(failure)) {
      return 'missing_context'
    }

    // 3. Tool misuse: tool call failed or no tools used when task needs them
    if (this.isToolMisuse(failure)) {
      return 'tool_misuse'
    }

    // 4. Hallucination: high confidence (no hedging) but wrong answer
    // Best-effort — least reliable heuristic, detection-by-absence
    if (this.isHallucination(failure)) {
      return 'hallucination'
    }

    // 5. Reasoning error: fallback — right type, wrong value
    return 'reasoning_error'
  }

  private isWrongFormat(failure: TaskFailure): boolean {
    const predicted = failure.predicted.trim()
    const truth = failure.groundTruth.trim()

    // Check number vs non-number
    const predIsNum = isNumericString(predicted)
    const truthIsNum = isNumericString(truth)
    if (predIsNum !== truthIsNum) return true

    // Check list vs scalar (simple heuristic: comma-separated or newline-separated)
    const predIsList = isListString(predicted)
    const truthIsList = isListString(truth)
    if (predIsList !== truthIsList) return true

    // Check for drastically different length (10x ratio → likely format issue)
    if (predicted.length > 0 && truth.length > 0) {
      const ratio = predicted.length / truth.length
      if (ratio > 10 || ratio < 0.1) return true
    }

    return false
  }

  private isMissingContext(failure: TaskFailure): boolean {
    const output = failure.agentOutput.toLowerCase()
    return MISSING_CONTEXT_PHRASES.some((phrase) => output.includes(phrase))
  }

  private isToolMisuse(failure: TaskFailure): boolean {
    if (failure.toolCallFailed) return true

    // If the task seems to need tools (ground truth references files/data)
    // but agent used zero tool calls
    if (failure.toolCallCount === 0) {
      const output = failure.agentOutput.toLowerCase()
      const needsTools =
        output.includes('file') ||
        output.includes('search') ||
        output.includes('look up') ||
        output.includes('database')
      if (needsTools) return true
    }

    return false
  }

  private isHallucination(failure: TaskFailure): boolean {
    const output = failure.agentOutput.toLowerCase()

    // Must NOT contain hedging language (hallucination = confident + wrong)
    const hasHedging = HEDGING_PHRASES.some((phrase) => output.includes(phrase))
    if (hasHedging) return false

    // Must have a substantive answer (not empty/very short)
    if (output.trim().length < 10) return false

    // Confident and wrong → hallucination signal
    return true
  }
}

/** Check if a string represents a numeric value */
function isNumericString(s: string): boolean {
  if (s.length === 0) return false
  return !isNaN(Number(s.replace(/[,%$€£¥]/g, '').trim()))
}

/** Check if a string looks like a list (comma-separated or multi-line) */
function isListString(s: string): boolean {
  // Multiple comma-separated items
  if (s.includes(',') && s.split(',').length >= 3) return true
  // Multiple newline-separated items
  const lines = s.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length >= 3) return true
  return false
}
