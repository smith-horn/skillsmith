/**
 * Tests for the SMI-5841 lint-linear-issues CLI arg parsing.
 *
 * The `validateIssueDescription` validation-contract tests moved to
 * `scripts/tests/linear-issue-validation.test.ts` (SMI-5846) alongside the
 * extraction of that contract into `scripts/lib/linear-issue-validation.mjs`.
 */
import { describe, expect, it } from 'vitest'

interface LintIssueLabel {
  name: string
}

interface LintIssue {
  labels?: { nodes: LintIssueLabel[] }
}

const mod = (await import('../lint-linear-issues.mjs')) as {
  parseArgs: (argv: string[]) => { since: Date; json: boolean }
  isBotGeneratedIssue: (issue: LintIssue, botLabels?: string[]) => boolean
  BOT_LABELS: string[]
}

const { parseArgs, isBotGeneratedIssue, BOT_LABELS } = mod

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

describe('isBotGeneratedIssue (SMI-5853)', () => {
  it('returns false when the issue has no labels field at all', () => {
    expect(isBotGeneratedIssue({})).toBe(false)
  })

  it('returns false when labels.nodes is empty', () => {
    expect(isBotGeneratedIssue({ labels: { nodes: [] } })).toBe(false)
  })

  it('returns true when labels.nodes contains a known bot label', () => {
    expect(isBotGeneratedIssue({ labels: { nodes: [{ name: 'version-drift-auto' }] } })).toBe(true)
  })

  it('returns true when a bot label is present alongside an unrelated label', () => {
    expect(
      isBotGeneratedIssue({
        labels: { nodes: [{ name: 'bug' }, { name: 'version-drift-auto' }] },
      })
    ).toBe(true)
  })

  it('returns false when only an unrelated label is present', () => {
    expect(isBotGeneratedIssue({ labels: { nodes: [{ name: 'bug' }] } })).toBe(false)
  })

  it('uses a custom botLabels array when explicitly passed', () => {
    const issue = { labels: { nodes: [{ name: 'custom-bot-label' }] } }
    expect(isBotGeneratedIssue(issue, BOT_LABELS)).toBe(false)
    expect(isBotGeneratedIssue(issue, ['custom-bot-label'])).toBe(true)
  })
})

describe('isBotGeneratedIssue - SMI-5855 e2e-failure-auto exclusion', () => {
  it('returns true when labels.nodes contains e2e-failure-auto under the default BOT_LABELS', () => {
    expect(isBotGeneratedIssue({ labels: { nodes: [{ name: 'e2e-failure-auto' }] } })).toBe(true)
  })

  it('returns false when the issue carries only "Bug" — Bug must never count as bot-generated', () => {
    expect(isBotGeneratedIssue({ labels: { nodes: [{ name: 'Bug' }] } })).toBe(false)
  })

  it('BOT_LABELS includes e2e-failure-auto and never includes the broad human "Bug" label', () => {
    expect(BOT_LABELS).toContain('e2e-failure-auto')
    expect(BOT_LABELS).not.toContain('Bug')
  })
})
