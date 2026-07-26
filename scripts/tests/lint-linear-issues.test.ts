/**
 * Tests for the SMI-5841 lint-linear-issues ported validation contract.
 *
 * Covers `validateIssueDescription` and `parseArgs` in
 * scripts/lint-linear-issues.mjs. The validation rules are PORTED from
 * ~/.claude/skills/linear/scripts/lib/issue-description.ts (untracked,
 * not reachable from this repo's CI) — these tests exercise the ported
 * copy's own behavior, not the original source.
 */
import { describe, expect, it } from 'vitest'

const mod = (await import('../lint-linear-issues.mjs')) as {
  validateIssueDescription: (description: string | null | undefined) => string[]
  parseArgs: (argv: string[]) => { since: Date; json: boolean }
}

const { validateIssueDescription, parseArgs } = mod

const VALID_DESCRIPTION = [
  '## Context',
  '',
  'This is a sufficiently long description body explaining what changed and why, ' +
    'well past the minimum character threshold for a real issue description.',
  '',
  '## Acceptance Criteria',
  '',
  '- The thing works as described',
  '- A test confirms the behavior',
].join('\n')

describe('validateIssueDescription (SMI-5841)', () => {
  it('a well-formed description passes with zero errors', () => {
    expect(validateIssueDescription(VALID_DESCRIPTION)).toEqual([])
  })

  it('null description fails safe (does not throw) — the exact mcp__linear__save_issue-with-no-description shape', () => {
    expect(() => validateIssueDescription(null)).not.toThrow()
    const errors = validateIssueDescription(null)
    expect(errors).toContain('Description is empty')
  })

  it('undefined description fails safe (does not throw)', () => {
    expect(() => validateIssueDescription(undefined)).not.toThrow()
    expect(validateIssueDescription(undefined)).toContain('Description is empty')
  })

  it('empty string fails with "Description is empty"', () => {
    expect(validateIssueDescription('')).toEqual(['Description is empty'])
  })

  it('whitespace-only string fails with "Description is empty"', () => {
    expect(validateIssueDescription('   \n\n  ')).toEqual(['Description is empty'])
  })

  it('missing Acceptance Criteria heading is flagged', () => {
    const description = 'A description with plenty of body text but no AC section at all here.'
    const errors = validateIssueDescription(description)
    expect(errors).toContain('Acceptance Criteria heading missing')
  })

  it('Acceptance Criteria heading with zero items below it is flagged', () => {
    const description = [
      'A sufficiently long description body explaining the change in enough detail.',
      '',
      '## Acceptance Criteria',
    ].join('\n')
    const errors = validateIssueDescription(description)
    expect(errors.some((e) => e.includes('Fewer than 2'))).toBe(true)
  })

  it('Acceptance Criteria heading as the terminal line (no trailing newline/content) still produces a zero-item violation, not a crash', () => {
    const description =
      'Sufficiently long body text explaining the change in real detail.\n\n## Acceptance Criteria'
    expect(() => validateIssueDescription(description)).not.toThrow()
    const errors = validateIssueDescription(description)
    expect(errors.some((e) => e.includes('Fewer than 2'))).toBe(true)
  })

  it('placeholder-only bullets do not count toward the minimum', () => {
    const description = [
      'A sufficiently long description body explaining the change in real detail here.',
      '',
      '## Acceptance Criteria',
      '',
      '- TODO',
      '- <criterion>',
      '- ???',
      '- ...',
    ].join('\n')
    const errors = validateIssueDescription(description)
    expect(errors.some((e) => e.includes('Fewer than 2'))).toBe(true)
  })

  it('nested/indented bullets under Acceptance Criteria are still counted', () => {
    const description = [
      'A sufficiently long description body explaining the change in real detail here.',
      '',
      '## Acceptance Criteria',
      '',
      '  - Indented first criterion that is concrete and testable',
      '  - Indented second criterion that is concrete and testable',
    ].join('\n')
    expect(validateIssueDescription(description)).toEqual(
      expect.not.arrayContaining([expect.stringContaining('Fewer than')])
    )
  })

  it('body length is checked below the MIN_BODY_CHARS threshold', () => {
    const description = ['## Acceptance Criteria', '', '- Short one', '- Short two'].join('\n')
    const errors = validateIssueDescription(description)
    expect(errors.some((e) => e.includes('minimum is 120'))).toBe(true)
  })
})

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
