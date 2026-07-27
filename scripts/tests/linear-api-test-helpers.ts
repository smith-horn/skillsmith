/**
 * Shared fixtures and helpers for `scripts/tests/linear-api.test.ts`
 * (SMI-5853) and `scripts/tests/linear-api-uuid-resolution.test.ts`
 * (SMI-5854), both of which exercise `scripts/linear-api.mjs`'s
 * `createIssue()`.
 *
 * Split out of a single 656-line `linear-api.test.ts` to satisfy
 * `scripts/check-file-length.mjs`'s 500-line pre-commit gate (hard fail,
 * no grandfathering for new files). This module is deliberately NOT a test
 * file itself — it must not match the `*.test.ts`/`*.spec.ts` naming
 * vitest scans for (see `scripts/tests/**\/*.test.ts` in the Test File
 * Locations table), or vitest would try to collect it as a suite with zero
 * tests and fail.
 *
 * Pattern mirrors `scripts/tests/linear-upsert-drift-issue.test.ts`'s
 * `mockFetchSequence()` helper.
 */
import { vi } from 'vitest'

export interface GqlResponse {
  data?: Record<string, unknown>
  errors?: Array<{ message: string }>
}

export interface CreatedIssue {
  id: string
  identifier: string
  title: string
  url: string
}

export interface LinearApiModule {
  createIssue: (options: Record<string, unknown>) => Promise<CreatedIssue>
  commands: Record<string, (args: Record<string, unknown>) => Promise<unknown>>
}

export interface LabelNode {
  id: string
  name: string
  team: { id: string } | null
}

export function labelResponse(nodes: LabelNode[]): GqlResponse {
  return { data: { issueLabels: { nodes } } }
}

export function issueLookupResponse(id: string | null): GqlResponse {
  return { data: { issue: id ? { id } : null } }
}

export type FetchStep =
  | { kind: 'ok'; body: GqlResponse }
  | { kind: 'httpError'; status: number; text?: string }
  | { kind: 'transportError'; error?: Error }

/**
 * Like mockFetchSequence(), but each step can also fail at the HTTP layer
 * (non-ok response) or reject outright at the transport layer (fetch()
 * itself throwing, no response object at all) — needed for the
 * retry/infrastructure-failure cases (SMI-5854), which mockFetchSequence's
 * always-ok shape can't express.
 */
export function mockFetchSteps(steps: FetchStep[]) {
  const fetchMock = vi.fn(async () => {
    const step = steps.shift()
    if (!step) throw new Error('fetch called more times than mocked steps')
    if (step.kind === 'transportError') {
      throw step.error ?? new Error('network down')
    }
    if (step.kind === 'httpError') {
      return {
        ok: false,
        status: step.status,
        json: async () => ({}),
        text: async () => step.text ?? `error ${step.status}`,
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => step.body,
      text: async () => JSON.stringify(step.body),
    } as unknown as Response
  })
  // @ts-expect-error -- patch global fetch
  global.fetch = fetchMock
  return fetchMock
}

export interface GqlRequestBody {
  query: string
  variables: Record<string, unknown>
}

/** Parse the JSON body of the Nth fetch() call for assertions. */
export function requestBody(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex: number
): GqlRequestBody {
  const call = fetchMock.mock.calls[callIndex] as unknown as [string, { body: string }]
  return JSON.parse(call[1].body) as GqlRequestBody
}

export function mockFetchSequence(responses: GqlResponse[]) {
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

export const TEAM_RESPONSE: GqlResponse = {
  data: { teams: { nodes: [{ id: 'team-uuid', key: 'SMI', name: 'Skillsmith' }] } },
}

export const ISSUE_CREATE_RESPONSE: GqlResponse = {
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
export const VALID_DESCRIPTION = `This is a well-formed Linear issue description with enough body text to clear the minimum length requirement enforced by validateIssueDescription for a compliant issue.

## Acceptance Criteria
- [ ] The first acceptance criterion is met
- [ ] The second acceptance criterion is met
`

export async function importLinearApi(): Promise<LinearApiModule> {
  return (await import('../linear-api.mjs')) as unknown as LinearApiModule
}
