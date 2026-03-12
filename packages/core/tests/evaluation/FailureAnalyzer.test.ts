/**
 * @fileoverview Tests for FailureAnalyzer (SMI-3295)
 * @module @skillsmith/core/tests/evaluation/FailureAnalyzer
 *
 * Tests heuristic categorization with synthetic failures:
 *  - Each category individually
 *  - Frequency counting and example capping
 *  - Edge cases (empty input, single failure, all same category)
 *  - Hallucination false-positive guard (must not dominate mixed sets)
 *  - suggestedFix template correctness
 */

import { describe, it, expect } from 'vitest'
import { FailureAnalyzer } from '../../src/evaluation/FailureAnalyzer.js'
import type { TaskFailure } from '../../src/evaluation/types.js'

function makeFailure(overrides: Partial<TaskFailure> = {}): TaskFailure {
  return {
    taskId: 'task-1',
    predicted: 'answer',
    groundTruth: 'correct',
    agentOutput: 'I answered: answer',
    ...overrides,
  }
}

describe('FailureAnalyzer — heuristic mode', () => {
  const analyzer = new FailureAnalyzer({ mode: 'heuristic' })

  // ==========================================================================
  // Individual category detection
  // ==========================================================================

  describe('wrong_format detection', () => {
    it('detects number vs string mismatch', () => {
      const failure = makeFailure({
        predicted: 'forty-two',
        groundTruth: '42',
        agentOutput: 'The answer is forty-two',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('wrong_format')
    })

    it('detects list vs scalar mismatch', () => {
      const failure = makeFailure({
        predicted: 'Paris',
        groundTruth: 'Paris, London, Berlin',
        agentOutput: 'The answer is Paris',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('wrong_format')
    })

    it('detects drastically different lengths', () => {
      const failure = makeFailure({
        predicted: 'A very long detailed response that goes on and on and on with many details',
        groundTruth: 'Yes',
        agentOutput: 'A very long detailed response that goes on and on and on with many details',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('wrong_format')
    })
  })

  describe('missing_context detection', () => {
    it('detects "cannot determine" phrase', () => {
      const failure = makeFailure({
        agentOutput: 'I cannot determine the answer from the available information.',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('missing_context')
    })

    it('detects "not provided" phrase', () => {
      const failure = makeFailure({
        agentOutput: 'The required data is not provided in the context.',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('missing_context')
    })

    it('detects "I don\'t have enough information"', () => {
      const failure = makeFailure({
        agentOutput: "I don't have enough information to answer this question.",
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('missing_context')
    })
  })

  describe('tool_misuse detection', () => {
    it('detects failed tool call', () => {
      const failure = makeFailure({
        toolCallFailed: true,
        agentOutput: 'I tried to search but the tool returned an error.',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('tool_misuse')
    })

    it('detects zero tool calls when output references file/search', () => {
      const failure = makeFailure({
        toolCallCount: 0,
        agentOutput: 'Looking at the file contents, I would say the answer is 42.',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('tool_misuse')
    })
  })

  describe('reasoning_error detection (fallback)', () => {
    it('categorizes same-type wrong-value as reasoning error', () => {
      const failure = makeFailure({
        predicted: '37',
        groundTruth: '42',
        agentOutput: 'I think the answer is 37.',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('reasoning_error')
    })
  })

  describe('hallucination detection', () => {
    it('detects confident wrong answer (no hedging)', () => {
      const failure = makeFailure({
        predicted: 'Paris',
        groundTruth: 'Berlin',
        agentOutput: 'The capital of Germany is Paris. This is a well-established fact.',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('hallucination')
    })

    it('does not flag hedging answer as hallucination', () => {
      const failure = makeFailure({
        predicted: 'Paris',
        groundTruth: 'Berlin',
        agentOutput: 'I think the capital might be Paris, but it could also be Berlin.',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      // Should fall through to reasoning_error since hedging is present
      expect(patterns[0].category).toBe('reasoning_error')
    })

    it('does not flag very short output as hallucination', () => {
      const failure = makeFailure({
        predicted: 'No',
        groundTruth: 'Yes',
        agentOutput: 'No.',
      })

      const patterns = analyzer.analyze([failure])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('reasoning_error')
    })
  })

  // ==========================================================================
  // Frequency counting and ordering
  // ==========================================================================

  describe('frequency counting', () => {
    it('counts frequencies and sorts descending', () => {
      const failures: TaskFailure[] = [
        // 3x wrong_format
        makeFailure({ taskId: 'f1', predicted: 'word', groundTruth: '42', agentOutput: 'word' }),
        makeFailure({ taskId: 'f2', predicted: 'text', groundTruth: '99', agentOutput: 'text' }),
        makeFailure({ taskId: 'f3', predicted: 'abc', groundTruth: '7', agentOutput: 'abc' }),
        // 2x missing_context
        makeFailure({
          taskId: 'f4',
          agentOutput: 'I cannot determine the answer',
        }),
        makeFailure({
          taskId: 'f5',
          agentOutput: 'The data is not provided here',
        }),
        // 1x tool_misuse
        makeFailure({
          taskId: 'f6',
          toolCallFailed: true,
          agentOutput: 'Tool failed during execution',
        }),
      ]

      const patterns = analyzer.analyze(failures)
      expect(patterns.length).toBeGreaterThanOrEqual(3)
      expect(patterns[0].category).toBe('wrong_format')
      expect(patterns[0].frequency).toBe(3)
      expect(patterns[1].category).toBe('missing_context')
      expect(patterns[1].frequency).toBe(2)
    })
  })

  // ==========================================================================
  // Example capping
  // ==========================================================================

  describe('example capping', () => {
    it('caps examples at 5 per category by default', () => {
      const failures: TaskFailure[] = Array.from({ length: 10 }, (_, i) =>
        makeFailure({
          taskId: `task-${i}`,
          predicted: 'text',
          groundTruth: `${i}`,
          agentOutput: `The answer is text-${i}`,
        })
      )

      const patterns = analyzer.analyze(failures)
      const formatPattern = patterns.find((p) => p.category === 'wrong_format')
      expect(formatPattern).toBeDefined()
      expect(formatPattern!.examples.length).toBeLessThanOrEqual(5)
      expect(formatPattern!.frequency).toBe(10) // frequency counts all
    })

    it('respects custom maxExamplesPerCategory', () => {
      const customAnalyzer = new FailureAnalyzer({
        mode: 'heuristic',
        maxExamplesPerCategory: 2,
      })

      const failures: TaskFailure[] = Array.from({ length: 5 }, (_, i) =>
        makeFailure({
          taskId: `task-${i}`,
          predicted: 'text',
          groundTruth: `${i}`,
          agentOutput: `The answer is text-${i}`,
        })
      )

      const patterns = customAnalyzer.analyze(failures)
      const formatPattern = patterns.find((p) => p.category === 'wrong_format')
      expect(formatPattern!.examples).toHaveLength(2)
    })
  })

  // ==========================================================================
  // suggestedFix templates
  // ==========================================================================

  describe('suggestedFix templates', () => {
    it('provides correct template for each category', () => {
      const failures: TaskFailure[] = [
        // wrong_format
        makeFailure({ taskId: 'f1', predicted: 'word', groundTruth: '42', agentOutput: 'word' }),
        // missing_context
        makeFailure({ taskId: 'f2', agentOutput: 'Cannot determine the answer' }),
        // tool_misuse
        makeFailure({ taskId: 'f3', toolCallFailed: true, agentOutput: 'Tool error occurred' }),
      ]

      const patterns = analyzer.analyze(failures)
      const formatP = patterns.find((p) => p.category === 'wrong_format')
      const contextP = patterns.find((p) => p.category === 'missing_context')
      const toolP = patterns.find((p) => p.category === 'tool_misuse')

      expect(formatP!.suggestedFix).toContain('output format instructions')
      expect(contextP!.suggestedFix).toContain('context retrieval')
      expect(toolP!.suggestedFix).toContain('tool usage guidance')
    })
  })

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('returns empty array for no failures', () => {
      expect(analyzer.analyze([])).toEqual([])
    })

    it('handles single failure', () => {
      const patterns = analyzer.analyze([
        makeFailure({
          agentOutput: 'I cannot determine the answer from available data.',
        }),
      ])
      expect(patterns).toHaveLength(1)
      expect(patterns[0].frequency).toBe(1)
    })

    it('handles all failures in same category', () => {
      const failures = Array.from({ length: 3 }, (_, i) =>
        makeFailure({
          taskId: `task-${i}`,
          agentOutput: `I cannot determine answer ${i}`,
        })
      )

      const patterns = analyzer.analyze(failures)
      expect(patterns).toHaveLength(1)
      expect(patterns[0].category).toBe('missing_context')
      expect(patterns[0].frequency).toBe(3)
    })
  })

  // ==========================================================================
  // Hallucination false-positive guard
  // ==========================================================================

  describe('hallucination false-positive guard', () => {
    it('hallucination does not dominate when clear format errors exist', () => {
      const failures: TaskFailure[] = [
        // 3x clear wrong_format
        makeFailure({
          taskId: 'f1',
          predicted: 'word',
          groundTruth: '42',
          agentOutput: 'The answer is word',
        }),
        makeFailure({
          taskId: 'f2',
          predicted: 'text',
          groundTruth: '99',
          agentOutput: 'The answer is text',
        }),
        makeFailure({
          taskId: 'f3',
          predicted: 'abc',
          groundTruth: '7',
          agentOutput: 'The answer is abc',
        }),
        // 2x could be hallucination (confident + wrong, no format mismatch)
        makeFailure({
          taskId: 'f4',
          predicted: '37',
          groundTruth: '42',
          agentOutput: 'The answer is definitely 37. This is a well-known fact.',
        }),
        makeFailure({
          taskId: 'f5',
          predicted: '99',
          groundTruth: '100',
          agentOutput: 'The answer is clearly 99. No doubt about it.',
        }),
      ]

      const patterns = analyzer.analyze(failures)
      // wrong_format (3) should be top category, not hallucination (2)
      expect(patterns[0].category).toBe('wrong_format')
      expect(patterns[0].frequency).toBe(3)

      const hallucinationP = patterns.find((p) => p.category === 'hallucination')
      if (hallucinationP) {
        expect(hallucinationP.frequency).toBeLessThan(patterns[0].frequency)
      }
    })
  })

  // ==========================================================================
  // LLM mode
  // ==========================================================================

  describe('LLM mode', () => {
    it('is available as a configuration option', () => {
      const llmAnalyzer = new FailureAnalyzer({ mode: 'llm' })
      // LLM mode currently falls back to heuristic
      const failures = [makeFailure({ agentOutput: 'Cannot determine the answer' })]
      const patterns = llmAnalyzer.analyze(failures)
      expect(patterns).toHaveLength(1)
    })
  })
})
