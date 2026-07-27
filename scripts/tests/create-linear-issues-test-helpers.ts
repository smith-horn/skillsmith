/**
 * Shared fixtures + query-routed fetch mock for
 * scripts/tests/create-linear-issues.test.ts (SMI-5855).
 *
 * Split out to keep create-linear-issues.test.ts under the repo's 500-line
 * file-length gate, mirroring the scripts/tests/linear-api-test-helpers.ts
 * split SMI-5854 used for the same reason.
 *
 * `mockRoutedFetch` matches on the outgoing GraphQL query text + variables
 * rather than call order, because `fileIssuesForFailures()`'s one-time setup
 * resolves team/labels concurrently via `Promise.all` — a positional,
 * shift()-based mock sequence would be fragile against that interleaving.
 */
import { vi } from 'vitest'

import type { TestFailure } from '../e2e/create-linear-issues'

// --- Fixtures ---

export const PLAIN_FAILURE: TestFailure = {
  testName: 'cli search returns results',
  testFile: 'packages/cli/tests/search.test.ts',
  command: 'skillsmith search foo',
  error: 'Expected 1 result, got 0',
  timestamp: '2026-07-26T00:00:00.000Z',
}

export const HARDCODED_FAILURE: TestFailure = {
  ...PLAIN_FAILURE,
  testName: 'cli install writes config',
  hardcodedIssues: [
    {
      type: 'absolute-path',
      pattern: '/Users/.*',
      value: '/Users/example/project',
      command: 'skillsmith install foo',
      source: 'config.json',
      severity: 'high',
    },
  ],
}

// --- Query-routed fetch mock ---

interface GqlBody {
  data?: Record<string, unknown>
  errors?: Array<{ message: string }>
}

type RouteResult =
  | { kind: 'ok'; body: GqlBody }
  | { kind: 'http-error'; status: number; text?: string }
  | { kind: 'throw'; error: Error }

interface Route {
  match: (query: string, variables: Record<string, unknown>) => boolean
  results: RouteResult[]
}

export function ok(body: GqlBody): RouteResult {
  return { kind: 'ok', body }
}
export function httpError(status: number, text = 'error'): RouteResult {
  return { kind: 'http-error', status, text }
}
export function transportError(message = 'network down'): RouteResult {
  return { kind: 'throw', error: new Error(message) }
}
export function route(match: Route['match'], ...results: RouteResult[]): Route {
  return { match, results: [...results] }
}

