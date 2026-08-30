/**
 * SMI-6015: end-to-end `runCensus()` coverage for a FETCHING (`rehearsal`/
 * `decision`) generation, against a REAL local Postgres with `global.fetch`
 * mocked for the GitHub `GET /repos/{owner}/{repo}` calls. Sibling of
 * `smi5879-census.test.ts` (same live-PG harness — see that file's header
 * for the standup command and the CI-coverage gap this suite shares), split
 * out because it's the first suite in this family to exercise the
 * fetching path end-to-end rather than mocking `resolveDefaultBranches`
 * away or using `purpose: 'window'`.
 *
 * Covers the three behaviors item 3/item 6 (SMI-6015) actually changed at
 * the `runCensus()` orchestration level:
 *   1. The happy path: `resolveDefaultBranches` -> `sweepTransientRepos`
 *      (no-op) -> `seal()` -> I-5/I-6 both pass.
 *   2. A 401 mid-pass aborts the WHOLE census — `runCensus()` rejects and
 *      the generation is left `status='open'` (diagnosable), never sealed
 *      with a report that would otherwise claim success.
 *   3. The bounded re-resolution sweep flips a row that exhausted the main
 *      pass's retries as `transient` back to `resolved` before seal, so I-6
 *      passes on the resulting (real, sealed) generation.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { queryRows, runPsql, type PgConnParams } from '../../indexer/smi5879-census.pg.ts'
import { runCensus } from '../../indexer/smi5879-census.ts'
import {
  requireTestConn,
  resetSchema,
  insertSkillFixture,
  sealAnyOpenGeneration,
  prePushNoLiveTestPg,
} from './smi5879-census.test-helpers.ts'

let conn: PgConnParams
let originalFetch: typeof global.fetch

beforeAll(async () => {
  if (prePushNoLiveTestPg) return
  // Own schema, same rationale as smi5879-census.test.ts — this file's
  // beforeAll runs concurrently with every sibling file's own beforeAll.
  conn = await resetSchema(requireTestConn(), 'smi5879_test_census_branches_integration')
}, 60_000)

beforeEach(async () => {
  if (prePushNoLiveTestPg) return
  // `runCensus()`'s real `populate()` step is `INSERT ... SELECT * FROM
  // skills` with NO per-test filter — unlike smi5879-census.test.ts's other
  // tests (which insert into smi5879_snapshot_pre directly, bypassing
  // `skills`), every test in THIS file exercises the real population path,
  // so `skills` must be cleared between tests or later tests silently
  // inherit earlier tests' fixture rows into their own generation.
  await runPsql(conn, 'DELETE FROM skills;')
})

afterEach(async () => {
  global.fetch = originalFetch
  if (prePushNoLiveTestPg) return
  await sealAnyOpenGeneration(conn)
})

function githubRepoUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${owner}/${repo}`
}

/** Install a URL-keyed `global.fetch` mock for GitHub repo-metadata GET calls. */
function installGithubFetchMock(): (owner: string, repo: string, responses: Response[]) => void {
  originalFetch = global.fetch
  const handlers = new Map<string, Response[]>()
  const mock = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input)
    const queue = handlers.get(url)
    if (!queue || queue.length === 0) {
      throw new Error(`SMI-6015 test: unexpected fetch to unregistered URL: ${url}`)
    }
    return queue.length > 1 ? (queue.shift() as Response) : queue[0]
  })
  global.fetch = mock as unknown as typeof global.fetch
  return (owner, repo, responses) => handlers.set(githubRepoUrl(owner, repo), responses)
}

function branchResponse(defaultBranch: string): Response {
  return new Response(JSON.stringify({ default_branch: defaultBranch }), { status: 200 })
}

describe.skipIf(prePushNoLiveTestPg)(
  'runCensus() — fetching generation, GitHub calls mocked (SMI-6015)',
  () => {
    it('happy path: resolves the distinct repo, seals, I-5/I-6 both pass, sweep is null (nothing to sweep)', async () => {
      const setHandler = installGithubFetchMock()
      setHandler('acme', 'repo-happy', [branchResponse('main')])
      await insertSkillFixture(conn, { repo_url: 'https://github.com/acme/repo-happy' })

      const report = await runCensus(conn, {
        purpose: 'decision',
        rulesetEpoch: '2026-01-01T00:00:00Z',
        apply: true,
        reportPath: 'unused-happy.json',
        resume: false,
      })

      expect(report.status).toBe('sealed')
      expect(report.branch_resolution).not.toBeNull()
      expect(report.branch_resolution?.resolved).toBe(1)
      expect(report.branch_resolution?.transient).toBe(0)
      expect(report.branch_resolution?.reresolution_sweep).toBeNull()
      expect(report.invariants.every((i) => i.passed)).toBe(true)
      expect(report.invariants.map((i) => i.id)).toContain('I-6')
    })

    it('a 401 mid-pass aborts the WHOLE census — rejects, and the generation is left status=open, never sealed', async () => {
      const setHandler = installGithubFetchMock()
      setHandler('acme', 'dead-token-repo', [new Response('', { status: 401 })])
      await insertSkillFixture(conn, { repo_url: 'https://github.com/acme/dead-token-repo' })

      await expect(
        runCensus(conn, {
          purpose: 'rehearsal',
          rulesetEpoch: '2026-01-01T00:00:00Z',
          apply: true,
          reportPath: 'unused-401.json',
          resume: false,
        })
      ).rejects.toThrow(/401/)

      // smi5879_run_one_open enforces AT MOST one 'open' row in this schema —
      // if the abort had (incorrectly) let seal() run anyway, this would be empty.
      const openRuns = await queryRows(
        conn,
        `SELECT run_id, status FROM smi5879_run WHERE status = 'open';`
      )
      expect(openRuns).toHaveLength(1)
      expect(openRuns[0]?.[1]).toBe('open')
    })

    it('the bounded re-resolution sweep flips a main-pass-transient row to resolved before seal — I-6 passes', async () => {
      const setHandler = installGithubFetchMock()
      // Main pass: 3 x 503 exhausts resolveOne's MAX_RETRIES -> 'transient'.
      // Sweep's own fresh resolveOne call then pulls the 4th queued response.
      setHandler('acme', 'eventually-fine-repo', [
        new Response('', { status: 503 }),
        new Response('', { status: 503 }),
        new Response('', { status: 503 }),
        branchResponse('main'),
      ])
      await insertSkillFixture(conn, { repo_url: 'https://github.com/acme/eventually-fine-repo' })

      const report = await runCensus(conn, {
        purpose: 'decision',
        rulesetEpoch: '2026-01-01T00:00:00Z',
        apply: true,
        reportPath: 'unused-sweep.json',
        resume: false,
      })

      expect(report.status).toBe('sealed')
      expect(report.branch_resolution?.resolved).toBe(1)
      expect(report.branch_resolution?.transient).toBe(0)
      expect(report.branch_resolution?.reresolution_sweep).not.toBeNull()
      expect(report.branch_resolution?.reresolution_sweep?.passes_run).toBe(1)
      expect(report.branch_resolution?.reresolution_sweep?.remaining_transient).toBe(0)
      expect(report.branch_resolution?.reresolution_sweep?.repos_reattempted).toBe(1)
      expect(report.invariants.find((i) => i.id === 'I-6')?.passed).toBe(true)
    }, 20_000)
  }
)
