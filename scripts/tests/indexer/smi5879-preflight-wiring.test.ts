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
  ScanSkillBundleFn,
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
 * row. Typed as the real `ScanSkillBundleFn` rather than cast through `as
 * never`: `scripts/` is untypechecked, so a cast here would hide a shape
 * mismatch exactly the way the B1 bug this file exists to catch was hidden.
 *
 * The annotation only helps if the object ACTUALLY satisfies it — an
 * unenforced annotation in an unchecked directory hides a mismatch just as
 * well as a cast does. A first attempt at this omitted four required
 * `MergedEdgeScanResult` fields and still "passed" `npm run typecheck`,
 * because that command never sees `scripts/`. Verify with
 * `npx tsc --noEmit --strict ... <file>` directly. Every required field of
 * `ScanSkillBundleResult` is now present, so this genuinely drives
 * `effectiveVerdict` (which prefers `mergedSecurityScan`, falling back to
 * `securityScan.riskScore`) and `isBundleAbsent` (which reads `siblingScans`
 * and `siblingFailures` — both empty here means a normal, present bundle).
 */
const cleanScan: ScanSkillBundleFn = async () => ({
  securityScan: {
    passed: true,
    riskScore: 0,
    findings: [],
    contentHash: 'test-content-hash',
    scannedAt: new Date(0).toISOString(),
    scanDurationMs: 0,
  },
  mergedSecurityScan: {
    quarantine: false,
    riskScore: 0,
    findings: [],
    siblingRejectable: false,
    primarySiblingPath: null,
    multilineTruncated: false,
    truncatedScanPaths: [],
  },
  siblingScans: [],
  siblingFailures: [],
  scanCoverage: { incomplete: false, note: null },
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
      cleanScan,
      cleanScan,
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
    // Pin the EXACT outcome, not a sum across all buckets: a bucket-sum of 2
    // would still hold if both rows silently degraded to `unevaluable` or
    // `primary_not_found` — e.g. if the hand-built Contents-API body below ever
    // stopped satisfying `fetchSkillMd`. Both scanners return a clean verdict
    // against a present bundle, so `unchanged_clean` is the only correct answer.
    expect(report.counts.unchanged_clean).toBe(2)
    // And the real fetch path was genuinely exercised — not silently skipped.
    expect(fetchSpy).toHaveBeenCalled()
  })
})
