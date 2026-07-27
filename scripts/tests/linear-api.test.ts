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
 * Pattern mirrors `scripts/tests/linear-upsert-drift-issue.test.ts`'s
 * `mockFetchSequence()` helper. The `vi.mock('node:child_process', ...)`
 * shape that file also uses is not needed here — `linear-api.mjs` never
 * shells out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const DISABLE_VAR = 'SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_DISABLE'
const SHADOW_VAR = 'SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_SHADOW'

interface GqlResponse {
  data?: Record<string, unknown>
  errors?: Array<{ message: string }>
}

interface CreatedIssue {
  id: string
  identifier: string
  title: string
  url: string
}

interface LinearApiModule {
  createIssue: (options: Record<string, unknown>) => Promise<CreatedIssue>
}

function mockFetchSequence(responses: GqlResponse[]) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('fetch called more times than mocked responses')
    return {
      ok: true,
      status: 200,
      json: async () => next,
      text: async () => JSON.stringify(next),
    } as unknown as Response
  })
  // @ts-expect-error -- patch global fetch
  global.fetch = fetchMock
  return fetchMock
}

const TEAM_RESPONSE: GqlResponse = {
  data: { teams: { nodes: [{ id: 'team-uuid', key: 'SMI', name: 'Skillsmith' }] } },
}

const ISSUE_CREATE_RESPONSE: GqlResponse = {
  data: {
    issueCreate: {
      success: true,
      issue: {
        id: 'new-uuid',
        identifier: 'SMI-9999',
        title: 'Test issue',
        url: 'https://linear.app/smi/issue/SMI-9999',
      },
    },
  },
}

// Compliant with validateIssueDescription's ported contract: non-empty,
// >=120 body chars excluding heading lines, an "Acceptance Criteria"
// heading, and >=2 non-placeholder bulleted items under it.
const VALID_DESCRIPTION = `This is a well-formed Linear issue description with enough body text to clear the minimum length requirement enforced by validateIssueDescription for a compliant issue.

## Acceptance Criteria
- [ ] The first acceptance criterion is met
- [ ] The second acceptance criterion is met
`

// No Acceptance Criteria heading at all -> always fails validation.
const INVALID_DESCRIPTION = 'Short description with no Acceptance Criteria section at all.'

async function importLinearApi(): Promise<LinearApiModule> {
  return (await import('../linear-api.mjs')) as unknown as LinearApiModule
}

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
