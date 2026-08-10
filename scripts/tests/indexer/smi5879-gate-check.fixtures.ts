/**
 * Shared fixtures/helpers for the smi5879-gate-check.test.ts /
 * smi5879-gate-check.g2r.test.ts split suite (SMI-5879 Wave 3 item 4).
 * @module scripts/tests/indexer/smi5879-gate-check.fixtures
 *
 * JUDGMENT CALL (flagged per task instructions, same rationale item 3's
 * fixtures already carry): this suite injects fake `Smi5879GateCheckDbDeps`
 * / `Smi5879GateCheckTestDeps` rather than standing up a live Postgres
 * instance. gate-check.ts introduces NO new SQL objects (§12.4) — it only
 * calls item 1's already-tested functions via its own thin `.pg.ts` wrapper,
 * which this suite does not need to re-verify against Postgres. What THIS
 * item adds — gate evaluation ordering, short-circuiting, binding rejection,
 * ledger/attestation validation, the +32 corroboration — is pure TypeScript
 * control flow that mocked dependencies exercise more precisely than a
 * live-DB harness would.
 *
 * Report/ledger/attestation fixtures below are built as PLAIN JSON-shaped
 * objects (not typed against the internal `Smi5879*` interfaces) and written
 * to real temp files via {@link writeFixtureFile} — this exercises the
 * ACTUAL file-loading + shape-validation path (`smi5879-gate-check.io.ts`
 * and `.helpers.ts`'s `loadJsonFile`), not just the in-memory evaluator
 * functions.
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DriftRow,
  Smi5879GateCheckDbDeps,
  Smi5879GateCheckMode,
  Smi5879GateCheckTestDeps,
  Smi5879RunSummary,
  StructuralClosureResult,
} from '../../indexer/smi5879-gate-check.types.ts'
import type { CliArgs } from '../../indexer/smi5879-gate-check.ts'

// ---------------------------------------------------------------------------
// Temp-file plumbing
// ---------------------------------------------------------------------------

const realpath: (p: string) => string =
  typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync

export function makeScratchDir(): string {
  return mkdtempSync(join(realpath(tmpdir()), 'smi5879-gate-check-'))
}

export function writeFixtureFile(dir: string, name: string, value: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

// ---------------------------------------------------------------------------
// Identity constants
// ---------------------------------------------------------------------------

export const DECISION_RUN_ID = 'smi5879-decision-test-run'
export const WINDOW_RUN_ID = 'smi5879-window-test-run'
export const SAMPLE_COMMIT = 'a'.repeat(40)
export const RULESET_EPOCH = '2026-07-29T23:41:09.000000Z'
export const DECISION_STARTED_AT = '2026-07-29T20:15:00.000000Z'
export const WINDOW_STARTED_AT_WITHIN_BOUND = '2026-08-01T20:15:00.000000Z' // +3d, within 3d6h
export const WINDOW_STARTED_AT_OVER_BOUND = '2026-08-03T20:15:00.000000Z' // +5d, over 3d6h

// ---------------------------------------------------------------------------
// Census report fixtures (raw JSON shape — see module doc)
// ---------------------------------------------------------------------------

export function makeInvariant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'I-1', name: 'totality', passed: true, detail: 'ok', ...overrides }
}

export const ALL_PASSING_INVARIANTS = [
  makeInvariant({ id: 'I-1', name: 'totality' }),
  makeInvariant({ id: 'I-2', name: 'disjointness' }),
  makeInvariant({ id: 'I-3', name: 'completeness' }),
  makeInvariant({ id: 'I-4', name: 'single-instant' }),
  makeInvariant({ id: 'I-5', name: 'branch coverage' }),
]

export function makeCensusReportJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    run_id: DECISION_RUN_ID,
    purpose: 'decision',
    status: 'sealed',
    ruleset_epoch: RULESET_EPOCH,
    row_count: 100,
    population_digest: 'smi5879-v1:sha256:decisiondigest',
    branch_digest: 'smi5879-v1:sha256:decisionbranchdigest',
    cohorts: { C1: 0, C2: 0, C3: 0, C4: 0, E: 100 },
    excluded_cohort_e_count: 100,
    ruleset_epoch_provenance: 'proxy, see design doc §8.3.1.5',
    invariants: ALL_PASSING_INVARIANTS,
    branch_resolution: null,
    generated_at: new Date().toISOString(),
    ...overrides,
  }
}

export function makeWindowCensusReportJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return makeCensusReportJson({
    run_id: WINDOW_RUN_ID,
    purpose: 'window',
    population_digest: 'smi5879-v1:sha256:windowdigest',
    branch_digest: 'smi5879-v1:sha256:windowbranchdigest',
    // A `window` generation never fetches — no I-5 branch-coverage check (design doc §8.3.5.2.6).
    invariants: ALL_PASSING_INVARIANTS.slice(0, 4),
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Simulator report fixtures
// ---------------------------------------------------------------------------

const ALL_OUTCOMES = [
  'newly_quarantined',
  'newly_cleared',
  'unchanged_clean',
  'unchanged_quarantined',
  'content_drifted',
  'bundle_absent',
  'unevaluable',
  'unfetchable',
] as const

export function makeCoverage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0, ...overrides }
}

export function makeFullCoverageAllCohorts(): Record<string, unknown> {
  return {
    C1: makeCoverage(),
    C2: makeCoverage(),
    C3: makeCoverage(),
    C4: makeCoverage(),
  }
}

export function makeSimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    cohort: 'C2',
    author: 'acme',
    name: 'row-1',
    outcome: 'unchanged_clean',
    prePortQuarantine: false,
    postPortQuarantine: false,
    prePortRiskScore: 0,
    postPortRiskScore: 0,
    ...overrides,
  }
}

const SIMULATED_COHORT_IDS = ['C1', 'C2', 'C3', 'C4'] as const

/**
 * Finding #7 (adversarial review) made `loadSimulatorReport` cross-validate
 * `coverage`/`rows`/`counts` for internal consistency — same as
 * `counts` below, `coverage` is now DERIVED from `rows` by default (every
 * row present in `rows` counts as "scanned" for its cohort, matching
 * production's `computeCoverage` semantics in `smi5879-simulate-full.sweep.ts`)
 * so tests that only customize `rows` stay automatically consistent. Tests
 * that need a genuine coverage/rows MISMATCH (there is exactly one, G-2's
 * own "full but unevaluable>0" test) pass BOTH `rows` and `coverage`
 * explicitly in the same overrides call, same pattern as the `counts`
 * override escape hatch this mirrors.
 */
