/**
 * SMI-6481 (governance review finding B1, 2026-09-09): proves
 * `runPreflightEstimate` can actually complete a row against the REAL
 * `processRow` — no `processRow` mock anywhere in this file.
 *
 * Why this is a separate file from `smi5879-guard-call-sites.test.ts`: that
 * suite mocks `processRow` to simulate a classifier regression, which is the
 * only way to exercise the coherence guards. But that same mock made it blind
 * to the bug this file exists for. `runPreflightEstimate` built its
 * `processRow` dependencies as `{ ..., headers }` while `ProcessRowDeps` had
 * required `{ ..., getHeaders }` since SMI-6015 — so every real invocation died
 * with `TypeError: getHeaders is not a function` on the FIRST row. Confirmed by
 * mutation: reverting the one-line fix leaves all 8 of the mocked suite's tests
 * green, and fails this file.
 *
 * Nothing else catches this class: `tsconfig.json` has `"files": []` and
 * references only `packages/`, so `tsc --build` never typechecks `scripts/`,
 * and `eslint.config.js`'s type-aware block is scoped to `packages/**` too.
 * A test that drives the real dependency wiring is the only backstop.
 *
 * @module scripts/tests/indexer/smi5879-preflight-wiring
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runPreflightEstimate } from '../../indexer/smi5879-simulate-preflight-estimate.ts'
import type {
  BranchMap,
  SimSnapshotRow,
  Smi5879SimulateFullDbDeps,
} from '../../indexer/smi5879-simulate-full.types.ts'

// Only the App-token mint is stubbed — `buildGitHubHeaders` would otherwise
// POST to api.github.com whenever GITHUB_APP_* are in the real environment
// (e.g. under `varlock run -- npm test`). `processRow` itself stays REAL.
vi.mock('../../indexer/_shared/github-auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/_shared/github-auth.ts')>()
  return {
    ...actual,
    buildGitHubHeaders: async () => ({ Authorization: 'token test-token-not-real' }),
  }
})

function snapshotRow(id: string): SimSnapshotRow {
  return {
    id,
    cohort: 'C2',
    repo_url: `https://github.com/acme/${id}`,
    skill_path: 'SKILL.md',
    author: 'acme',
    name: id,
    content_hash: null,
    snapshot_security_score: null,
    snapshot_quarantined: null,
  }
}

const BRANCH_MAP: BranchMap = new Map([
  ['acme/p-1', { resolution: 'resolved', default_branch: 'main' }],
  ['acme/p-2', { resolution: 'resolved', default_branch: 'main' }],
])

const db = {
  getRunSummary: async () => ({ purpose: 'decision', status: 'sealed' }),
  loadCohortRows: async () => [snapshotRow('p-1'), snapshotRow('p-2')],
  loadBranchMap: async () => BRANCH_MAP,
} as Pick<
  Smi5879SimulateFullDbDeps,
  'getRunSummary' | 'loadCohortRows' | 'loadBranchMap'
> as Smi5879SimulateFullDbDeps

/**
 * Both scanners return a clean, unquarantined verdict — an `unchanged_clean`
 * row. Shaped for `effectiveVerdict`, which reads `mergedSecurityScan` when
 * present and otherwise falls back to `securityScan.riskScore`.
 */
const cleanScan = async () => ({
  securityScan: { riskScore: 0, findings: [] },
  mergedSecurityScan: { quarantine: false, riskScore: 0 },
  // `isBundleAbsent` reads both of these; an empty-scans + all-removed-failures
  // combination is what marks a bundle absent, so leave both empty for a
  // normal, present bundle.
  siblingScans: [],
  siblingFailures: [],
})

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Every SKILL.md fetch succeeds with trivial content, in the GitHub Contents
  // API's own shape (base64 + `encoding`), which `fetchSkillMd` requires. This
  // is what lets the REAL `processRow` run end-to-end without network access.
  const body = JSON.stringify({
    content: Buffer.from('# Skill\n\nHarmless content.\n', 'utf8').toString('base64'),
    encoding: 'base64',
  })
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SMI-6481 B1 — runPreflightEstimate real-dependency wiring', () => {
  it('completes every sampled row against the real processRow (regression: getHeaders wiring)', async () => {
    const report = await runPreflightEstimate(
      db,
      cleanScan as never,
      cleanScan as never,
      {
        runId: 'run-1',
        purpose: 'decision',
        apply: true,
        sampleSize: 2,
        seed: 42,
        baselineCommit: 'abc123',
      },
      { GITHUB_TOKEN: 'ghp_fake_token_for_test' } as NodeJS.ProcessEnv
    )

    expect(report.report_kind).toBe('preflight_estimate')
    expect(report.sample_size).toBe(2)
    // The specific pre-fix failure was a TypeError on row 1, so the load-bearing
    // assertion is simply that both rows produced an outcome at all.
    const total = Object.values(report.counts).reduce((a, b) => a + b, 0)
    expect(total).toBe(2)
    // And the real fetch path was genuinely exercised — not silently skipped.
    expect(fetchSpy).toHaveBeenCalled()
  })
})
