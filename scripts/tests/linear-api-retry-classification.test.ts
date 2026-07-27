/**
 * SMI-5854 (review follow-up): closes two test-coverage gaps a
 * GPT-5.6-Sol cross-provider code review found in
 * `linear-api-uuid-resolution.test.ts` — both are real gaps (verified
 * against the actual code before fixing, not taken on faith):
 *
 * 1. `isRetryable()`'s classification was only exercised via 500/503
 *    (retryable) and a GraphQL `errors` response (not retryable). Flipping
 *    429 to non-retryable, or flipping an ordinary 4xx to retryable, or
 *    breaking the no-`status` (pure transport failure) branch, would have
 *    left every existing test green.
 * 2. The one `--dry-run` test called `createIssue({ dryRun: true })`
 *    directly, never exercising `commands['create-issue']`'s own
 *    `args['dry-run'] === true` parsing — a typo'd flag name there would
 *    also have left every existing test green.
 *
 * Split into its own file (rather than added to
 * `linear-api-uuid-resolution.test.ts`) to stay clear of
 * `scripts/check-file-length.mjs`'s 500-line pre-commit gate — that file
 * was already at 471 lines.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  importLinearApi,
  mockFetchSteps,
  labelResponse,
  TEAM_RESPONSE,
  ISSUE_CREATE_RESPONSE,
  VALID_DESCRIPTION,
} from './linear-api-test-helpers'

beforeEach(() => {
  process.env.LINEAR_API_KEY = 'test-key'
  vi.resetModules()
})

afterEach(() => {
  // @ts-expect-error -- undo patch
  delete global.fetch
  vi.restoreAllMocks()
})

describe('retry classification (SMI-5854 review follow-up)', () => {
  it('retries a 429 on the label-eq query, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'httpError', status: 429 },
      {
        kind: 'ok',
        body: labelResponse([{ id: 'label-ci-uuid', name: 'ci', team: { id: 'team-uuid' } }]),
      },
      { kind: 'ok', body: ISSUE_CREATE_RESPONSE },
    ])

    const mod = await importLinearApi()
    const promise = mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: ['ci'] })

    await vi.advanceTimersByTimeAsync(1000)
    const issue = await promise

    expect(issue.identifier).toBe('SMI-9999')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry a non-retryable 4xx (404) on the label-eq query', async () => {
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'httpError', status: 404 },
    ])

    const mod = await importLinearApi()
    await expect(
      mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: ['ci'] })
    ).rejects.toThrow('404')

    // team (1) + label-eq (1, no retry) = 2 — a 3rd call would mean 404 was
    // incorrectly classified as retryable.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a pure transport failure (fetch() itself rejects, no status) on the parent lookup', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'transportError', error: new Error('ECONNRESET') },
      { kind: 'ok', body: { data: { issue: { id: 'parent-uuid' } } } },
      { kind: 'ok', body: ISSUE_CREATE_RESPONSE },
    ])

    const mod = await importLinearApi()
    const promise = mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      parentId: 'SMI-4963',
    })

    await vi.advanceTimersByTimeAsync(1000)
    const issue = await promise

    expect(issue.identifier).toBe('SMI-9999')
    // team (1) + parent lookup (1 transport failure + 1 retry) + mutation (1) = 4
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('CLI --dry-run flag wiring (SMI-5854 review follow-up)', () => {
  it('commands["create-issue"] with a parsed --dry-run flag skips issueCreate', async () => {
    const fetchMock = mockFetchSteps([{ kind: 'ok', body: TEAM_RESPONSE }])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    // Mirrors exactly what parseArgs() produces for a bare `--dry-run` flag
    // (parseArgs sets `result[currentKey] = true` when no value token
    // follows) — this is the CLI wiring itself, not createIssue() called
    // directly with a dryRun option.
    const result = (await mod.commands['create-issue']({
      title: 'T',
      description: VALID_DESCRIPTION,
      'dry-run': true,
    })) as { dryRun: true; input: Record<string, unknown> }

    expect(result.dryRun).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1) // team only — no issueCreate
    const printedCall = logSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('"input"')
    )
    expect(printedCall).toBeDefined()
  })

  it('commands["create-issue"] without --dry-run creates the issue for real', async () => {
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'ok', body: ISSUE_CREATE_RESPONSE },
    ])
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = (await mod.commands['create-issue']({
      title: 'T',
      description: VALID_DESCRIPTION,
    })) as { identifier: string }

    expect(issue.identifier).toBe('SMI-9999')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
