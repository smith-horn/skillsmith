/**
 * Types for smi5879-census.ts, split out to keep that file under the 500-line
 * limit (CLAUDE.md's foo.types.ts convention).
 * @module scripts/indexer/smi5879-census.types
 */

/** `smi5879_run.purpose` — design doc 8.3.5.2.1. A `rehearsal` can never satisfy a gate. */
export type Smi5879Purpose = 'rehearsal' | 'decision' | 'window'

/** `smi5879_run.status` — design doc 8.3.5.2.1. */
export type Smi5879RunStatus = 'open' | 'sealed' | 'abandoned'

/** `smi5879_repo_branch.resolution` — design doc 8.3.5.2.2. */
export type BranchResolutionOutcome = 'resolved' | 'not-found' | 'transient' | 'unparseable'

/** Per-cohort row counts, per design doc 8.3.1.3/8.3.5.2.6. */
export interface CohortCounts {
  C1: number
  C2: number
  C3: number
  C4: number
  E: number
}

/** Result of one I-1..I-5 invariant check (design doc 8.3.1.4 / 8.3.5.2.6). */
export interface InvariantResult {
  id: 'I-1' | 'I-2' | 'I-3' | 'I-4' | 'I-5'
  name: string
  passed: boolean
  /** Human-readable detail — populated especially on failure, naming the exact violation. */
  detail: string
}

/**
 * Machine-readable census report (Wave 3 plan item 1's Files list; design doc
 * §8.5's G-6 note requires the excluded cohort-E count and a ruleset-epoch
 * provenance statement as report fields, not gating criteria).
 */
export interface Smi5879CensusReport {
  run_id: string
  purpose: Smi5879Purpose
  /** ISO 8601, UTC. Pinned literal — never `now() - interval`, per 8.3.1.3. */
  ruleset_epoch: string
  status: Smi5879RunStatus
  row_count: number
  population_digest: string | null
  branch_digest: string | null
  cohorts: CohortCounts
  /** Cohort E: excluded from full simulation on the strength of the +32 bound (8.3.1.2/8.3.1.5). */
  excluded_cohort_e_count: number
  /** Required provenance disclosure (8.5 G-6 note): `last_scanned_at` freshness is a
   * date-based proxy for ruleset version — no `scanner_ruleset_version` column
   * exists on `skills` (verified: migration 039 adds content_hash/last_scanned_at/
   * security_score/security_findings/quarantined and nothing else). The proxy's
   * failure mode is over-inclusion into C3, which enlarges the fully-simulated
   * population — cost, not risk. */
  ruleset_epoch_provenance: string
  invariants: InvariantResult[]
  branch_resolution: BranchResolutionSummary | null
  generated_at: string
}

/** Summary of the default_branch resolution pass (rehearsal/decision generations only). */
export interface BranchResolutionSummary {
  distinct_repos: number
  resolved: number
  not_found: number
  transient: number
  unparseable: number
}

/** One distinct `(owner, repo)` pair derived from a generation's population. */
export interface DistinctRepo {
  owner: string
  repo: string
}