export function mockRoutedFetch(routes: Route[]) {
  const fetchMock = vi.fn(async (_url: unknown, options: { body?: string }) => {
    const { query, variables } = JSON.parse(options.body ?? '{}') as {
      query: string
      variables: Record<string, unknown>
    }
    for (const r of routes) {
      if (r.results.length === 0 || !r.match(query, variables)) continue
      const next = r.results.shift()!
      if (next.kind === 'throw') throw next.error
      if (next.kind === 'http-error') {
        return {
          ok: false,
          status: next.status,
          json: async () => ({}),
          text: async () => next.text ?? '',
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => next.body,
        text: async () => JSON.stringify(next.body),
      } as unknown as Response
    }
    throw new Error(`mockRoutedFetch: no route matched query: ${query.slice(0, 120)}`)
  })
  // @ts-expect-error -- patch global fetch
  global.fetch = fetchMock
  return fetchMock
}

export function callQueries(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls.map(
    (call) => (JSON.parse((call[1] as { body: string }).body) as { query: string }).query
  )
}
export function findCallBody(
  fetchMock: { mock: { calls: unknown[][] } },
  match: (q: string, v: Record<string, unknown>) => boolean
) {
  const call = fetchMock.mock.calls.find((c) => {
    const parsed = JSON.parse((c[1] as { body: string }).body) as {
      query: string
      variables: Record<string, unknown>
    }
    return match(parsed.query, parsed.variables)
  })
  if (!call) throw new Error('mockRoutedFetch: expected a matching call, found none')
  return JSON.parse((call[1] as { body: string }).body) as {
    variables: { input: Record<string, unknown> }
  }
}

export const isTeamQuery = (q: string) => q.includes('teams(filter')
export const isBugLabelQuery = (q: string, v: Record<string, unknown>) =>
  q.includes('issueLabels(filter') && v.name === 'Bug'
export const isAutoLabelQuery = (q: string, v: Record<string, unknown>) =>
  q.includes('issueLabels(filter') && v.name === 'e2e-failure-auto'
// Matches ANY issueLabelCreate call, regardless of what name it was sent
// with — used for "no create call happened at all" assertions, where
// checking the query shape alone is the correct (and only sensible) check.
export const isAnyLabelCreateMutation = (q: string) => q.includes('issueLabelCreate')
// Checks the mutation input's `name`, not just the query shape — a route
// matching on query text alone would still match if the create mutation
// were ever accidentally called with the wrong label name (e.g. "Bug",
// which must never be created — see linear-client.ts), silently hiding
// that regression behind a passing test. Used to route/identify the
// specific e2e-failure-auto create call, not to assert its absence.
export const isAutoLabelCreate = (q: string, v: Record<string, unknown>) =>
  isAnyLabelCreateMutation(q) &&
  (v.input as { name?: string } | undefined)?.name === 'e2e-failure-auto'
export const isOpenIssuesQuery = (q: string, v: Record<string, unknown>) =>
  q.includes('$labelName') && v.labelName === 'e2e-failure-auto'
export const isIssueCreateMutation = (q: string) => q.includes('mutation CreateIssue')

export const TEAM_OK = ok({ data: { teams: { nodes: [{ id: 'team-uuid' }] } } })
function labelNodes(
  nodes: Array<{ id: string; name: string; team: { id: string } | null }>
): RouteResult {
  return ok({ data: { issueLabels: { nodes } } })
}
export const BUG_FOUND = labelNodes([{ id: 'bug-uuid', name: 'Bug', team: null }])
export const BUG_NOT_FOUND = labelNodes([])
export const AUTO_FOUND = labelNodes([
  { id: 'auto-uuid', name: 'e2e-failure-auto', team: { id: 'team-uuid' } },
])
export const AUTO_NOT_FOUND = labelNodes([])
export const AUTO_CREATE_OK = ok({
  data: { issueLabelCreate: { success: true, issueLabel: { id: 'new-auto-uuid' } } },
})
export const AUTO_CREATE_FAIL = ok({
  data: { issueLabelCreate: { success: false, issueLabel: null } },
})
export function openIssues(titles: string[], hasNextPage = false): RouteResult {
  return ok({
    data: {
      issues: {
        nodes: titles.map((title) => ({ title })),
        pageInfo: { hasNextPage, endCursor: hasNextPage ? 'cursor-1' : null },
      },
    },
  })
}
export function issueCreateOk(identifier: string): RouteResult {
  return ok({
    data: {
      issueCreate: {
        success: true,
        issue: {
          id: `${identifier}-id`,
          identifier,
          url: `https://linear.app/smi/issue/${identifier}`,
        },
      },
    },
  })
}
export const ISSUE_CREATE_FAIL_SUCCESS_FALSE = ok({
  data: { issueCreate: { success: false, issue: null } },
})
export const ISSUE_CREATE_GQL_ERRORS = ok({ errors: [{ message: 'validation failed' }] })

/** Happy-path routes for the one-time team/label/open-issues setup; override per test. */
export function baseRoutes(
  overrides: Partial<{
    team: RouteResult[]
    bug: RouteResult[]
    auto: RouteResult[]
    autoCreate: RouteResult[]
    open: RouteResult[]
    issueCreate: RouteResult[]
  }> = {}
): Route[] {
  return [
    route(isTeamQuery, ...(overrides.team ?? [TEAM_OK])),
    route(isBugLabelQuery, ...(overrides.bug ?? [BUG_FOUND])),
    route(isAutoLabelQuery, ...(overrides.auto ?? [AUTO_FOUND])),
    route(isAutoLabelCreate, ...(overrides.autoCreate ?? [])),
    route(isOpenIssuesQuery, ...(overrides.open ?? [openIssues([])])),
    route(isIssueCreateMutation, ...(overrides.issueCreate ?? [])),
  ]
}
