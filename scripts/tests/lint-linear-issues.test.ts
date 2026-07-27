/**
 * Tests for the SMI-5841 lint-linear-issues CLI arg parsing.
 *
 * The `validateIssueDescription` validation-contract tests moved to
 * `scripts/tests/linear-issue-validation.test.ts` (SMI-5846) alongside the
 * extraction of that contract into `scripts/lib/linear-issue-validation.mjs`.
 *
 * SMI-5858 adds transport-level coverage for `fetchRecentIssues` (exported
 * specifically for this) — this file previously had zero coverage of the
 * retry/pagination/GraphQL-error-exit behavior, all now backed by the
 * shared `scripts/lib/linear-client.mjs`. Reuses the mock-fetch
 * fixtures/helpers from `scripts/tests/linear-api-test-helpers.ts`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { mockFetchSteps } from './linear-api-test-helpers'

interface LintIssueLabel {
  name: string
}

interface LintIssue {
  labels?: { nodes: LintIssueLabel[] }
}

interface RecentIssue {
  identifier: string
  title: string
  url: string
  description: string
  createdAt: string
  labels: { nodes: LintIssueLabel[] }
}

const mod = (await import('../lint-linear-issues.mjs')) as {
  parseArgs: (argv: string[]) => { since: Date; json: boolean }
  isBotGeneratedIssue: (issue: LintIssue, botLabels?: string[]) => boolean
  BOT_LABELS: string[]
  fetchRecentIssues: (since: Date) => Promise<RecentIssue[]>
}

const { parseArgs, isBotGeneratedIssue, BOT_LABELS, fetchRecentIssues } = mod

function recentIssue(identifier: string): RecentIssue {
  return {
    identifier,
    title: `Title for ${identifier}`,
    url: `https://linear.app/smi/issue/${identifier}`,
    description: 'A description',
    createdAt: '2026-01-01T00:00:00.000Z',
    labels: { nodes: [] },
  }
}

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

describe('fetchRecentIssues transport (SMI-5858)', () => {
  const SINCE = new Date('2026-01-01T00:00:00.000Z')

  beforeEach(() => {
    process.env.LINEAR_API_KEY = 'test-key'
  })

  afterEach(() => {
    // @ts-expect-error -- undo patch
    delete global.fetch
    delete process.env.LINEAR_API_KEY
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('retries a simulated 5xx response, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'httpError', status: 503 },
      {
        kind: 'ok',
        body: {
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      },
    ])

    const promise = fetchRecentIssues(SINCE)
    await vi.advanceTimersByTimeAsync(1000)
    const issues = await promise

    expect(issues).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a simulated transport failure (fetch() itself rejects), then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'transportError', error: new Error('ECONNRESET') },
      {
        kind: 'ok',
        body: {
          data: {
            issues: {
              nodes: [recentIssue('SMI-1')],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ])

    const promise = fetchRecentIssues(SINCE)
    await vi.advanceTimersByTimeAsync(1000)
    const issues = await promise

    expect(issues.map((i) => i.identifier)).toEqual(['SMI-1'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('makes exactly one fetch attempt then exits 2 on a GraphQL body-error response, printing the exact stderr text', async () => {
    const errorsArray = [{ message: 'boom' }]
    const fetchMock = mockFetchSteps([{ kind: 'ok', body: { errors: errorsArray } }])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)

    await expect(fetchRecentIssues(SINCE)).rejects.toThrow('process.exit(2)')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'lint-linear-issues: Linear query failed:',
      JSON.stringify(errorsArray)
    )
  })

  it('rethrows (does not exit) a non-GraphQL error once retries are exhausted', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
    ])

    const promise = fetchRecentIssues(SINCE)
    const assertion = expect(promise).rejects.toThrow('500')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    await assertion

    // 1 initial + 3 retries, all failing = 4.
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('merges nodes across two paginated pages in order, in a single logical call', async () => {
    const fetchMock = mockFetchSteps([
      {
        kind: 'ok',
        body: {
          data: {
            issues: {
              nodes: [recentIssue('SMI-1')],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        },
      },
      {
        kind: 'ok',
        body: {
          data: {
            issues: {
              nodes: [recentIssue('SMI-2')],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ])

    const issues = await fetchRecentIssues(SINCE)

    expect(issues.map((i) => i.identifier)).toEqual(['SMI-1', 'SMI-2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