function deriveCoverageFromRows(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const coverage: Record<string, unknown> = {}
  for (const cohort of SIMULATED_COHORT_IDS) {
    const cohortRows = rows.filter((r) => r['cohort'] === cohort)
    const unevaluable = cohortRows.filter((r) => r['outcome'] === 'unevaluable').length
    const unfetchable = cohortRows.filter((r) => r['outcome'] === 'unfetchable').length
    coverage[cohort] = makeCoverage({
      scanned: cohortRows.length,
      total: cohortRows.length,
      unevaluable,
      unfetchable,
    })
  }
  return coverage
}

export function makeSimulatorReportJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const rows = (overrides['rows'] as Record<string, unknown>[] | undefined) ?? []
  const counts: Record<string, number> = Object.fromEntries(ALL_OUTCOMES.map((o) => [o, 0]))
  for (const row of rows) {
    const outcome = row['outcome'] as string
    if (outcome in counts) counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  return {
    report_kind: 'full_simulation',
    run_id: DECISION_RUN_ID,
    purpose: 'decision',
    status: 'sealed',
    token_source: 'pat',
    baseline_commit: SAMPLE_COMMIT,
    coverage: deriveCoverageFromRows(rows),
    estimated_completion_at: null,
    sweep: { passes_run: 1, hard_stopped: null },
    rows,
    counts,
    generated_at: new Date().toISOString(),
    ...overrides,
    // `counts`/`coverage` computed above must win over raw
    // `overrides.counts`/`overrides.coverage` UNLESS the caller explicitly
    // wants to force a mismatch (a few gate-specific tests do that by
    // passing them directly in overrides, which correctly overrides this
    // spread order since object spread is last-wins and `overrides` is
    // spread AFTER these computed defaults).
  }
}

