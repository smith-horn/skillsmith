/**
 * SMI-5853 Gap 2: Tests for `scripts/linear-api.mjs`'s `create-issue`
 * Acceptance-Criteria validation gate.
 *
 * The gate lives inside the already-exported `createIssue()`, not
 * `commands['create-issue']` — `commands`/`parseArgs` are not exported
 * (`grep -n "^export" scripts/linear-api.mjs`), so they can't be imported
 * directly from a test (C2 fix, plan-review). On a blocked failure it
 * throws a regular `Error` rather than calling `process.exit(1)` directly;
 * `main()`'s existing top-level try/catch already converts any thrown
 * error into the same exit-1-with-message CLI behavior, so this file only
 * needs to prove `createIssue()` itself throws the right error at the
 * right time — no `process.exit` mock needed.
 *
 * `scripts/linear-api.mjs` declares pre-existing, un-reset module-level
 * state (`teamCache`/`stateCache`, populated by `getTeamId()`/`getStates()`)
 * that predates this change and isn't touched by it. Each test case below
 * resets the module registry (`vi.resetModules()` in `beforeEach`) and
 * re-imports the module fresh inside the `it()` itself, so that cache
 * doesn't leak between cases and silently change how many `fetch` calls a
 * given case's mocked sequence expects to see consumed.
 *
 * Shared fixtures/helpers (also used by the SMI-5854 UUID-resolution suite
 * in `scripts/tests/linear-api-uuid-resolution.test.ts`) live in
 * `scripts/tests/linear-api-test-helpers.ts` — split out to keep this file
 * under `scripts/check-file-length.mjs`'s 500-line pre-commit gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  importLinearApi,
  mockFetchSequence,
  requestBody,
  TEAM_RESPONSE,
  ISSUE_CREATE_RESPONSE,
  VALID_DESCRIPTION,
  labelsPageResponse,
} from './linear-api-test-helpers'

const DISABLE_VAR = 'SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_DISABLE'
const SHADOW_VAR = 'SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_SHADOW'

// No Acceptance Criteria heading at all -> always fails validation.
const INVALID_DESCRIPTION = 'Short description with no Acceptance Criteria section at all.'

beforeEach(() => {
  process.env.LINEAR_API_KEY = 'test-key'
  vi.resetModules()
  delete process.env[DISABLE_VAR]
  delete process.env[SHADOW_VAR]
})

afterEach(() => {
  // @ts-expect-error -- undo patch
  delete global.fetch
  delete process.env[DISABLE_VAR]
  delete process.env[SHADOW_VAR]
  vi.restoreAllMocks()
})

describe('createIssue validation gate (SMI-5853)', () => {
  it('lets a valid/compliant description through untouched', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({ title: 'Valid issue', description: VALID_DESCRIPTION })

    expect(issue.identifier).toBe('SMI-9999')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('shadow-on (default): a non-compliant description warns and still creates the issue', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({
      title: 'Non-compliant issue',
      description: INVALID_DESCRIPTION,
    })

    expect(issue.identifier).toBe('SMI-9999')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = warnSpy.mock.calls[0]?.[0] as string
    expect(message).toContain('[linear-api]')
    expect(message).toContain('shadow mode, proceeding')
  })

  it('shadow-lifted, no bypass: a non-compliant description blocks before any fetch call', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])
    process.env[SHADOW_VAR] = '0'

    const mod = await importLinearApi()

    let caught: Error | null = null
    try {
      await mod.createIssue({ title: 'Blocked issue', description: INVALID_DESCRIPTION })
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect(caught?.message).toContain('--force')
    expect(caught?.message).toContain(DISABLE_VAR)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('--force bypasses regardless of shadow state', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])
    process.env[SHADOW_VAR] = '0'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({
      title: 'Forced issue',
      description: INVALID_DESCRIPTION,
      force: true,
    })

    expect(issue.identifier).toBe('SMI-9999')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0] as string).toContain('(bypassed)')
  })

  it('the disable env var bypasses regardless of shadow state', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])
    process.env[SHADOW_VAR] = '0'
    process.env[DISABLE_VAR] = '1'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({
      title: 'Disable-var issue',
      description: INVALID_DESCRIPTION,
    })

    expect(issue.identifier).toBe('SMI-9999')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0] as string).toContain('(bypassed)')
  })

  it('force as a string value ("true") bypasses, matching a two-token --force true CLI parse (H6)', async () => {
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, ISSUE_CREATE_RESPONSE])
    process.env[SHADOW_VAR] = '0'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = await importLinearApi()
    const issue = await mod.createIssue({
      title: 'String-force issue',
      description: INVALID_DESCRIPTION,
      force: 'true',
    })

    expect(issue.identifier).toBe('SMI-9999')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0] as string).toContain('(bypassed)')
  })
})

describe('getLabels pagination (SMI-5859)', () => {
  it('merges multiple pages in order, paging first:250 with the right cursor each time', async () => {
    const page1 = labelsPageResponse(
      [
        { id: 'label-1', name: 'Bug', color: '#e11d21' },
        { id: 'label-2', name: 'Feature', color: '#2ecc40' },
      ],
      { hasNextPage: true, endCursor: 'cursor-1' }
    )
    const page2 = labelsPageResponse([{ id: 'label-3', name: 'Security', color: '#b71c1c' }], {
      hasNextPage: false,
      endCursor: null,
    })
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, page1, page2])

    const mod = await importLinearApi()
    const labels = await mod.getLabels()

    expect(labels).toEqual([
      { id: 'label-1', name: 'Bug', color: '#e11d21' },
      { id: 'label-2', name: 'Feature', color: '#2ecc40' },
      { id: 'label-3', name: 'Security', color: '#b71c1c' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const secondRequest = requestBody(fetchMock, 1)
    const thirdRequest = requestBody(fetchMock, 2)
    expect(secondRequest.variables.after).toBeNull()
    expect(thirdRequest.variables.after).toBe('cursor-1')
    expect(secondRequest.variables.first).toBe(250)
    expect(thirdRequest.variables.first).toBe(250)
  })

  it('terminates after a single page with no phantom second-page request', async () => {
    const page = labelsPageResponse(
      [
        { id: 'label-1', name: 'Bug', color: '#e11d21' },
        { id: 'label-2', name: 'Feature', color: '#2ecc40' },
      ],
      { hasNextPage: false, endCursor: null }
    )
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, page])

    const mod = await importLinearApi()
    const labels = await mod.getLabels()

    expect(labels).toEqual([
      { id: 'label-1', name: 'Bug', color: '#e11d21' },
      { id: 'label-2', name: 'Feature', color: '#2ecc40' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects with a specific pagination-invariant message when hasNextPage is true but endCursor is null', async () => {
    const page = labelsPageResponse(
      [
        { id: 'label-1', name: 'Bug', color: '#e11d21' },
        { id: 'label-2', name: 'Feature', color: '#2ecc40' },
      ],
      { hasNextPage: true, endCursor: null }
    )
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, page])

    const mod = await importLinearApi()

    await expect(mod.getLabels()).rejects.toThrow(/pagination did not advance/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects with a specific pagination-invariant message when endCursor repeats the cursor just sent', async () => {
    const page1 = labelsPageResponse(
      [
        { id: 'label-1', name: 'Bug', color: '#e11d21' },
        { id: 'label-2', name: 'Feature', color: '#2ecc40' },
      ],
      { hasNextPage: true, endCursor: 'cursor-1' }
    )
    const page2 = labelsPageResponse([{ id: 'label-3', name: 'Security', color: '#b71c1c' }], {
      hasNextPage: true,
      endCursor: 'cursor-1',
    })
    const fetchMock = mockFetchSequence([TEAM_RESPONSE, page1, page2])

    const mod = await importLinearApi()

    await expect(mod.getLabels()).rejects.toThrow(/pagination did not advance/)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const thirdRequest = requestBody(fetchMock, 2)
    expect(thirdRequest.variables.after).toBe('cursor-1')
  })
})
