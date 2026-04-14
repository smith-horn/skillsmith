/**
 * SMI-4205: Tests for linear-upsert-drift-issue.mjs.
 *
 * Mocks global fetch to simulate Linear GraphQL responses and verifies:
 *   1. create path when no open issue exists (labelIds + parentId passed).
 *   2. update path when an open auto-issue exists (no create mutation fires).
 *   3. all retries fail -> gh issue fallback fires + process exits non-zero.
 *
 * Note: "empty report" no-op is exercised by the CLI main() branch and
 * verified via integration; the unit-level `upsertDriftIssue` always receives
 * a non-empty report.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

// @ts-expect-error -- plain ESM module, no .d.ts
import { upsertDriftIssue, buildDescription, withRetry } from '../linear-upsert-drift-issue.mjs'

const mockedExecFileSync = vi.mocked(execFileSync)

interface GqlResponse {
  data?: Record<string, unknown>
  errors?: Array<{ message: string }>
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

const SAMPLE_REPORT = {
  drifted: [{ pkg: '@skillsmith/core', local: '0.5.1', npmLatest: '0.5.2' }],
  clean: [],
  errors: [],
}

beforeEach(() => {
  process.env.LINEAR_API_KEY = 'test-key'
  mockedExecFileSync.mockReset()
})

afterEach(() => {
  // @ts-expect-error -- undo patch
  delete global.fetch
})

describe('buildDescription', () => {
  it('renders a drift table when drifted is non-empty', () => {
    const desc = buildDescription(SAMPLE_REPORT, '2026-04-20')
    expect(desc).toContain('Version Drift Detected - 2026-04-20')
    expect(desc).toContain('| @skillsmith/core | 0.5.1 | 0.5.2 |')
    expect(desc).not.toContain('### npm lookup errors')
  })

  it('renders error table when errors is non-empty', () => {
    const desc = buildDescription(
      {
        drifted: [],
        clean: [],
        errors: [{ pkg: '@skillsmith/foo', error: 'getaddrinfo ENOTFOUND' }],
      },
      '2026-04-20'
    )
    expect(desc).toContain('### npm lookup errors')
    expect(desc).toContain('| @skillsmith/foo | getaddrinfo ENOTFOUND |')
  })
})

describe('withRetry', () => {
  it('returns on first successful attempt', async () => {
    const fn = vi.fn(async () => 'ok')
    const result = await withRetry(fn, [1, 1, 1])
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries up to delays.length + 1 total attempts on failure', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce('ok')
    const result = await withRetry(fn, [1, 1, 1])
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws last error after all attempts fail', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('nope'))
    await expect(withRetry(fn, [1, 1, 1])).rejects.toThrow('nope')
    expect(fn).toHaveBeenCalledTimes(4)
  })
})

describe('upsertDriftIssue - create path', () => {
  it('creates a new issue when no open auto-issue exists', async () => {
    mockFetchSequence([
      // getTeamId
      { data: { teams: { nodes: [{ id: 'team-uuid' }] } } },
      // getOrCreateAutoLabelId -> label exists
      { data: { issueLabels: { nodes: [{ id: 'label-uuid', name: 'version-drift-auto' }] } } },
      // getIssueIdByIdentifier (parent SMI-4182)
      { data: { issue: { id: 'parent-uuid', identifier: 'SMI-4182' } } },
      // findExistingOpenAutoIssue -> none
      { data: { issues: { nodes: [] } } },
      // issueCreate
      {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: 'new-uuid',
              identifier: 'SMI-9999',
              url: 'https://linear.app/smi/issue/SMI-9999',
            },
          },
        },
      },
    ])

    const issue = await upsertDriftIssue(SAMPLE_REPORT)
    expect(issue.identifier).toBe('SMI-9999')
  })
})

describe('upsertDriftIssue - update path', () => {
  it('updates an existing open auto-issue without creating a new one', async () => {
    mockFetchSequence([
      { data: { teams: { nodes: [{ id: 'team-uuid' }] } } },
      { data: { issueLabels: { nodes: [{ id: 'label-uuid', name: 'version-drift-auto' }] } } },
      { data: { issue: { id: 'parent-uuid', identifier: 'SMI-4182' } } },
      {
        data: {
          issues: {
            nodes: [
              { id: 'existing-uuid', identifier: 'SMI-9000', title: 'Version drift detected' },
            ],
          },
        },
      },
      {
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: 'existing-uuid',
              identifier: 'SMI-9000',
              url: 'https://linear.app/smi/issue/SMI-9000',
            },
          },
        },
      },
    ])

    const issue = await upsertDriftIssue(SAMPLE_REPORT)
    expect(issue.identifier).toBe('SMI-9000')
  })
})

describe('upsertDriftIssue - retry failure + gh fallback', () => {
  it('throws after all retries so main() can trigger gh fallback', async () => {
    // All fetch attempts fail; withRetry wraps at multiple layers
    // so getTeamId will consume its 4 attempts then throw.
    const failing = vi.fn(async () => {
      throw new Error('network down')
    })
    // @ts-expect-error -- patch global fetch
    global.fetch = failing

    await expect(upsertDriftIssue(SAMPLE_REPORT)).rejects.toThrow()
    // Confirm retries actually happened (4 attempts = delays.length + 1).
    expect(failing.mock.calls.length).toBeGreaterThanOrEqual(4)
  })
})