// ---------------------------------------------------------------------------
// Disposition ledger / attestation fixtures
// ---------------------------------------------------------------------------

export function makeDispositionLedgerJson(
  entries: Record<string, unknown>[] = [],
  runId = DECISION_RUN_ID
): Record<string, unknown> {
  return { run_id: runId, entries }
}

export function makeAttestationChecks(
  ids: readonly string[],
  status = 'green'
): Record<string, unknown>[] {
  return ids.map((id) => ({ id, status }))
}

export function makeAttestationJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    run_id: DECISION_RUN_ID,
    checks: [],
    backfill_kill_switch_clean: true,
    pr2192a_merged: true,
    pr2192a_deploy_green: true,
    pr2192a_merged_at: '2026-07-28T00:00:00.000000Z',
    recorded_at: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fake DB / test deps
// ---------------------------------------------------------------------------

export function makeRunSummary(overrides: Partial<Smi5879RunSummary> = {}): Smi5879RunSummary {
  return {
    run_id: DECISION_RUN_ID,
    purpose: 'decision',
    status: 'sealed',
    ruleset_epoch: RULESET_EPOCH,
    snapshot_started_at: DECISION_STARTED_AT,
    snapshot_sealed_at: DECISION_STARTED_AT,
    row_count: 100,
    population_digest: 'smi5879-v1:sha256:decisiondigest',
    branch_digest: 'smi5879-v1:sha256:decisionbranchdigest',
    ...overrides,
  }
}

export function makeWindowRunSummary(
  overrides: Partial<Smi5879RunSummary> = {}
): Smi5879RunSummary {
  return makeRunSummary({
    run_id: WINDOW_RUN_ID,
    purpose: 'window',
    snapshot_started_at: WINDOW_STARTED_AT_WITHIN_BOUND,
    snapshot_sealed_at: WINDOW_STARTED_AT_WITHIN_BOUND,
    population_digest: 'smi5879-v1:sha256:windowdigest',
    branch_digest: 'smi5879-v1:sha256:windowbranchdigest',
    ...overrides,
  })
}

export function makeFakeDb(
  overrides: Partial<Smi5879GateCheckDbDeps> = {}
): Smi5879GateCheckDbDeps {
  const summaries = new Map<string, Smi5879RunSummary>([
    [DECISION_RUN_ID, makeRunSummary()],
    [WINDOW_RUN_ID, makeWindowRunSummary()],
  ])
  return {
    async getRunSummary(runId) {
      return summaries.get(runId) ?? null
    },
    async verifyDigest() {
      return { populationMatches: true, branchMatches: true }
    },
    async countFreezeLeak() {
      return 0
    },
    async enumerateDrift() {
      return []
    },
    ...overrides,
  }
}

export function makeFakeTestDeps(
  overrides: Partial<Smi5879GateCheckTestDeps> = {}
): Smi5879GateCheckTestDeps {
  return {
    async runStructuralClosureTests(): Promise<StructuralClosureResult> {
      // Default fake represents "everything about this specific check +
      // subprocess succeeded" (matching the file's existing convention for
      // `ran`/`passed`) — including the fixture-corpus corroboration
      // evidence (finding #3), so tests focused on OTHER gates keep working
      // unmodified. The PRODUCTION implementation
      // (`runStructuralClosureTestsViaVitest`) always returns `false` for
      // this field today (no producing artifact exists yet) — tests proving
      // that specific gap set this to `false` explicitly at the call site.
      return {
        ran: true,
        passed: true,
        baseline_commit: SAMPLE_COMMIT,
        unavailable_reason: null,
        fixtureCorpusCorroborationVerified: true,
      }
    },
    ...overrides,
  }
}

