/**
 * SMI-5898 Wave 2 Step 4: shared types for `merge-duplicate-skills.ts` +
 * `.helpers.ts`, split out to keep both files under the repo's 500-line
 * standard (`scripts/check-file-length.mjs`'s convention).
 */

/** R4 guardrail (design doc §B.3.3) — abort if the key ever selects more than a hand-count of rows. */
export const GUARDRAIL_MAX_LOSERS = 500

/** The six tables with a real or soft reference into `skills.id`, per design doc §B.3.2. */
export const DEPENDENT_TABLES = [
  'skill_categories',
  'skills_optimized',
  'skill_transformations',
  'outreach_suppressions',
  'outreach_events',
  'quarantine_approvals',
] as const
export type DependentTable = (typeof DEPENDENT_TABLES)[number]

/** A single `skills` row as read for grouping/ranking. */
export interface SkillRow {
  id: string
  repo_url_canonical: string
  repo_url: string | null
  author: string | null
  name: string
  quarantined: boolean
  last_seen_at: string | null
  trust_tier: string | null
  stars: number | null
  updated_at: string | null
}

/** One duplicate group: a survivor plus its losers, ranked per the canonical survivor-selection order. */
export interface DuplicateGroup {
  repoUrlCanonical: string
  survivor: SkillRow
  losers: SkillRow[]
}

/** Per-table row-movement counts for one group, for the dry-run report. */
export interface TableMovement {
  table: DependentTable
  rePointed: number
  discarded: number
  skippedOnConflict: number
}

export interface QuarantineApprovalDelta {
  skillId: string
  before: boolean
  after: boolean
}

export interface ReversalManifest {
  createdAt: string
  groups: Array<{
    repoUrlCanonical: string
    survivorId: string
    loserIds: string[]
  }>
  /** Full pre-merge row snapshots, keyed by table name. */
  rows: Record<'skills' | DependentTable, unknown[]>
}

export interface MergeCounts {
  groups: number
  losersRemoved: number
  tableMovements: TableMovement[]
  isCompleteDeltas: QuarantineApprovalDelta[]
  suppressionCountBefore: number
  suppressionCountAfter: number
}
