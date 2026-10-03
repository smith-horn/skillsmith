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
 * Report fixtures below are built as PLAIN JSON-shaped objects (not typed
 * against the internal `Smi5879*` interfaces) and written to real temp files
 * via {@link writeFixtureFile} — this exercises the ACTUAL file-loading +
 * shape-validation path (`smi5879-gate-check.io.ts` and `.helpers.ts`'s
 * `loadJsonFile`), not just the in-memory evaluator functions.
 *
 * TWO SIBLING MODULES hold the fixtures that only some suites need, split out
 * under SMI-6444 when this file crossed the 500-line policy cap. Import those
 * helpers from the sibling DIRECTLY — they are deliberately not re-exported
 * here, so the import graph stays one-way (siblings import from this module;
 * this module imports nothing back):
 *   - `smi5879-gate-check.fixtures.dispositions.ts` — the operator-authored
 *     G-1 disposition ledger (entries, bulk entries, `DispositionBatch`
 *     records) and the G-7/G-8 freeze attestation.
 *   - `smi5879-gate-check.fixtures.g2r.ts` — drift rows and the
 *     call-counting fake DB, used only by the G-2R suite.
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Smi5879GateCheckDbDeps,
  Smi5879GateCheckMode,
  Smi5879GateCheckTestDeps,
  Smi5879RunSummary,
  StructuralClosureResult,
} from '../../indexer/smi5879-gate-check.types.ts'
import type {
  BranchMap,
  SimSnapshotRow,
  SimulatedCohort,
} from '../../indexer/smi5879-simulate-full.types.ts'
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
  'primary_not_found',
] as const

export function makeCoverage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'full',
    scanned: 0,
    total: 0,
    unevaluable: 0,
    unfetchable: 0,
    primaryNotFound: 0,
    ...overrides,
  }
}

/**
 * The quarantine pair each SCORED outcome must carry to be internally
 * coherent — `SCORED_OUTCOMES` exactly, keyed to what
 * `expectedVerdictDeltaOutcome` derives from the pair
 * (`smi5879-merge-shards.outcome-coherence.ts`).
 *
 * SMI-6444: {@link makeSimRow} used to hand every row the same
 * `false/false/0/0` quartet regardless of outcome — rows the real simulator
 * can NEVER emit (an `unfetchable` row carrying score fields; a
 * `newly_quarantined` row whose own booleans say `unchanged_clean`). Harmless
 * while the coherence asserts ran only inside `runMergeShards`; now that
 * `bindSimulatorReportToPopulation` runs them gate-side (plan Item 2), such a
 * row correctly fails to bind. Deriving from the outcome keeps every existing
 * call site meaning what it always meant.
 */
const SCORED_OUTCOME_QUARANTINE: Record<string, { pre: boolean; post: boolean }> = {
  newly_quarantined: { pre: false, post: true },
  newly_cleared: { pre: true, post: false },
  unchanged_clean: { pre: false, post: false },
  unchanged_quarantined: { pre: true, post: true },
  // bundle_absent is scored but must be a NON-change (SMI-6436).
  bundle_absent: { pre: false, post: false },
}

