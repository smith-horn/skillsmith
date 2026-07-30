/**
 * SMI-5879 (8.3.3.2, SMI-O): `run.ts` line-budget backstop.
 *
 * `run.ts` is measured at 496 lines — four under the `audit:standards`
 * 500-line gate (itself scoped to `packages/`+`apps/` only, so `scripts/`
 * files aren't actually covered by that generic check; see this wave's
 * final report for the discrepancy). Adding Gate C (import + call) consumes
 * two of those four lines, landing at exactly 498/500 — two lines of
 * headroom, zero comment budget. A later comment addition on those two new
 * lines must fail HERE, on a named test with an explanatory message, rather
 * than surface only as a generic audit finding at push time (or not at all,
 * given the `scripts/` gap above). SMI-O (extracting run.ts's audit-summary
 * assembly block to a sibling to restore headroom) is a separate follow-up,
 * not fixed by this test.
 */

import { describe, it, expect } from 'vitest'
import { readIndexerSource } from './run-gate-ast-helpers.ts'

const MAX_LINES = 498

/**
 * Real (editor/`wc -l`-equivalent) line count. Deliberately NOT
 * `content.split('\n').length` — for any file ending in a trailing newline
 * (the prettier-enforced norm here), that naive form over-counts by exactly
 * one (an empty trailing segment), which would silently make this test's
 * true ceiling 499 rather than the 498 the design doc states and this file's
 * arithmetic is pinned to.
 */
function countRealLines(content: string): number {
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length
}

describe('run.ts line budget', () => {
  it(`stays at or under ${MAX_LINES} lines (SMI-5879 Gate C headroom)`, () => {
    const lineCount = countRealLines(readIndexerSource('run.ts'))
    expect(
      lineCount,
      `run.ts is ${lineCount} lines, over the ${MAX_LINES}-line Gate C budget (8.3.3.2). ` +
        'See SMI-O: extract the audit-summary assembly block to a sibling module before adding more lines here.'
    ).toBeLessThanOrEqual(MAX_LINES)
  })
})