export function makeDriftRow(overrides: Partial<DriftRow> = {}): DriftRow {
  return {
    id: 'row-1',
    drift_class: 'DR-1-deleted-row',
    decision_content_hash: 'hash-a',
    window_content_hash: null,
    decision_score: 3,
    window_score: null,
    decision_quarantined: false,
    window_quarantined: null,
    decision_cohort: 'E',
    window_cohort: null,
    repo_url: 'https://github.com/acme/row-1',
    author: 'acme',
    name: 'row-1',
    ...overrides,
  }
}

/**
 * Write the two REQUIRED artifacts (census + simulator report) to `dir` and
 * return a ready-to-use `CliArgs`. Optional inputs (dispositions,
 * attestation, window census) are NOT written here — tests add those
 * explicitly via {@link writeFixtureFile} and spread the extra path(s) onto
 * the returned object, keeping each test's exact input surface visible at
 * the call site rather than hidden inside an over-generic builder.
 */
export function buildRequiredArgs(
  dir: string,
  opts: {
    mode?: Smi5879GateCheckMode
    decisionRunId?: string
    censusJson?: Record<string, unknown>
    simulatorJson?: Record<string, unknown>
  } = {}
): CliArgs {
  const mode = opts.mode ?? 'decision'
  const decisionRunId = opts.decisionRunId ?? DECISION_RUN_ID
  const censusPath = writeFixtureFile(dir, 'census.json', opts.censusJson ?? makeCensusReportJson())
  const simulatorPath = writeFixtureFile(
    dir,
    'simulator.json',
    opts.simulatorJson ?? makeSimulatorReportJson()
  )
  return {
    mode,
    decisionRunId,
    censusReportPath: censusPath,
    simulatorReportPath: simulatorPath,
    reportPath: join(dir, 'out.json'),
    skipClosureTests: false,
  }
}

/**
 * `--mode=reconciliation` needs a window census report too — wraps
 * {@link buildRequiredArgs} and additionally writes the window census file
 * (defaulting to {@link makeWindowCensusReportJson}'s well-formed shape) and
 * sets `windowRunId`/`windowCensusReportPath`, mirroring what `parseArgs`
 * itself requires in reconciliation mode.
 */
export function buildReconciliationArgs(
  dir: string,
  opts: {
    decisionRunId?: string
    censusJson?: Record<string, unknown>
    simulatorJson?: Record<string, unknown>
    windowRunId?: string
    windowCensusJson?: Record<string, unknown>
  } = {}
): CliArgs {
  const windowRunId = opts.windowRunId ?? WINDOW_RUN_ID
  const windowCensusReportPath = writeFixtureFile(
    dir,
    'window-census.json',
    opts.windowCensusJson ?? makeWindowCensusReportJson({ run_id: windowRunId })
  )
  return {
    ...buildRequiredArgs(dir, { mode: 'reconciliation', ...opts }),
    windowRunId,
    windowCensusReportPath,
  }
}

/** A count-tracking wrapper — asserts phase short-circuiting by call counts. */
export function makeCountingFakeDb(overrides: Partial<Smi5879GateCheckDbDeps> = {}): {
  db: Smi5879GateCheckDbDeps
  calls: { countFreezeLeak: number; enumerateDrift: number }
} {
  const calls = { countFreezeLeak: 0, enumerateDrift: 0 }
  const base = makeFakeDb(overrides)
  const db: Smi5879GateCheckDbDeps = {
    ...base,
    async countFreezeLeak(decisionRunId, windowRunId) {
      calls.countFreezeLeak++
      return base.countFreezeLeak(decisionRunId, windowRunId)
    },
    async enumerateDrift(decisionRunId, windowRunId) {
      calls.enumerateDrift++
      return base.enumerateDrift(decisionRunId, windowRunId)
    },
  }
  return { db, calls }
}