export function makeSimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const outcome = (overrides['outcome'] as string | undefined) ?? 'unchanged_clean'
  const quarantine = SCORED_OUTCOME_QUARANTINE[outcome]
  return {
    id: 'row-1',
    cohort: 'C2',
    author: 'acme',
    name: 'row-1',
    outcome,
    // Non-scored outcomes (unevaluable/unfetchable/primary_not_found/
    // content_drifted) carry NO score fields at all — the real simulator
    // never attaches them, and a row that does fails
    // `assertRowOutcomeFieldPresence`.
    ...(quarantine !== undefined
      ? {
          prePortQuarantine: quarantine.pre,
          postPortQuarantine: quarantine.post,
          prePortRiskScore: 0,
          postPortRiskScore: 0,
        }
      : {}),
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
    const primaryNotFound = cohortRows.filter((r) => r['outcome'] === 'primary_not_found').length
    coverage[cohort] = makeCoverage({
      scanned: cohortRows.length,
      total: cohortRows.length,
      unevaluable,
      unfetchable,
      primaryNotFound,
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

// ---------------------------------------------------------------------------
// Sealed-population plumbing (SMI-6444)
// ---------------------------------------------------------------------------

/**
 * The population {@link makeFakeDb}'s default `loadCohortRows` serves, set by
 * {@link buildRequiredArgs} from the simulator report it just wrote.
 *
 * WHY A MODULE-SCOPED HOLDER, NOT A PARAMETER: since SMI-6444
 * `evaluateGateCheck` refuses any report not EXACTLY set-equal to the sealed
 * population, so the fake DB and the fixture report can no longer be built
 * independently — yet they are constructed at different call sites, and
 * `makeFakeDb()` is frequently evaluated BEFORE `buildRequiredArgs(...)` (it
 * sits in the first argument of the same `evaluateGateCheck(...)` call). The
 * default reader is therefore LAZY: it reads this holder when gate-check
 * actually calls it, by which point `buildRequiredArgs` has always run.
 * Vitest runs a file's tests sequentially (no `it.concurrent` in this suite),
 * so exactly one fixture is in flight at a time. A test that needs the
 * population to DIVERGE from the report passes an explicit `loadCohortRows`
 * override to {@link makeFakeDb} instead.
 */
let currentFixturePopulation: SimSnapshotRow[] = []

/**
 * Derive the sealed-population rows implied by a set of report rows.
 * `repo_url`/`skill_path` are null, so `deriveUnfetchableSubtype` resolves
 * every row as `'url_parse'` — a bulk `unfetchable` batch over these rows
 * re-derives cleanly by default. A test proving the NEGATIVE case supplies a
 * row with a real GitHub `repo_url` and an empty branch map.
 */
export function populationFromSimRows(rows: readonly Record<string, unknown>[]): SimSnapshotRow[] {
  return rows.map((row) => ({
    id: String(row['id']),
    cohort: row['cohort'] as SimulatedCohort,
    repo_url: null,
    skill_path: null,
    author: (row['author'] as string | null | undefined) ?? null,
    name: (row['name'] as string | null | undefined) ?? null,
    content_hash: null,
    snapshot_security_score: null,
    snapshot_quarantined: null,
  }))
}

/** Read the population {@link buildRequiredArgs} last installed. */
export function getFixturePopulation(): SimSnapshotRow[] {
  return currentFixturePopulation
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
    // Lazy on purpose — see currentFixturePopulation's doc comment.
    async loadCohortRows() {
      return getFixturePopulation()
    },
    async loadBranchMap(): Promise<BranchMap> {
      return new Map()
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
      // unmodified. SMI-5879 Wave 1 built the real producer
      // (`computeFixtureCorpusCorroborationVerified` in
      // `smi5879-gate-check.closure.ts`, fed by the two
      // `smi5879-corroboration.{core,edge}.test.ts` files) — this fake still
      // never calls it (this suite always injects `Smi5879GateCheckTestDeps`,
      // never the real `runStructuralClosureTestsViaVitest`); tests proving a
      // corroboration shortfall set this field to `false` explicitly at the
      // call site instead.
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
  // SMI-6444: the default report carries ONE row rather than none — a report
  // with zero rows implies a zero-row sealed population, which
  // `bindSimulatorReportToPopulation` refuses outright (an empty population
  // vacuously "matches" anything). `makeSimulatorReportJson`'s own default
  // stays `rows: []`, since merge-shards' fixtures always pass rows
  // explicitly and depend on that default.
  const simulatorJson =
    opts.simulatorJson ?? makeSimulatorReportJson({ rows: [makeSimRow({ id: 'row-1' })] })
  const simulatorPath = writeFixtureFile(dir, 'simulator.json', simulatorJson)
  currentFixturePopulation = populationFromSimRows(
    (simulatorJson['rows'] as Record<string, unknown>[] | undefined) ?? []
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
