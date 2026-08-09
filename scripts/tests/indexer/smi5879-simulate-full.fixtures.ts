/**
 * SMI-5879 Wave 3 item 3: shared fixtures/helpers for the split
 * smi5879-simulate-full.test.ts / .classification.test.ts / .sweep.test.ts /
 * .checkpoint.test.ts suite (the original single test file grew past the
 * 500-line-per-file gate — see each sibling test file's header for its slice
 * of the suite).
 * @module scripts/tests/indexer/smi5879-simulate-full.fixtures
 *
 * JUDGMENT CALL (flagged per task instructions, carried over unchanged from
 * the original single-file suite before this split): this suite injects fake
 * `Smi5879SimulateFullDbDeps` and `ScanSkillBundleFn` implementations rather
 * than standing up a live Postgres instance (the pattern
 * `smi5879-census.test-helpers.ts` uses for item 1). Item 1's live-PG harness
 * exists specifically to verify trigger/PL-pgSQL/GC-timing logic that item 1
 * owns; this item introduces NO new SQL objects — it only calls item 1's
 * already-tested `smi5879_claim_run`/`smi5879_heartbeat`/`smi5879_release_run`/
 * `smi5879_population_digest`/`smi5879_branch_digest` via
 * `smi5879-simulate-full.db.ts`, a thin wrapper this suite does not need to
 * re-verify against Postgres. What THIS item actually adds — tier-1/2/3
 * outcome classification, checkpoint/resume, coverage aggregation, and the
 * sweep loop's termination conditions — is pure TypeScript control flow that
 * mocked dependencies exercise more precisely (and deterministically, and
 * without a live-Postgres/CI-availability dependency) than a live-DB harness
 * would. `global.fetch` IS mocked (not skipped) for the primary/sibling
 * GitHub fetch paths, matching `rate-limit-tracking.test.ts`'s established
 * convention, so the REAL `fetchSkillMd`/`fetchSiblingContent`/
 * `parseSkillMdUrl`/`withFetchRetry` machinery is exercised end-to-end; only
 * the network transport and the DB round trip are faked.
 *
 * Split note: `fetchHandlers`/`originalFetch`/`rowCounter` used to be plain
 * module-level `let`s shared implicitly across all `describe` blocks via one
 * file-scoped `beforeEach`/`afterEach`. Vitest instantiates a fresh copy of
 * this module per test file (default `isolate: true`), so that closure no
 * longer spans files once split — each consuming test file must call
 * `installFetchMock()`/`restoreFetchMock()`/`resetRowCounter()` from its OWN
 * `beforeEach`/`afterEach`, not just import the raw mutable state.
 */

import { vi } from 'vitest'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import type { ProcessRowDeps } from '../../indexer/smi5879-simulate-full.helpers.ts'
import type {
  ScanSkillBundleFn,
  SimSnapshotRow,
  Smi5879SimulateFullDbDeps,
} from '../../indexer/smi5879-simulate-full.types.ts'

// ---------------------------------------------------------------------------
// Fixtures / fakes
// ---------------------------------------------------------------------------

export const CLEAN_RISK = 0
export const DIRTY_RISK = 80 // >= QUARANTINE_THRESHOLD (40)

let rowCounter = 0

/** Reset the `makeRow` auto-id counter — call from each consuming file's own `beforeEach`. */
export function resetRowCounter(): void {
  rowCounter = 0
}

export function makeRow(overrides: Partial<SimSnapshotRow> = {}): SimSnapshotRow {
  rowCounter++
  const id = overrides.id ?? `row-${rowCounter}`
  return {
    id,
    cohort: 'C2',
    repo_url: `https://github.com/acme/${id}/tree/main`,
    skill_path: null,
    author: 'acme',
    name: id,
    content_hash: null,
    snapshot_security_score: null,
    snapshot_quarantined: null,
    ...overrides,
  }
}

export function emptyEdgeScan(riskScore: number) {
  return {
    passed: riskScore < 40,
    riskScore,
    findings: [] as never[],
    contentHash: 'x',
    scannedAt: new Date().toISOString(),
    scanDurationMs: 0,
  }
}

/** A scanner that never touches `deps.fetchSiblingContent` — pure verdict-delta control. */
export function makeVerdictScanner(verdictByRepoKey: Map<string, number>): ScanSkillBundleFn {
  return async (owner, repo) => {
    const riskScore = verdictByRepoKey.get(`${owner}/${repo}`) ?? CLEAN_RISK
    return {
      securityScan: emptyEdgeScan(riskScore),
      siblingScans: [],
      siblingFailures: [],
      // `mergedSecurityScan` is optional on `ScanSkillBundleResult` — under
      // `exactOptionalPropertyTypes`, "no merged scan" means OMITTING the key,
      // not assigning it `undefined` explicitly (that's a type error, since an
      // optional property's value type itself doesn't include `undefined`).
    }
  }
}

