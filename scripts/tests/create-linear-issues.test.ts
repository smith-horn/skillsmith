/**
 * SMI-5855: Tests for scripts/e2e/create-linear-issues.ts.
 *
 * The mutation this script fires used to omit the required `teamId` field,
 * so it never created a single issue (silent — the workflow step is
 * `continue-on-error: true`). Covers the fix: a complete mutation input,
 * resolved `Bug` (resolve-only)/`e2e-failure-auto` (get-or-create) labels, a
 * discriminated create-issue outcome instead of `string | null`, and the
 * guarded-first-live-rollout volume controls (cap, dedup, summary, nonzero
 * exit) from the plan doc's Rollout/Risk "Gap B" section.
 *
 * Fixtures + the query-routed fetch mock live in
 * `create-linear-issues-test-helpers.ts` (mirrors the
 * `linear-api-test-helpers.ts` split SMI-5854 used for the same 500-line
 * reason). No module-level cache exists in create-linear-issues.ts (unlike
 * scripts/linear-api.mjs's teamCache), so no per-test `vi.resetModules()`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  formatFailureAsIssue,
  fileIssuesForFailures,
  createLinearIssue,
  main,
  MAX_ISSUES_PER_RUN,
  type TestFailure,
} from '../e2e/create-linear-issues'
// @ts-expect-error -- plain ESM module, no .d.ts
import { validateIssueDescription } from '../lib/linear-issue-validation.mjs'
import {
  PLAIN_FAILURE,
  HARDCODED_FAILURE,
  mockRoutedFetch,
  callQueries,
  findCallBody,
  route,
  baseRoutes,
  httpError,
  transportError,
  isTeamQuery,
  isAutoLabelCreate,
  isIssueCreateMutation,
  TEAM_OK,
  BUG_NOT_FOUND,
  AUTO_NOT_FOUND,
  AUTO_CREATE_OK,
  AUTO_CREATE_FAIL,
  openIssues,
  issueCreateOk,
  ISSUE_CREATE_FAIL_SUCCESS_FALSE,
  ISSUE_CREATE_GQL_ERRORS,
} from './create-linear-issues-test-helpers'

beforeEach(() => {
  process.env.LINEAR_API_KEY = 'test-key'
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  // @ts-expect-error -- undo patch
  delete global.fetch
  delete process.env.LINEAR_API_KEY
})

// --- 1. formatFailureAsIssue: label set + priority (Q3(b')) ---

describe('formatFailureAsIssue (SMI-5855)', () => {
  it('a hardcoded-value failure gets priority 2 and the constant label set', () => {
    const result = formatFailureAsIssue(HARDCODED_FAILURE)
    expect(result.priority).toBe(2)
    expect(result.title).toContain('absolute-path')
    expect(result.labels).toEqual(['Bug', 'e2e-failure-auto'])
  })

  it('a plain failure gets priority 3 and the same constant label set', () => {
    const result = formatFailureAsIssue(PLAIN_FAILURE)
    expect(result.priority).toBe(3)
    expect(result.labels).toEqual(['Bug', 'e2e-failure-auto'])
  })

  it('the label set no longer varies on hasHardcoded, and never includes "hardcoded"', () => {
    const hardcoded = formatFailureAsIssue(HARDCODED_FAILURE)
    const plain = formatFailureAsIssue(PLAIN_FAILURE)
    expect(hardcoded.labels).toEqual(plain.labels)
    expect(hardcoded.labels).not.toContain('hardcoded')
  })
})

// --- 2. Acceptance Criteria section ---

describe('formatFailureAsIssue - Acceptance Criteria section (SMI-5855)', () => {
  it('the generated description clears validateIssueDescription for a plain failure', () => {
    const { description } = formatFailureAsIssue(PLAIN_FAILURE)
    expect(description).toContain('## Acceptance Criteria')
    expect(validateIssueDescription(description)).toEqual([])
  })

  it('the generated description clears validateIssueDescription for a hardcoded failure', () => {
    const { description } = formatFailureAsIssue(HARDCODED_FAILURE)
    expect(validateIssueDescription(description)).toEqual([])
  })
})

// --- 3 & 6 (unit-level sub-cases): createLinearIssue mutation input + failure surfacing ---

describe('createLinearIssue (SMI-5855)', () => {
  it('sends teamId and non-empty labelIds alongside title/description/priority; returns a created outcome', async () => {
    const fetchMock = mockRoutedFetch([route(isIssueCreateMutation, issueCreateOk('SMI-9999'))])
    const input = formatFailureAsIssue(PLAIN_FAILURE)

    const outcome = await createLinearIssue(input, 'team-uuid', ['bug-uuid', 'auto-uuid'])

    expect(outcome).toEqual({ status: 'created', identifier: 'SMI-9999' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = findCallBody(fetchMock, isIssueCreateMutation)
    expect(body.variables.input).toMatchObject({
      teamId: 'team-uuid',
      title: input.title,
      description: input.description,
      priority: input.priority,
      labelIds: ['bug-uuid', 'auto-uuid'],
    })
  })

  it('an HTTP failure (ok: false) surfaces as a failed outcome', async () => {
    mockRoutedFetch([route(isIssueCreateMutation, httpError(500))])
    const outcome = await createLinearIssue(formatFailureAsIssue(PLAIN_FAILURE), 'team-uuid', [])
    expect(outcome.status).toBe('failed')
  })

  it('a GraphQL errors array surfaces as a failed outcome', async () => {
    mockRoutedFetch([route(isIssueCreateMutation, ISSUE_CREATE_GQL_ERRORS)])
    const outcome = await createLinearIssue(formatFailureAsIssue(PLAIN_FAILURE), 'team-uuid', [])
    expect(outcome.status).toBe('failed')
  })

  it('issueCreate.success === false surfaces as a failed outcome', async () => {
    mockRoutedFetch([route(isIssueCreateMutation, ISSUE_CREATE_FAIL_SUCCESS_FALSE)])
    const outcome = await createLinearIssue(formatFailureAsIssue(PLAIN_FAILURE), 'team-uuid', [])
    expect(outcome.status).toBe('failed')
  })

  it('a thrown transport error surfaces as a failed outcome', async () => {
    mockRoutedFetch([route(isIssueCreateMutation, transportError())])
    const outcome = await createLinearIssue(formatFailureAsIssue(PLAIN_FAILURE), 'team-uuid', [])
    expect(outcome.status).toBe('failed')
  })
})

// --- 4. Bug resolve-only ---

describe("fileIssuesForFailures - Bug resolve-only (SMI-5855, Q3(b'))", () => {
  it('resolves the workspace-level Bug label and includes it in labelIds, without creating it', async () => {
    vi.useFakeTimers()
    const fetchMock = mockRoutedFetch(baseRoutes({ issueCreate: [issueCreateOk('SMI-1001')] }))

    const promise = fileIssuesForFailures([PLAIN_FAILURE])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.created).toBe(1)
    const body = findCallBody(fetchMock, isIssueCreateMutation)
    expect(body.variables.input.labelIds).toEqual(['bug-uuid', 'auto-uuid'])
    expect(callQueries(fetchMock).some(isAutoLabelCreate)).toBe(false)
  })

  it('Bug not found: omitted from labelIds, no issueLabelCreate attempted, the run continues', async () => {
    vi.useFakeTimers()
    const fetchMock = mockRoutedFetch(
      baseRoutes({ bug: [BUG_NOT_FOUND], issueCreate: [issueCreateOk('SMI-1002')] })
    )

    const promise = fileIssuesForFailures([PLAIN_FAILURE])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.created).toBe(1)
    expect(summary.failed).toBe(0)
    const body = findCallBody(fetchMock, isIssueCreateMutation)
    expect(body.variables.input.labelIds).toEqual(['auto-uuid'])
    expect(callQueries(fetchMock).some(isAutoLabelCreate)).toBe(false)
  })
})

// --- 5. e2e-failure-auto get-or-create ---

describe("fileIssuesForFailures - e2e-failure-auto get-or-create (SMI-5855, Q3(b'))", () => {
  it('creates the label when not found, and uses the newly created id', async () => {
    vi.useFakeTimers()
    const fetchMock = mockRoutedFetch(
      baseRoutes({
        auto: [AUTO_NOT_FOUND],
        autoCreate: [AUTO_CREATE_OK],
        issueCreate: [issueCreateOk('SMI-2001')],
      })
    )

    const promise = fileIssuesForFailures([PLAIN_FAILURE])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.created).toBe(1)
    const body = findCallBody(fetchMock, isIssueCreateMutation)
    expect(body.variables.input.labelIds).toContain('new-auto-uuid')
  })

  it('does not call issueLabelCreate when the label already exists', async () => {
    vi.useFakeTimers()
    const fetchMock = mockRoutedFetch(baseRoutes({ issueCreate: [issueCreateOk('SMI-2002')] }))

    const promise = fileIssuesForFailures([PLAIN_FAILURE])
    await vi.runAllTimersAsync()
    await promise

    expect(callQueries(fetchMock).some(isAutoLabelCreate)).toBe(false)
  })

  it('issueLabelCreate returning success:false surfaces as a run failure, not a silent skip', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockRoutedFetch(baseRoutes({ auto: [AUTO_NOT_FOUND], autoCreate: [AUTO_CREATE_FAIL] }))

    const promise = fileIssuesForFailures([PLAIN_FAILURE])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.created).toBe(0)
    expect(summary.attempted).toBe(0)
    expect(summary.failed).toBe(1)
    expect(errorSpy).toHaveBeenCalled()
  })
})

// --- 6 (aggregate sub-case): mixed run ---

describe('fileIssuesForFailures - mutation-failure surfacing (SMI-5855, R7)', () => {
  it('one created, one failed: summary counts reflect the mixed outcome', async () => {
    vi.useFakeTimers()
    const secondFailure: TestFailure = { ...PLAIN_FAILURE, testName: 'a different failing test' }
    mockRoutedFetch(
      baseRoutes({ issueCreate: [issueCreateOk('SMI-3001'), ISSUE_CREATE_FAIL_SUCCESS_FALSE] })
    )

    const promise = fileIssuesForFailures([PLAIN_FAILURE, secondFailure])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.attempted).toBe(2)
    expect(summary.created).toBe(1)
    expect(summary.failed).toBe(1)
  })
})

// --- 7. Dedup ---

describe('fileIssuesForFailures - dedup (SMI-5855, R8)', () => {
  it('skips a failure whose title matches an already-open issue', async () => {
    vi.useFakeTimers()
    const title = formatFailureAsIssue(PLAIN_FAILURE).title
    const fetchMock = mockRoutedFetch(baseRoutes({ open: [openIssues([title])] }))

    const promise = fileIssuesForFailures([PLAIN_FAILURE])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.skippedDuplicate).toBe(1)
    expect(summary.created).toBe(0)
    expect(callQueries(fetchMock).some(isIssueCreateMutation)).toBe(false)
  })

  it('two identical failures within one run (cli + mcp) produce exactly one creation', async () => {
    vi.useFakeTimers()
    const fetchMock = mockRoutedFetch(baseRoutes({ issueCreate: [issueCreateOk('SMI-4001')] }))

    const promise = fileIssuesForFailures([PLAIN_FAILURE, { ...PLAIN_FAILURE }])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.created).toBe(1)
    expect(summary.skippedDuplicate).toBe(1)
    expect(callQueries(fetchMock).filter(isIssueCreateMutation)).toHaveLength(1)
  })
})

// --- 8. Cap ---

describe('fileIssuesForFailures - cap (SMI-5855, R8)', () => {
  it('suppresses attempts beyond MAX_ISSUES_PER_RUN', async () => {
    vi.useFakeTimers()
    const failures: TestFailure[] = Array.from({ length: 25 }, (_, i) => ({
      ...PLAIN_FAILURE,
      testName: `failing test #${i}`,
    }))
    const issueCreateResponses = Array.from({ length: MAX_ISSUES_PER_RUN }, (_, i) =>
      issueCreateOk(`SMI-500${i}`)
    )
    const fetchMock = mockRoutedFetch(baseRoutes({ issueCreate: issueCreateResponses }))

    const promise = fileIssuesForFailures(failures)
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.created).toBe(MAX_ISSUES_PER_RUN)
    expect(summary.suppressedByCap).toBe(25 - MAX_ISSUES_PER_RUN)
    expect(callQueries(fetchMock).filter(isIssueCreateMutation)).toHaveLength(MAX_ISSUES_PER_RUN)
  })
})

// --- 9. Resolution retry ---

describe('fileIssuesForFailures - resolution retry (SMI-5855, R5)', () => {
  it('a transient 503 on the one-time team lookup, followed by success, proceeds normally', async () => {
    vi.useFakeTimers()
    const fetchMock = mockRoutedFetch(
      baseRoutes({ team: [httpError(503), TEAM_OK], issueCreate: [issueCreateOk('SMI-6001')] })
    )

    const promise = fileIssuesForFailures([PLAIN_FAILURE])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.created).toBe(1)
    expect(callQueries(fetchMock).filter(isTeamQuery)).toHaveLength(2)
  })

  it('retries exhausted: zero creations, all failures counted failed, the reason is logged', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockRoutedFetch(
      baseRoutes({ team: [httpError(503), httpError(503), httpError(503), httpError(503)] })
    )

    const promise = fileIssuesForFailures([PLAIN_FAILURE])
    await vi.runAllTimersAsync()
    const summary = await promise

    expect(summary.created).toBe(0)
    expect(summary.failed).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve team/labels'))
  })
})

// --- 10. No-API-key path ---

describe('main - no LINEAR_API_KEY (SMI-5855)', () => {
  it('exits 0 without attempting any fetch when LINEAR_API_KEY is unset', async () => {
    delete process.env.LINEAR_API_KEY
    const fetchSpy = vi.fn()
    // @ts-expect-error -- patch global fetch
    global.fetch = fetchSpy
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(main()).rejects.toThrow('process.exit(0)')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('LINEAR_API_KEY not set'))
  })
})
