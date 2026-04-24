/**
 * Unit tests for the pure gate-verdict logic in scripts/token-delta-harness.mjs.
 *
 * Covers SMI-4440 additions:
 *   - gateVerdict: 'PASS' when median reduction >= 40% and MCP tool invoked
 *   - gateVerdict: 'FAIL' when median reduction < 40%
 *   - gateVerdict: 'FAIL' when no measured data (m === null / undefined)
 *   - gateVerdict: 'FAIL_TOOL_NOT_INVOKED' when measured ran but mcpSearchCalls == 0
 *   - Median calculation: odd and even task counts
 *   - toolNotInvokedTasks accumulates correctly
 */
import { describe, it, expect } from 'vitest'

const { computeGateVerdict } = (await import('../token-delta-harness.mjs')) as {
  computeGateVerdict: (
    runs: Record<
      string,
      {
        baseline?: { totalInputAll?: number; totalCostUsd?: number; turns?: number }
        measured?: {
          totalInputAll?: number
          totalCostUsd?: number
          turns?: number
          toolCalls?: Record<string, number>
        }
      }
    >
  ) => {
    rows: object[]
    medianReductionPct: number | null
    gate: string
    gateVerdict: 'PASS' | 'FAIL' | 'FAIL_TOOL_NOT_INVOKED'
    toolInvocationFailure: boolean
    toolNotInvokedTasks: string[]
  }
}

const MCP_TOOL = 'mcp__skillsmith-doc-retrieval__skill_docs_search'

function makeRun(
  baselineTotal: number,
  measuredTotal: number,
  mcpCalls: number
): {
  baseline: { totalInputAll: number }
  measured: { totalInputAll: number; toolCalls: Record<string, number> }
} {
  return {
    baseline: { totalInputAll: baselineTotal },
    measured: { totalInputAll: measuredTotal, toolCalls: { [MCP_TOOL]: mcpCalls } },
  }
}

describe('computeGateVerdict', () => {
  describe('PASS', () => {
    it('returns PASS when median >= 40% and MCP tool was invoked', () => {
      const runs = {
        taskA: makeRun(100_000, 50_000, 3), // 50% reduction
        taskB: makeRun(200_000, 100_000, 2), // 50% reduction
        taskC: makeRun(150_000, 75_000, 1), // 50% reduction
      }
      const result = computeGateVerdict(runs)
      expect(result.gateVerdict).toBe('PASS')
      expect(result.medianReductionPct).toBe(50)
      expect(result.toolInvocationFailure).toBe(false)
      expect(result.toolNotInvokedTasks).toEqual([])
    })

    it('returns PASS at exactly 40% median reduction', () => {
      const runs = { taskA: makeRun(100_000, 60_000, 1) } // 40% reduction
      const result = computeGateVerdict(runs)
      expect(result.gateVerdict).toBe('PASS')
      expect(result.medianReductionPct).toBe(40)
    })
  })

  describe('FAIL', () => {
    it('returns FAIL when median reduction < 40%', () => {
      const runs = { taskA: makeRun(100_000, 80_000, 2) } // 20% reduction
      const result = computeGateVerdict(runs)
      expect(result.gateVerdict).toBe('FAIL')
      expect(result.medianReductionPct).toBeCloseTo(20, 5)
      expect(result.toolInvocationFailure).toBe(false)
    })

    it('returns FAIL (not FAIL_TOOL_NOT_INVOKED) when measured data is missing', () => {
      // m === undefined means the measured run never happened
      const runs = {
        taskA: { baseline: { totalInputAll: 100_000 }, measured: undefined },
      }
      const result = computeGateVerdict(runs)
      expect(result.gateVerdict).toBe('FAIL')
      expect(result.medianReductionPct).toBeNull()
      expect(result.toolInvocationFailure).toBe(false)
      expect(result.toolNotInvokedTasks).toEqual([])
    })

    it('returns FAIL with null median when runs is empty', () => {
      const result = computeGateVerdict({})
      expect(result.gateVerdict).toBe('FAIL')
      expect(result.medianReductionPct).toBeNull()
    })

    it('returns FAIL when baseline is 0 (division guard)', () => {
      const runs = { taskA: makeRun(0, 50_000, 1) }
      const result = computeGateVerdict(runs)
      expect(result.gateVerdict).toBe('FAIL')
      expect(result.medianReductionPct).toBeNull()
    })
  })

  describe('FAIL_TOOL_NOT_INVOKED', () => {
    it('returns FAIL_TOOL_NOT_INVOKED when measured ran but MCP tool call count is 0', () => {
      const runs = { taskA: makeRun(100_000, 50_000, 0) } // tool not used
      const result = computeGateVerdict(runs)
      expect(result.gateVerdict).toBe('FAIL_TOOL_NOT_INVOKED')
      expect(result.toolInvocationFailure).toBe(true)
      expect(result.toolNotInvokedTasks).toEqual(['taskA'])
    })

    it('accumulates all tasks where MCP tool was not invoked', () => {
      const runs = {
        taskA: makeRun(100_000, 50_000, 0),
        taskB: makeRun(200_000, 100_000, 2), // invoked — should not appear
        taskC: makeRun(150_000, 90_000, 0),
      }
      const result = computeGateVerdict(runs)
      expect(result.gateVerdict).toBe('FAIL_TOOL_NOT_INVOKED')
      expect(result.toolNotInvokedTasks).toContain('taskA')
      expect(result.toolNotInvokedTasks).toContain('taskC')
      expect(result.toolNotInvokedTasks).not.toContain('taskB')
    })

    it('takes priority over median check even when median would pass', () => {
      // 50% reduction but tool not invoked — verdict must be FAIL_TOOL_NOT_INVOKED
      const runs = { taskA: makeRun(100_000, 50_000, 0) }
      const result = computeGateVerdict(runs)
      expect(result.gateVerdict).toBe('FAIL_TOOL_NOT_INVOKED')
    })
  })

  describe('median computation', () => {
    it('uses middle value for odd-count task sets', () => {
      // Reductions: 10%, 30%, 50% → sorted → median = 30%
      const runs = {
        taskA: makeRun(100_000, 90_000, 1), // 10%
        taskB: makeRun(100_000, 50_000, 1), // 50%
        taskC: makeRun(100_000, 70_000, 1), // 30%
      }
      const result = computeGateVerdict(runs)
      expect(result.medianReductionPct).toBeCloseTo(30, 5)
      expect(result.gateVerdict).toBe('FAIL') // 30% < 40%
    })

    it('averages two middle values for even-count task sets', () => {
      // Reductions: 20%, 40% → median = 30%
      const runs = {
        taskA: makeRun(100_000, 80_000, 1), // 20%
        taskB: makeRun(100_000, 60_000, 1), // 40%
      }
      const result = computeGateVerdict(runs)
      expect(result.medianReductionPct).toBe(30)
    })
  })

  describe('output shape', () => {
    it('always includes gate field set to ">=40"', () => {
      const result = computeGateVerdict({})
      expect(result.gate).toBe('>=40')
    })

    it('includes deltaPct: null for incomplete rows', () => {
      const runs = { taskA: { baseline: { totalInputAll: 100_000 } } }
      const result = computeGateVerdict(runs)
      const row = result.rows[0] as { deltaPct: null }
      expect(row.deltaPct).toBeNull()
    })
  })
})
