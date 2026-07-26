/**
 * Tests for the SMI-5841 lint-linear-issues CLI arg parsing.
 *
 * The `validateIssueDescription` validation-contract tests moved to
 * `scripts/tests/linear-issue-validation.test.ts` (SMI-5846) alongside the
 * extraction of that contract into `scripts/lib/linear-issue-validation.mjs`.
 */
import { describe, expect, it } from 'vitest'

const mod = (await import('../lint-linear-issues.mjs')) as {
  parseArgs: (argv: string[]) => { since: Date; json: boolean }
}

const { parseArgs } = mod

describe('parseArgs (SMI-5841)', () => {
  it('defaults to roughly 48h ago when --since is omitted', () => {
    const before = Date.now()
    const { since } = parseArgs([])
    const expectedMs = before - 48 * 60 * 60 * 1000
    expect(Math.abs(since.getTime() - expectedMs)).toBeLessThan(5000)
  })

  it('parses an explicit --since date', () => {
    const { since } = parseArgs(['--since', '2026-01-01'])
    expect(since.toISOString().startsWith('2026-01-01')).toBe(true)
  })

  it('--json sets json to true', () => {
    expect(parseArgs(['--json']).json).toBe(true)
    expect(parseArgs([]).json).toBe(false)
  })
})
