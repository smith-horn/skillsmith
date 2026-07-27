/**
 * Tests for Linear Drift Triage (SMI-4559), transport surface (SMI-5860).
 *
 * `fetchLinearProject` had zero test coverage before SMI-5860's migration
 * from a synchronous `curl` subprocess to the shared, `fetch()`-based
 * `graphql()` client. These tests cover that migrated call directly.
 *
 * IMPORTANT (review finding): `graphql()` reads `process.env.LINEAR_API_KEY`
 * directly — NOT the `apiKey` parameter `fetchLinearProject` still takes
 * (which is now a short-circuit-only check, `if (!apiKey) return null`).
 * Tests must set the env var, not just pass an `apiKey` argument, or they
 * would silently test the wrong thing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockFetchSteps } from './linear-api-test-helpers'

async function importModule() {
  return await import('../triage-linear-drift.mjs')
}

describe('fetchLinearProject transport (SMI-5860)', () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = 'test-key'
  })

  afterEach(() => {
    // @ts-expect-error -- undo patch
    delete global.fetch
    delete process.env.LINEAR_API_KEY
    vi.restoreAllMocks()
  })

  it('returns null with zero fetch calls when apiKey is falsy (short-circuit, unrelated to the env var)', async () => {
    const fetchMock = mockFetchSteps([])
    const { fetchLinearProject } = await importModule()
    const result = await fetchLinearProject('SMI-100', '')
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves project name and first initiative on a happy-path response', async () => {
    const fetchMock = mockFetchSteps([
      {
        kind: 'ok',
        body: {
          data: {
            issue: {
              project: {
                name: 'Skillsmith: CI Health',
                initiatives: { nodes: [{ name: 'Skillsmith' }] },
              },
            },
          },
        },
      },
    ])
    const { fetchLinearProject } = await importModule()
    const result = await fetchLinearProject('SMI-100', 'test-key')
    expect(result).toEqual({ project: 'Skillsmith: CI Health', initiative: 'Skillsmith' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the SMI identifier as a $id GraphQL variable, not string-interpolated into the query text', async () => {
    const fetchMock = mockFetchSteps([{ kind: 'ok', body: { data: { issue: { project: null } } } }])
    const { fetchLinearProject } = await importModule()
    await fetchLinearProject('SMI-100', 'test-key')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    const parsed = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }
    expect(parsed.variables).toEqual({ id: 'SMI-100' })
    expect(parsed.query).not.toContain('SMI-100')
  })

  it('returns null when the issue has no project (nothing to resolve)', async () => {
    const fetchMock = mockFetchSteps([{ kind: 'ok', body: { data: { issue: { project: null } } } }])
    const { fetchLinearProject } = await importModule()
    const result = await fetchLinearProject('SMI-999', 'test-key')
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null on a genuine GraphQL error response (graphql() throws, caught by the blanket catch) — matches pre-migration behavior, which never checked data.errors either', async () => {
    mockFetchSteps([{ kind: 'ok', body: { errors: [{ message: 'not found' }] } }])
    const { fetchLinearProject } = await importModule()
    const result = await fetchLinearProject('SMI-100', 'test-key')
    expect(result).toBeNull()
  })

  it('returns null on a transport failure', async () => {
    mockFetchSteps([{ kind: 'transportError', error: new Error('ECONNRESET') }])
    const { fetchLinearProject } = await importModule()
    const result = await fetchLinearProject('SMI-100', 'test-key')
    expect(result).toBeNull()
  })

  it('returns null on an HTTP error response', async () => {
    mockFetchSteps([{ kind: 'httpError', status: 500 }])
    const { fetchLinearProject } = await importModule()
    const result = await fetchLinearProject('SMI-100', 'test-key')
    expect(result).toBeNull()
  })
})

describe('classifyEntry async plumbing (SMI-5860)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.LINEAR_API_KEY = 'test-key'
    delete process.env.TRIAGE_NO_LINEAR
  })

  afterEach(() => {
    // @ts-expect-error -- undo patch
    delete global.fetch
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('awaits the async fetchLinearProject call and classifies via the Linear-initiative lookup, before ever reaching the gh fallback', async () => {
    mockFetchSteps([
      {
        kind: 'ok',
        body: {
          data: {
            issue: {
              project: {
                name: 'Module 4',
                initiatives: { nodes: [{ name: '021 School Platform' }] },
              },
            },
          },
        },
      },
    ])
    const { classifyEntry } = await importModule()
    const result = await classifyEntry(
      { id: 'SMI-9001', title: 'Some unrelated title' },
      '',
      'test-key'
    )
    expect(result.bucket).toBe('external-repo')
    expect(result.signal).toBe('linear-initiative')
  })
})