/** A scanner that reports the bundle as fully absent (7 confirmed-404 siblings), primary OK. */
export function makeBundleAbsentScanner(riskScore = CLEAN_RISK): ScanSkillBundleFn {
  return async () => ({
    securityScan: emptyEdgeScan(riskScore),
    siblingScans: [],
    siblingFailures: Array.from({ length: 7 }, (_, i) => ({
      relPath: `sibling-${i}.txt`,
      kind: 'removed' as const,
    })),
    // See makeVerdictScanner above — `mergedSecurityScan` omitted, not `undefined`.
  })
}

/** A scanner that actually calls `deps.fetchSiblingContent` once, for exhaustion tests. */
export function makeSiblingTouchingScanner(riskScore = CLEAN_RISK): ScanSkillBundleFn {
  return async (owner, repo, branch, _skillPath, _content, telemetry, deps) => {
    const siblingFailures: { relPath: string; kind: 'transient' | 'removed' }[] = []
    if (deps?.fetchSiblingContent) {
      const result = await deps.fetchSiblingContent(owner, repo, branch, 'README.md', telemetry)
      if (result === null) siblingFailures.push({ relPath: 'README.md', kind: 'transient' })
    }
    return {
      securityScan: emptyEdgeScan(riskScore),
      siblingScans: [],
      siblingFailures,
      // See makeVerdictScanner above — `mergedSecurityScan` omitted, not `undefined`.
    }
  }
}

export function makeFakeDb(
  overrides: Partial<Smi5879SimulateFullDbDeps> = {}
): Smi5879SimulateFullDbDeps {
  return {
    async getRunSummary() {
      return { purpose: 'decision', status: 'sealed' }
    },
    async claimRun() {
      return { claimed: true }
    },
    async heartbeat() {
      return new Date().toISOString()
    },
    async releaseRun() {},
    async verifyDigest() {
      return { populationMatches: true, branchMatches: true }
    },
    async loadCohortRows() {
      return []
    },
    async loadBranchMap() {
      return new Map()
    },
    ...overrides,
  }
}

export const FAST_RETRY = { maxRetries: 2, baseMs: 1, maxMs: 2 }

/**
 * Drain the microtask queue without advancing any (real or fake) timer —
 * used by the heartbeat tests (SMI-5879 review finding 4) to let
 * `runSimulateFull`'s own sequence of `await`s (getRunSummary -> claimRun ->
 * ... -> the heartbeat's `setTimeout` registration) run to completion before
 * a fake-timer advance, without guessing an exact tick count.
 */
export async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

export function contentsApiResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(content, 'utf8').toString('base64'),
      encoding: 'base64',
    }),
    { status, headers: { 'content-type': 'application/json' } }
  )
}

let fetchHandlers: Map<string, Response[]> = new Map()
let originalFetch: typeof global.fetch

/** Install the `global.fetch` mock — call from each consuming file's own `beforeEach`. */
export function installFetchMock(): void {
  fetchHandlers = new Map()
  originalFetch = global.fetch
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input)
    const queue = fetchHandlers.get(url)
    if (!queue || queue.length === 0) {
      throw new Error(`Unexpected fetch to unregistered URL: ${url}`)
    }
    return queue.length > 1 ? (queue.shift() as Response) : queue[0]
  })
  global.fetch = fetchMock as unknown as typeof global.fetch
}

/** Restore the real `global.fetch` — call from each consuming file's own `afterEach`. */
export function restoreFetchMock(): void {
  global.fetch = originalFetch
}

export function registerPrimary(row: SimSnapshotRow, responses: Response[]): void {
  const [owner, repo] = new URL(row.repo_url as string).pathname.slice(1).split('/')
  fetchHandlers.set(
    `https://api.github.com/repos/${owner}/${repo}/contents/SKILL.md?ref=main`,
    responses
  )
}

export function registerSibling(row: SimSnapshotRow, relPath: string, responses: Response[]): void {
  const [owner, repo] = new URL(row.repo_url as string).pathname.slice(1).split('/')
  fetchHandlers.set(`https://raw.githubusercontent.com/${owner}/${repo}/main/${relPath}`, responses)
}

export function baseDeps(
  scanPostPort: ScanSkillBundleFn,
  scanPrePort: ScanSkillBundleFn
): ProcessRowDeps {
  return {
    scanPostPort,
    scanPrePort,
    telemetry: newRateLimitTelemetry(),
    headers: {},
    fetchRetryOptions: FAST_RETRY,
  }
}
