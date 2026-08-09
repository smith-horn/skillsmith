/**
 * Types for smi5879-simulate-full.ts, split out per CLAUDE.md's `foo.types.ts`
 * convention.
 * @module scripts/indexer/smi5879-simulate-full.types
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.2/§8.3.5/§8.5
 */

import type { ScanSkillBundleResult } from './skill-processor.security.ts'
import type { RateLimitTelemetry } from './_shared/rate-limit.ts'
import type { Smi5879Purpose, Smi5879RunStatus } from './smi5879-census.types.ts'

/** Cohorts the simulator fully evaluates. Cohort E is structurally excluded (item 2). */
export type SimulatedCohort = 'C1' | 'C2' | 'C3' | 'C4'

/**
 * Closed tier-2 outcome vocabulary (plan §3b). `gate-check.ts` refuses an
 * unrecognised value — this union is the enforcement point on our side.
 */
export type SimRowOutcome =
  | 'newly_quarantined'
  | 'newly_cleared'
  | 'unchanged_clean'
  | 'unchanged_quarantined'
  | 'content_drifted'
  | 'bundle_absent'
  | 'unevaluable'
  | 'unfetchable'

/** One row read from the sealed generation's population (`smi5879_snapshot_pre`), cohort-tagged. */
export interface SimSnapshotRow {
  id: string
  cohort: SimulatedCohort
  repo_url: string | null
  skill_path: string | null
  author: string | null
  name: string | null
  /** SHA-256 of the SKILL.md content as recorded at snapshot time, or null (never scanned). */
  content_hash: string | null
  /** Snapshot-time state, carried through for G-1 reviewer legibility only — never compared against. */
  snapshot_security_score: number | null
  snapshot_quarantined: boolean | null
}

/** `smi5879_repo_branch` resolution for one distinct `(owner, repo)` — item 1, design 8.3.5.2.2. */
export interface RepoBranchInfo {
  resolution: 'resolved' | 'not-found' | 'transient' | 'unparseable'
  default_branch: string | null
}

/** Keyed `${owner}/${repo}`. */
export type BranchMap = Map<string, RepoBranchInfo>

/** Per-row simulation result. */
export interface SimRowResult {
  id: string
  cohort: SimulatedCohort
  author: string | null
  name: string | null
  outcome: SimRowOutcome
  /** Populated whenever `outcome` isn't a plain verdict-delta bucket — names the exact cause. */
  reason?: string
  prePortQuarantine?: boolean
  postPortQuarantine?: boolean
  prePortRiskScore?: number
  postPortRiskScore?: number
}

/** `coverage.<cohort>` — design doc 8.4 / plan §3c. */
export interface CohortCoverage {
  status: 'full' | 'partial'
  scanned: number
  total: number
  unevaluable: number
  unfetchable: number
}

export type CoverageByCohort = Record<SimulatedCohort, CohortCoverage>

/** `token_source` — plan §3a. Hard-refuses to start when resolved as `'app'`. */
export type TokenSource = 'app' | 'pat'

/** Tier-3 sweep termination reason (plan §3b tier 3), or `null` on convergence. */
export type SweepHardStopReason = 'non_convergence' | 'max_passes' | null

/**
 * On-disk resumable checkpoint (plan §3c "resumable, checkpointed"). Written
 * after every processing batch and every sweep pass. `clean_shutdown` starts
 * `false` for every interim write and is flipped to `true` only immediately
 * before a graceful process exit — see design doc 8.3.5.2.4's "abnormal
 * termination" definition, which this field directly feeds.
 */
export interface Smi5879SimulateCheckpoint {
  run_id: string
  purpose: Smi5879Purpose
  baseline_commit: string
  token_source: TokenSource
  /** True only immediately before a graceful exit; false at every interim write. */
  clean_shutdown: boolean
  /** Per-row outcomes recorded so far (main pass + all sweep passes), keyed by row id. */
  row_results: Record<string, SimRowResult>
  sweep: {
    pass: number
    residual_history: number[]
    /**
     * The tier-3 sweep's two-consecutive-non-decrease hard-stop streak, as of
     * the last persisted pass. Threaded back into `runTier3Sweep`'s
     * `startingNonDecreaseStreak` on resume so a crash mid-sweep can't reset
     * the streak and let a non-converging run keep going past where it
     * should have hard-stopped (SMI-5879 review finding 2a).
     */
    non_decrease_streak: number
    hard_stopped: SweepHardStopReason
  }
  started_at: string
  updated_at: string
}

/** Machine-readable simulator report — the gate-eligible artifact (plan §3, design 8.4). */
export interface Smi5879SimulateFullReport {
  report_kind: 'full_simulation'
  run_id: string
  purpose: Smi5879Purpose
  status: Smi5879RunStatus
  token_source: TokenSource
  baseline_commit: string
  coverage: CoverageByCohort
  estimated_completion_at: string | null
  sweep: {
    passes_run: number
    hard_stopped: SweepHardStopReason
  }
  /** Full per-row results — the source of R (union of newly_quarantined/newly_cleared) for G-1. */
  rows: SimRowResult[]
  counts: Record<SimRowOutcome, number>
  generated_at: string
}

/** Injectable DB-facing dependencies — production wires real psql calls; tests inject fakes. */
export interface Smi5879SimulateFullDbDeps {
  getRunSummary(
    runId: string
  ): Promise<{ purpose: Smi5879Purpose; status: Smi5879RunStatus } | null>
  claimRun(runId: string, token: string, holder: string): Promise<{ claimed: boolean }>
  /** Returns the new heartbeat timestamp, or null when the claim was lost (fatal — see design 8.3.5.2.5). */
  heartbeat(runId: string, token: string): Promise<string | null>
  releaseRun(runId: string, token: string): Promise<void>
  /** Recomputes and compares both digests against the sealed values recorded at seal time. */
  verifyDigest(runId: string): Promise<{ populationMatches: boolean; branchMatches: boolean }>
  loadCohortRows(runId: string): Promise<SimSnapshotRow[]>
  loadBranchMap(runId: string): Promise<BranchMap>
}

/** Injectable scan-surface dependencies — the dual-scan mechanics (design 8.2.3). */
export interface Smi5879SimulateFullScanDeps {
  scanPostPort: ScanSkillBundleFn
  scanPrePort: ScanSkillBundleFn
  telemetry: RateLimitTelemetry
  headers: Record<string, string>
}

/** `scanSkillBundle`'s exact signature — matched structurally so a baseline-materialized twin type-checks. */
export type ScanSkillBundleFn = (
  owner: string,
  repo: string,
  branch: string,
  skillPath: string | undefined,
  primaryContent: string,
  telemetry: RateLimitTelemetry,
  deps?: {
    fetchSiblingContent?: (
      owner: string,
      repo: string,
      branch: string,
      relPath: string,
      telemetry: RateLimitTelemetry
    ) => Promise<{ content: string } | { removed: true } | null>
  }
) => Promise<ScanSkillBundleResult>
