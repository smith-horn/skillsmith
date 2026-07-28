/**
 * Types for revalidate-stale-quarantines.ts, split out to keep that file
 * under the 500-line limit (CLAUDE.md's foo.types.ts convention, SMI-5866).
 * Re-exported from revalidate-stale-quarantines.ts so existing importers
 * (recheck.ts, recheck.helpers.ts, revalidate-stale-quarantines.sibling.ts,
 * scripts/tests/indexer/recheck.test-helpers.ts) are unaffected.
 */

/** A stale-quarantined `skills` row narrowed to the columns this sweep reads. */
export interface StaleQuarantinedRow {
  id: string
  author: string | null
  name: string
  repo_url: string | null
  skill_path: string | null
  quarantine_reason: string | null
  security_findings: unknown
  /** SMI-5166: present only for recheck candidates (loadRecheckCandidates selects them). Absent (undefined) for the Wave-1 loadCandidates cohort, which preserves clear-path behavior. */
  quarantined?: boolean
  last_seen_at?: string
}

/** Per-row outcome of the stale-revalidation sweep. */
export type StaleOutcome =
  | 'cleared'
  | 'live-touched'
  | 'kept-security'
  | 'requarantined'
  | 'repo-gone'
  | 'parse-failed'
  | 'fetch-error'
  | 'cas-skipped'
  | 'error'
  | 'sibling-requarantined' // SMI-5437 W2: additive with requarantined + sibling_requarantined
  | 'sibling-recovered' //     SMI-5437 W2: additive with cleared + sibling_recovered
  | 'deferred-cap' //          SMI-5445 C2: PASS-3 row that would have cleared but hit the per-run sibling-clear cap
