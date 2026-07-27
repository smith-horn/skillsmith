/**
 * SMI-5854: Tests for `scripts/linear-api.mjs`'s `createIssue()`
 * parent/label UUID resolution — resolving human-friendly `--parent`
 * (issue identifier) and `--label` (name) CLI values to the UUIDs the
 * Linear GraphQL API's `IssueCreateInput` actually requires, including
 * disambiguation policy, CLI-value normalisation, retry behavior on
 * infrastructure failures, and `--dry-run`.
 *
 * Split out of `scripts/tests/linear-api.test.ts` (SMI-5853's file) to
 * keep both files under `scripts/check-file-length.mjs`'s 500-line
 * pre-commit gate — see `scripts/tests/linear-api-test-helpers.ts` for the
 * shared fixtures/helpers and its header comment for why that module isn't
 * itself a `*.test.ts` file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  importLinearApi,
  mockFetchSequence,
  mockFetchSteps,
  labelResponse,
  issueLookupResponse,
  requestBody,
  TEAM_RESPONSE,
  ISSUE_CREATE_RESPONSE,
  VALID_DESCRIPTION,
  type LabelNode,
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

describe('create-issue parent/label UUID resolution (SMI-5854)', () => {
  afterEach(() => {
    // Only the retry-backoff cases below enable fake timers; always reset so
    // a failure inside one of them can't leak into a later test.
    vi.useRealTimers()
  })

  // --- Happy path + passthrough --------------------------------------

  it('resolves label names to UUIDs and sends them in labelIds', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([{ id: 'label-security-uuid', name: 'Security', team: { id: 'team-uuid' } }]),
      labelResponse([{ id: 'label-ci-uuid', name: 'ci', team: { id: 'team-uuid' } }]),
      ISSUE_CREATE_RESPONSE,
    ])

    const mod = await importLinearApi()
    await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      labels: ['Security', 'ci'],
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const body = requestBody(fetchMock, 3)
    expect((body.variables.input as { labelIds?: string[] }).labelIds).toEqual([
      'label-security-uuid',
      'label-ci-uuid',
    ])
  })

  it('passes a UUID-shaped label entry through without a lookup fetch', async () => {
    const uuidLabel = '11111111-1111-1111-1111-111111111111'
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])

    const mod = await importLinearApi()
    await mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: [uuidLabel] })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = requestBody(fetchMock, 1)
    expect((body.variables.input as { labelIds?: string[] }).labelIds).toEqual([uuidLabel])
  })

  it('resolves a parent identifier to its UUID', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      issueLookupResponse('parent-uuid'),
      ISSUE_CREATE_RESPONSE,
    ])

    const mod = await importLinearApi()
    await mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, parentId: 'SMI-4963' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const body = requestBody(fetchMock, 2)
    expect((body.variables.input as { parentId?: string }).parentId).toBe('parent-uuid')
  })

  it('passes a UUID-shaped parent through without an issue-query fetch', async () => {
    const uuidParent = '22222222-2222-2222-2222-222222222222'
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])

    const mod = await importLinearApi()
    await mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, parentId: uuidParent })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = requestBody(fetchMock, 1)
    expect((body.variables.input as { parentId?: string }).parentId).toBe(uuidParent)
  })

  it('omits parentId/labelIds entirely when neither is given (regression guard)', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])

    const mod = await importLinearApi()
    await mod.createIssue({ title: 'T', description: VALID_DESCRIPTION })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = requestBody(fetchMock, 1)
    expect(body.variables.input).not.toHaveProperty('parentId')
    expect(body.variables.input).not.toHaveProperty('labelIds')
  })

  // --- Q1: resolution policy (parent fails hard, label warns) ---------

  it('throws when --parent does not resolve, without ever calling issueCreate', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, issueLookupResponse(null)])

    const mod = await importLinearApi()
    await expect(
      mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, parentId: 'SMI-9999' })
    ).rejects.toThrow('SMI-9999')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('warns and omits an unresolvable label while still creating the issue (partial resolution)', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([{ id: 'label-security-uuid', name: 'Security', team: { id: 'team-uuid' } }]),
      labelResponse([]),
      ISSUE_CREATE_RESPONSE,
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      labels: ['Security', 'typo'],
    })

    expect(issue.identifier).toBe('SMI-9999')
    const body = requestBody(fetchMock, 3)
    expect((body.variables.input as { labelIds?: string[] }).labelIds).toEqual([
      'label-security-uuid',
    ])
    const warnings = warnSpy.mock.calls.map((c) => c[0] as string)
    expect(warnings.some((m) => m.includes('[linear-api]') && m.includes('"typo" not found'))).toBe(
      true
    )
  })

  it('prints a post-create summary naming the created issue and the omitted label', async () => {
    mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([{ id: 'label-security-uuid', name: 'Security', team: { id: 'team-uuid' } }]),
      labelResponse([]),
      ISSUE_CREATE_RESPONSE,
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      labels: ['Security', 'typo'],
    })

    const warnings = warnSpy.mock.calls.map((c) => c[0] as string)
    const summary = warnings.find((m) => m.includes('created SMI-9999'))
    expect(summary).toBeDefined()
    expect(summary).toContain('typo')
  })

  it('emits no summary warning when every label resolves', async () => {
    mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([{ id: 'label-security-uuid', name: 'Security', team: { id: 'team-uuid' } }]),
      ISSUE_CREATE_RESPONSE,
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    await mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: ['Security'] })

    expect(warnSpy).not.toHaveBeenCalled()
  })

  // --- Q2: disambiguation ----------------------------------------------

  it('prefers a team-SMI label match over a workspace-level match with the same name', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([
        { id: 'team-bug-uuid', name: 'Bug', team: { id: 'team-uuid' } },
        { id: 'workspace-bug-uuid', name: 'Bug', team: null },
      ]),
      ISSUE_CREATE_RESPONSE,
    ])

    const mod = await importLinearApi()
    await mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: ['Bug'] })

    const body = requestBody(fetchMock, 2)
    expect((body.variables.input as { labelIds?: string[] }).labelIds).toEqual(['team-bug-uuid'])
  })

  it('resolves a workspace-level-only label match when no team match exists', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([{ id: 'workspace-bug-uuid', name: 'Bug', team: null }]),
      ISSUE_CREATE_RESPONSE,
    ])

    const mod = await importLinearApi()
    await mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: ['Bug'] })

    const body = requestBody(fetchMock, 2)
    expect((body.variables.input as { labelIds?: string[] }).labelIds).toEqual([
      'workspace-bug-uuid',
    ])
  })

  it('treats an other-team-only match as not found', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([{ id: 'other-team-ci-uuid', name: 'ci', team: { id: 'other-team-uuid' } }]),
      ISSUE_CREATE_RESPONSE,
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      labels: ['ci'],
    })

    expect(issue.identifier).toBe('SMI-9999')
    const body = requestBody(fetchMock, 2)
    expect(body.variables.input).not.toHaveProperty('labelIds')
    expect(warnSpy.mock.calls.some((c) => (c[0] as string).includes('"ci" not found'))).toBe(true)
  })

  it('refuses to guess when multiple team-SMI labels share a name', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([
        { id: 'dup-1', name: 'ci', team: { id: 'team-uuid' } },
        { id: 'dup-2', name: 'ci', team: { id: 'team-uuid' } },
      ]),
      ISSUE_CREATE_RESPONSE,
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      labels: ['ci'],
    })

    expect(issue.identifier).toBe('SMI-9999')
    const body = requestBody(fetchMock, 2)
    expect(body.variables.input).not.toHaveProperty('labelIds')
    expect(warnSpy.mock.calls.some((c) => (c[0] as string).includes('none unambiguously'))).toBe(
      true
    )
  })

  it('treats a full 50-node page as ambiguous rather than silently accepting it', async () => {
    const nodes: LabelNode[] = Array.from({ length: 50 }, (_, i) => ({
      id: `label-${i}`,
      name: 'ci',
      team: { id: 'team-uuid' },
    }))
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse(nodes),
      ISSUE_CREATE_RESPONSE,
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      labels: ['ci'],
    })

    expect(issue.identifier).toBe('SMI-9999')
    const body = requestBody(fetchMock, 2)
    expect(body.variables.input).not.toHaveProperty('labelIds')
    expect(warnSpy.mock.calls.some((c) => (c[0] as string).includes('matched 50+ labels'))).toBe(
      true
    )
  })

  // --- R3: CLI label normalisation --------------------------------------

  it('trims whitespace from label entries before querying', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([{ id: 'label-security-uuid', name: 'Security', team: { id: 'team-uuid' } }]),
      labelResponse([{ id: 'label-ci-uuid', name: 'ci', team: { id: 'team-uuid' } }]),
      ISSUE_CREATE_RESPONSE,
    ])

    const mod = await importLinearApi()
    await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      labels: 'Security, ci'.split(','),
    })

    expect(requestBody(fetchMock, 1).variables.name).toBe('Security')
    expect(requestBody(fetchMock, 2).variables.name).toBe('ci')
  })

  it('dedupes a repeated label entry to a single lookup and a single UUID', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      labelResponse([{ id: 'label-ci-uuid', name: 'ci', team: { id: 'team-uuid' } }]),
      ISSUE_CREATE_RESPONSE,
    ])

    const mod = await importLinearApi()
    await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      labels: 'ci,ci'.split(','),
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const body = requestBody(fetchMock, 2)
    expect((body.variables.input as { labelIds?: string[] }).labelIds).toEqual(['label-ci-uuid'])
  })

  it('drops blank label entries entirely (no lookups, no labelIds key)', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])

    const mod = await importLinearApi()
    await mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: ','.split(',') })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = requestBody(fetchMock, 1)
    expect(body.variables.input).not.toHaveProperty('labelIds')
  })

  // --- R4/R5: infrastructure failure vs absence, retry policy ----------

  it('propagates a 500 on the label-eq query after retries are exhausted, without warn-and-omit', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
      { kind: 'httpError', status: 500 },
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const promise = mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: ['ci'] })
    const assertion = expect(promise).rejects.toThrow('500')

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    await assertion

    // team (1 success) + label-eq (1 initial + 3 retries, all failing) = 5
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not retry a GraphQL errors response on the label-eq query', async () => {
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'ok', body: { errors: [{ message: 'boom' }] } },
    ])

    const mod = await importLinearApi()
    await expect(
      mod.createIssue({ title: 'T', description: VALID_DESCRIPTION, labels: ['ci'] })
    ).rejects.toThrow('GraphQL errors')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries once on a transient 503 on the label-eq query, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'httpError', status: 503 },
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

  it('does not retry the issueCreate mutation on a 500 (fails after exactly one attempt)', async () => {
    const fetchMock = mockFetchSteps([
      { kind: 'ok', body: TEAM_RESPONSE },
      { kind: 'httpError', status: 500 },
    ])

    const mod = await importLinearApi()
    await expect(mod.createIssue({ title: 'T', description: VALID_DESCRIPTION })).rejects.toThrow(
      '500'
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // --- Q5: --dry-run -----------------------------------------------------

  it('--dry-run resolves everything and prints the input without creating the issue', async () => {
    const fetchMock = mockFetchSequence([
      TEAM_RESPONSE,
      issueLookupResponse('parent-uuid'),
      labelResponse([{ id: 'label-security-uuid', name: 'Security', team: { id: 'team-uuid' } }]),
    ])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const result = (await mod.createIssue({
      title: 'T',
      description: VALID_DESCRIPTION,
      parentId: 'SMI-4963',
      labels: ['Security'],
      dryRun: true,
    })) as unknown as { dryRun: true; input: Record<string, unknown> }

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.dryRun).toBe(true)
    expect(result.input.teamId).toBe('team-uuid')
    expect(result.input.parentId).toBe('parent-uuid')
    expect(result.input.labelIds).toEqual(['label-security-uuid'])

    const printedCall = logSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('"input"')
    )
    expect(printedCall).toBeDefined()
    const printed = JSON.parse(printedCall?.[0] as string) as { input: Record<string, unknown> }
    expect(printed.input.teamId).toBe('team-uuid')
    expect(printed.input.parentId).toBe('parent-uuid')
    expect(printed.input.labelIds).toEqual(['label-security-uuid'])
  })
})
