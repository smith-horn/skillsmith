import { describe, it, expect, vi } from 'vitest'
import { IterativeEvaluator } from '../../src/evaluation/IterativeEvaluator.js'
import type { AgentRunner, EvalTask } from '../../src/evaluation/IterativeEvaluator.js'

function makeTasks(count: number, split: string): EvalTask[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${split}-${i}`,
    question: `Question ${i}?`,
    groundTruth: `answer${i}`,
  }))
}

function createMockRunner(correctRate = 0.5): AgentRunner {
  let callCount = 0
  return {
    run: vi.fn().mockImplementation(async ({ question }: { question: string }) => {
      callCount++
      const idx = parseInt(question.match(/\d+/)?.[0] ?? '0', 10)
      // Return correct answer for the first `correctRate` fraction of tasks
      const isCorrect = idx < Math.ceil(10 * correctRate)
      return {
        predicted: isCorrect ? `answer${idx}` : 'wrong',
        agentOutput: isCorrect ? `The answer is answer${idx}` : 'I think the answer is wrong',
        costTokens: 100,
        toolCallFailed: false,
        toolCallCount: 1,
      }
    }),
  }
}

const trainTasks = makeTasks(10, 'train')
const valTasks = makeTasks(10, 'val')
const testTasks = makeTasks(5, 'test')

const BASELINE_SKILL = '# Test Skill\n\n## Instructions\n\nDo something useful.\n'

describe('IterativeEvaluator', () => {
  describe('pre-loop baseline evaluation', () => {
    it('seeds frontier with baseline accuracy (not 0)', async () => {
      const runner = createMockRunner(0.6)
      const evaluator = new IterativeEvaluator({
        maxIterations: 1,
        frontierSize: 3,
        earlyStoppingPatience: 3,
        costBudget: 100_000,
        scorer: (_q, predicted, gt) => (predicted === gt ? 1.0 : 0.0),
        agentRunner: runner,
        generationStrategies: ['augment'],
      })

      const result = await evaluator.run(
        BASELINE_SKILL,
        'test-skill',
        trainTasks,
        valTasks,
        testTasks
      )

      // Convergence curve starts at iteration 0 with real accuracy
      expect(result.convergenceCurve[0].iteration).toBe(0)
      expect(result.convergenceCurve[0].bestAccuracy).toBeGreaterThan(0)
    })
  })

  describe('early stopping', () => {
    it('stops after patience iterations without improvement', async () => {
      // Runner always returns same answers → accuracy never improves
      const runner = createMockRunner(0.5)
      const evaluator = new IterativeEvaluator({
        maxIterations: 20,
        frontierSize: 3,
        earlyStoppingPatience: 3,
        costBudget: 1_000_000,
        scorer: (_q, predicted, gt) => (predicted === gt ? 1.0 : 0.0),
        agentRunner: runner,
        generationStrategies: ['augment'],
      })

      const result = await evaluator.run(
        BASELINE_SKILL,
        'test-skill',
        trainTasks,
        valTasks,
        testTasks
      )

      expect(result.totalIterations).toBeLessThanOrEqual(20)
      expect(result.earlyStopReason).toContain('no improvement')
    })
  })

  describe('cost budget enforcement', () => {
    it('stops when budget is exhausted', async () => {
      const runner = createMockRunner(0.5)
      const evaluator = new IterativeEvaluator({
        maxIterations: 100,
        frontierSize: 3,
        earlyStoppingPatience: 100,
        costBudget: 500, // Very tight budget — each task costs 100 tokens
        scorer: (_q, predicted, gt) => (predicted === gt ? 1.0 : 0.0),
        agentRunner: runner,
        generationStrategies: ['augment'],
      })

      const result = await evaluator.run(
        BASELINE_SKILL,
        'test-skill',
        trainTasks,
        valTasks,
        testTasks
      )

      expect(result.earlyStopReason).toContain('budget exhausted')
      expect(result.totalCost).toBeGreaterThanOrEqual(500)
    })
  })

  describe('convergence curve', () => {
    it('records a snapshot per iteration', async () => {
      const runner = createMockRunner(0.5)
      const evaluator = new IterativeEvaluator({
        maxIterations: 2,
        frontierSize: 3,
        earlyStoppingPatience: 10,
        costBudget: 1_000_000,
        scorer: (_q, predicted, gt) => (predicted === gt ? 1.0 : 0.0),
        agentRunner: runner,
        generationStrategies: ['augment'],
      })

      const result = await evaluator.run(
        BASELINE_SKILL,
        'test-skill',
        trainTasks,
        valTasks,
        testTasks
      )

      // iteration 0 (baseline) + up to 2 iterations
      expect(result.convergenceCurve.length).toBeGreaterThanOrEqual(2)
      // Each snapshot has required fields
      for (const snap of result.convergenceCurve) {
        expect(snap).toHaveProperty('iteration')
        expect(snap).toHaveProperty('bestAccuracy')
        expect(snap).toHaveProperty('cost')
      }
    })
  })

  describe('frontier updates', () => {
    it('returns final frontier with scored variants', async () => {
      const runner = createMockRunner(0.5)
      const evaluator = new IterativeEvaluator({
        maxIterations: 1,
        frontierSize: 3,
        earlyStoppingPatience: 10,
        costBudget: 1_000_000,
        scorer: (_q, predicted, gt) => (predicted === gt ? 1.0 : 0.0),
        agentRunner: runner,
        generationStrategies: ['augment'],
      })

      const result = await evaluator.run(
        BASELINE_SKILL,
        'test-skill',
        trainTasks,
        valTasks,
        testTasks
      )

      expect(result.finalFrontier.length).toBeGreaterThanOrEqual(1)
      for (const scored of result.finalFrontier) {
        expect(scored.variant).toBeDefined()
        expect(scored.accuracy).toBeGreaterThanOrEqual(0)
        expect(scored.accuracy).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('test split isolation', () => {
    it('evaluates test split only at the end', async () => {
      const runner = createMockRunner(0.5)
      const evaluator = new IterativeEvaluator({
        maxIterations: 1,
        frontierSize: 3,
        earlyStoppingPatience: 10,
        costBudget: 1_000_000,
        scorer: (_q, predicted, gt) => (predicted === gt ? 1.0 : 0.0),
        agentRunner: runner,
        generationStrategies: ['augment'],
      })

      const result = await evaluator.run(
        BASELINE_SKILL,
        'test-skill',
        trainTasks,
        valTasks,
        testTasks
      )

      expect(result.testAccuracy).toBeDefined()
      expect(result.testAccuracy).toBeGreaterThanOrEqual(0)
      expect(result.testAccuracy).toBeLessThanOrEqual(1)
    })
  })

  describe('log format', () => {
    it('logs in expected format', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const runner = createMockRunner(0.5)
      const evaluator = new IterativeEvaluator({
        maxIterations: 1,
        frontierSize: 3,
        earlyStoppingPatience: 10,
        costBudget: 1_000_000,
        scorer: (_q, predicted, gt) => (predicted === gt ? 1.0 : 0.0),
        agentRunner: runner,
        generationStrategies: ['augment'],
      })

      await evaluator.run(BASELINE_SKILL, 'test-skill', trainTasks, valTasks, testTasks)

      const logCalls = consoleSpy.mock.calls.flat()
      const iterLog = logCalls.find(
        (msg) => typeof msg === 'string' && msg.includes('[IterativeEvaluator]')
      )
      expect(iterLog).toBeDefined()
      expect(iterLog).toContain('[iteration=')
      expect(iterLog).toContain('[best_accuracy=')
      expect(iterLog).toContain('[frontier_size=')
      expect(iterLog).toContain('[cost=')

      consoleSpy.mockRestore()
    })
  })
})
