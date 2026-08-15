/**
 * SMI-5879 Wave 3 item 3: smi5879-simulate-full — pure-function classification
 * tests (`processRow`'s tier-2 outcome matrix, `computeCoverage`,
 * `decideExitCode`, `assertPatTokenSource`). Split out of the original
 * `smi5879-simulate-full.test.ts` (grew past the 500-line-per-file gate) —
 * shared fixtures live in `./smi5879-simulate-full.fixtures.ts`, which also
 * documents the suite-wide mocked-dependencies judgment call.
 * @module scripts/tests/indexer/smi5879-simulate-full.classification
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  processRow,
  assertPatTokenSource,
  PrimaryFetchAuthError,
} from '../../indexer/smi5879-simulate-full.helpers.ts'
import {
  computeCoverage,
  summarizeCounts,
  decideExitCode,
} from '../../indexer/smi5879-simulate-full.sweep.ts'
import type {
  BranchMap,
  SimRowResult,
  SimSnapshotRow,
  SimulatedCohort,
} from '../../indexer/smi5879-simulate-full.types.ts'
import {
  CLEAN_RISK,
  DIRTY_RISK,
  makeRow,
  makeVerdictScanner,
  makeBundleAbsentScanner,
  makeSiblingTouchingScanner,
  baseDeps,
  contentsApiResponse,
  registerPrimary,
  registerSibling,
  resetRowCounter,
  installFetchMock,
  restoreFetchMock,
} from './smi5879-simulate-full.fixtures.ts'

beforeEach(() => {
  resetRowCounter()
  installFetchMock()
})

afterEach(() => {
  restoreFetchMock()
})

// ---------------------------------------------------------------------------
// Tier-2 outcome matrix — one test case per outcome (plus extra causes for
// unevaluable/unfetchable, since the plan calls out their asymmetric G-2
// effect as the "obvious way to get this wrong").
// ---------------------------------------------------------------------------

describe('processRow — tier-2 outcome classification', () => {
  const cleanScanner = makeVerdictScanner(new Map())

  it('unfetchable: repo_url does not parse (structurally undecidable, no network attempt)', async () => {
    const row = makeRow({ repo_url: null })
    const result = await processRow(row, new Map(), baseDeps(cleanScanner, cleanScanner))
    expect(result.outcome).toBe('unfetchable')
  })

  it('unfetchable: default_branch resolution is not-found', async () => {
    const row = makeRow({ repo_url: 'https://github.com/acme/bare-repo' })
    const branchMap: BranchMap = new Map([
      ['acme/bare-repo', { resolution: 'not-found', default_branch: null }],
    ])
    const result = await processRow(row, branchMap, baseDeps(cleanScanner, cleanScanner))
    expect(result.outcome).toBe('unfetchable')
  })

  it('unfetchable: default_branch resolution is unparseable', async () => {
    const row = makeRow({ repo_url: 'https://github.com/acme/bare-repo2' })
    const branchMap: BranchMap = new Map([
      ['acme/bare-repo2', { resolution: 'unparseable', default_branch: null }],
    ])
    const result = await processRow(row, branchMap, baseDeps(cleanScanner, cleanScanner))
    expect(result.outcome).toBe('unfetchable')
  })

  it('unevaluable: default_branch resolution is transient', async () => {
    const row = makeRow({ repo_url: 'https://github.com/acme/bare-repo3' })
    const branchMap: BranchMap = new Map([
      ['acme/bare-repo3', { resolution: 'transient', default_branch: null }],
    ])
    const result = await processRow(row, branchMap, baseDeps(cleanScanner, cleanScanner))
    expect(result.outcome).toBe('unevaluable')
  })

  it('unevaluable: primary fetch exhausts retries', async () => {
    const row = makeRow()
    registerPrimary(row, [
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
    ])
    const result = await processRow(row, new Map(), baseDeps(cleanScanner, cleanScanner))
    expect(result.outcome).toBe('unevaluable')
    expect(result.reason).toMatch(/primary fetch exhausted/)
  })

  it('unevaluable: primary SKILL.md confirmed absent (404) since the snapshot (judgment call)', async () => {
    const row = makeRow()
    registerPrimary(row, [new Response('Not Found', { status: 404 })])
    const result = await processRow(row, new Map(), baseDeps(cleanScanner, cleanScanner))
    expect(result.outcome).toBe('unevaluable')
    expect(result.reason).toMatch(/confirmed absent/)
  })

  it('unevaluable: a sibling exhausts retries', async () => {
    const row = makeRow()
    registerPrimary(row, [contentsApiResponse('# SKILL')])
    registerSibling(row, 'README.md', [
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
    ])
    const scanner = makeSiblingTouchingScanner()
    const result = await processRow(row, new Map(), baseDeps(scanner, scanner))
    expect(result.outcome).toBe('unevaluable')
    expect(result.reason).toMatch(/sibling\(s\) exhausted/)
  })

  it('content_drifted: fetched content hash does not match the snapshot content_hash', async () => {
    const row = makeRow({ content_hash: 'deadbeef'.repeat(8) })
    registerPrimary(row, [contentsApiResponse('# SKILL (changed since snapshot)')])
    const result = await processRow(row, new Map(), baseDeps(cleanScanner, cleanScanner))
    expect(result.outcome).toBe('content_drifted')
  })

  it('bundle_absent: primary OK, all 7 sibling targets confirmed absent — primary-only verdict is still carried', async () => {
    const row = makeRow()
    registerPrimary(row, [contentsApiResponse('# SKILL')])
    const scanner = makeBundleAbsentScanner(CLEAN_RISK)
    const result = await processRow(row, new Map(), baseDeps(scanner, scanner))
    expect(result.outcome).toBe('bundle_absent')
    expect(result.prePortQuarantine).toBe(false)
    expect(result.postPortQuarantine).toBe(false)
  })

  it('newly_quarantined: pre-port clean, post-port quarantined', async () => {
    const row = makeRow()
    registerPrimary(row, [contentsApiResponse('# SKILL')])
    const postPort = makeVerdictScanner(new Map([['acme/row-1', DIRTY_RISK]]))
    const prePort = makeVerdictScanner(new Map())
    const result = await processRow(row, new Map(), baseDeps(postPort, prePort))
    expect(result.outcome).toBe('newly_quarantined')
  })

  it('newly_cleared: pre-port quarantined, post-port clean', async () => {
    const row = makeRow()
    registerPrimary(row, [contentsApiResponse('# SKILL')])
    const postPort = makeVerdictScanner(new Map())
    const prePort = makeVerdictScanner(new Map([[`acme/${row.id}`, DIRTY_RISK]]))
    const result = await processRow(row, new Map(), baseDeps(postPort, prePort))
    expect(result.outcome).toBe('newly_cleared')
  })

  it('unchanged_clean: both scans clean', async () => {
    const row = makeRow()
    registerPrimary(row, [contentsApiResponse('# SKILL')])
    const result = await processRow(row, new Map(), baseDeps(cleanScanner, cleanScanner))
    expect(result.outcome).toBe('unchanged_clean')
  })

  it('unchanged_quarantined: both scans quarantined', async () => {
    const row = makeRow()
    registerPrimary(row, [contentsApiResponse('# SKILL')])
    const dirty = makeVerdictScanner(new Map([[`acme/${row.id}`, DIRTY_RISK]]))
    const result = await processRow(row, new Map(), baseDeps(dirty, dirty))
    expect(result.outcome).toBe('unchanged_quarantined')
  })

  it('two-sided reporting: newly_quarantined and newly_cleared are both first-class, neither dropped by summarizeCounts', () => {
    const results: SimRowResult[] = [
      { id: '1', cohort: 'C2', author: null, name: null, outcome: 'newly_quarantined' },
      { id: '2', cohort: 'C2', author: null, name: null, outcome: 'newly_cleared' },
    ]
    const counts = summarizeCounts(results)
    expect(counts.newly_quarantined).toBe(1)
    expect(counts.newly_cleared).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SMI-6015: frozen-header fix + 401-fatal on the primary fetch path
// ---------------------------------------------------------------------------

describe('processRow — SMI-6015 auth/token-refresh behavior', () => {
  const cleanScanner = makeVerdictScanner(new Map())

  it('primary fetch 401 throws PrimaryFetchAuthError immediately — never classified unevaluable', async () => {
    const row = makeRow()
    registerPrimary(row, [new Response('Unauthorized', { status: 401 })])
    await expect(processRow(row, new Map(), baseDeps(cleanScanner, cleanScanner))).rejects.toThrow(
      PrimaryFetchAuthError
    )
  })

  it('a 401 consumes no retry budget — exactly one fetch attempt, not maxRetries+1', async () => {
    const row = makeRow()
    // A single-element response queue always returns the same Response on every
    // fetch to this URL (fetchHandlers never shifts a length-1 queue) — if the
    // 401 were retried instead of thrown, this test would still "pass" the
    // response shape but the assertion below on fetch call count would catch it.
    registerPrimary(row, [new Response('Unauthorized', { status: 401 })])
    let fetchCount = 0
    const getHeaders = async () => {
      fetchCount++
      return {}
    }
    const deps = { ...baseDeps(cleanScanner, cleanScanner), getHeaders }
    await expect(processRow(row, new Map(), deps)).rejects.toThrow(PrimaryFetchAuthError)
    expect(fetchCount).toBe(1)
  })

  it('getHeaders is invoked fresh on every retry attempt, not once for the whole call', async () => {
    const row = makeRow()
    registerPrimary(row, [
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      contentsApiResponse('# SKILL'),
    ])
    let calls = 0
    const getHeaders = async () => {
      calls++
      return { Authorization: `token-${calls}` }
    }
    const deps = { ...baseDeps(cleanScanner, cleanScanner), getHeaders }
    const result = await processRow(row, new Map(), deps)
    expect(result.outcome).not.toBe('unevaluable')
    // FAST_RETRY (fixtures.ts) sets maxRetries=2 -> 3 total attempts (i=0,1,2),
    // matching the 3 queued responses above (2 retryable + 1 success).
    expect(calls).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Coverage: the unfetchable/unevaluable asymmetry
// ---------------------------------------------------------------------------

describe('computeCoverage — unfetchable does NOT block full coverage, unevaluable DOES', () => {
  it('a cohort where every row is unfetchable or a resolved verdict reports full', () => {
    // Typed as a fixed-length tuple (not `SimSnapshotRow[]`) so `rows[0]`/`rows[1]`
    // are known-defined under `noUncheckedIndexedAccess` — this array is always
    // constructed with exactly 2 elements, never mutated.
    const rows: [SimSnapshotRow, SimSnapshotRow] = [
      makeRow({ cohort: 'C2' }),
      makeRow({ cohort: 'C2' }),
    ]
    const results = new Map<string, SimRowResult>([
      [
        rows[0].id,
        { id: rows[0].id, cohort: 'C2', author: null, name: null, outcome: 'unfetchable' },
      ],
      [
        rows[1].id,
        { id: rows[1].id, cohort: 'C2', author: null, name: null, outcome: 'unchanged_clean' },
      ],
    ])
    const coverage = computeCoverage({ C1: [], C2: rows, C3: [], C4: [] }, results)
    expect(coverage.C2.status).toBe('full')
    expect(coverage.C2.unfetchable).toBe(1)
    expect(coverage.C2.unevaluable).toBe(0)
  })

  it('a cohort with even one unevaluable row reports partial — a partial cohort can never be reported as full', () => {
    const rows: [SimSnapshotRow, SimSnapshotRow] = [
      makeRow({ cohort: 'C2' }),
      makeRow({ cohort: 'C2' }),
    ]
    const results = new Map<string, SimRowResult>([
      [
        rows[0].id,
        { id: rows[0].id, cohort: 'C2', author: null, name: null, outcome: 'unevaluable' },
      ],
      [
        rows[1].id,
        { id: rows[1].id, cohort: 'C2', author: null, name: null, outcome: 'unchanged_clean' },
      ],
    ])
    const coverage = computeCoverage({ C1: [], C2: rows, C3: [], C4: [] }, results)
    expect(coverage.C2.status).toBe('partial')
    expect(coverage.C2.unevaluable).toBe(1)
  })

  it('a cohort with rows not yet attempted (scanned < total) reports partial', () => {
    const rows: [SimSnapshotRow, SimSnapshotRow] = [
      makeRow({ cohort: 'C3' }),
      makeRow({ cohort: 'C3' }),
    ]
    const results = new Map<string, SimRowResult>([
      [
        rows[0].id,
        { id: rows[0].id, cohort: 'C3', author: null, name: null, outcome: 'unchanged_clean' },
      ],
    ])
    const coverage = computeCoverage({ C1: [], C2: [], C3: rows, C4: [] }, results)
    expect(coverage.C3.status).toBe('partial')
    expect(coverage.C3.scanned).toBe(1)
    expect(coverage.C3.total).toBe(2)
  })
})

describe('decideExitCode', () => {
  const fullCoverage = (cohorts: SimulatedCohort[]) => {
    const c = {} as Record<
      SimulatedCohort,
      {
        status: 'full' | 'partial'
        scanned: number
        total: number
        unevaluable: number
        unfetchable: number
      }
    >
    for (const cohort of ['C1', 'C2', 'C3', 'C4'] as SimulatedCohort[]) {
      c[cohort] = {
        status: cohorts.includes(cohort) ? 'partial' : 'full',
        scanned: 1,
        total: 1,
        unevaluable: 0,
        unfetchable: 0,
      }
    }
    return c
  }

  it('is 0 when every cohort is full and the sweep did not hard-stop', () => {
    expect(decideExitCode(fullCoverage([]), null)).toBe(0)
  })

  it('is 1 when any cohort is partial', () => {
    expect(decideExitCode(fullCoverage(['C3']), null)).toBe(1)
  })

  it('is 1 when the sweep hard-stopped, even if coverage looks full', () => {
    expect(decideExitCode(fullCoverage([]), 'max_passes')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// token_source hard-refusal (plan §3a)
// ---------------------------------------------------------------------------

describe('assertPatTokenSource', () => {
  it('resolves "pat" when no GITHUB_APP_* vars are set', () => {
    expect(assertPatTokenSource({})).toBe('pat')
  })

  it('throws naming the three GITHUB_APP_* vars when all three are set', () => {
    const env = {
      GITHUB_APP_ID: 'x',
      GITHUB_APP_INSTALLATION_ID: 'y',
      GITHUB_APP_PRIVATE_KEY: 'z',
    }
    expect(() => assertPatTokenSource(env)).toThrow(/GITHUB_APP_ID/)
  })

  it('does not throw when only some GITHUB_APP_* vars are set (resolveTokenSource requires all three)', () => {
    expect(assertPatTokenSource({ GITHUB_APP_ID: 'x' })).toBe('pat')
  })
})
