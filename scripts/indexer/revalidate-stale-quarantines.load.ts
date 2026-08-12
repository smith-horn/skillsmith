/**
 * Candidate-loading for revalidate-stale-quarantines.ts, split out (SMI-5879
 * round-7, design doc §11.2.8) to keep that file under its line budget.
 * Re-exported from revalidate-stale-quarantines.ts so existing importers
 * (guards.test.ts) are unaffected — mirrors the `.types.ts:1-7` convention
 * already established at that file's own re-export line.
 *
 * Two load paths, both over the SAME fixed predicate:
 *  - Paginated (`opts.limit` or unbounded): pages past PostgREST's 1000-row
 *    cap in ascending-id order.
 *  - Id-mode (`opts.ids`): design §11.2.4 — the id list INTERSECTS the fixed
 *    predicate, never bypasses it. See {@link LoadCandidatesOptions}'s doc
 *    comment for the three source-grounded safety reasons a bypass would be
 *    a real production-security bug, not merely an inconvenience.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { IN_QUERY_BATCH_SIZE } from './batch-utils.ts'
import type { StaleQuarantinedRow } from './revalidate-stale-quarantines.types.ts'

/** PostgREST caps a single response at 1000 rows; the candidate set is larger. */
export const PAGE_SIZE = 1000

/**
 * Columns `loadCandidates` reads off `skills`, shared verbatim by both the
 * paginated and id-mode query paths so the two can never silently drift.
 */
const CANDIDATE_SELECT_COLUMNS =
  'id, author, name, repo_url, skill_path, quarantine_reason, security_findings'

/**
 * Options for {@link loadCandidates}. `limit` and `ids` are mutually
 * exclusive — enforced in phase 1 of CLI parsing
 * (`revalidate-stale-quarantines.cli.ts`'s `parseIdSelection`), before any DB
 * client exists, so `loadCandidates` itself does not need to re-check it.
 */
export interface LoadCandidatesOptions {
  /** Cutoff over the discovered cohort in ascending-id page order. Mutually exclusive with `ids`. */
  limit?: number
  /**
   * Explicit id allowlist. INTERSECTED with the fixed predicate below —
   * NEVER a bypass of it (design doc §11.2.4). A bypass would be a real
   * production-security bug, forced by three source facts:
   *  1. `loadCandidates` does not select `quarantined`, so every row it
   *     returns carries `quarantined === undefined` and `processRow` routes
   *     it down the fail-closed sibling-rescan arm, whose precondition
   *     ("already known to satisfy quarantined = true") would be false for
   *     a bypassed row.
   *  2. `writeSiblingRequarantine` has NO `quarantined` CAS guard — it would
   *     unconditionally quarantine a live, healthy skill reached via a
   *     bypass and judged malicious by the sibling scan.
   *  3. `repo_url ILIKE 'https://github.com/%'` is a precondition of
   *     `parseSkillMdUrl`; a bypassed non-GitHub row would be
   *     `retagUnreachable`'d as "Repository deleted or not found" — a write
   *     that mislabels a healthy row. And the `quarantine_reason` clause is
   *     what keeps security-quarantined rows out of the sweep at all.
   *
   * When set, `loadCandidates` chunks the id list at `IN_QUERY_BATCH_SIZE`
   * and issues one `.in('id', chunk)` query per chunk — sequentially, never
   * concurrently, and never via `.range()` (chunks are ≤100 rows, far under
   * `PAGE_SIZE`). Round-7-review correction (design §11.2.6): this does NOT
   * reuse `batchedIn()` (`batch-utils.ts`) — that helper discards a
   * PostgREST/network `error` and silently returns `[]`, indistinguishable
   * from "no row in this chunk matched the filter." That would let a
   * transient query failure masquerade as a genuine `not-loaded` id (design
   * §11.2.5) that an operator could then prune from an `--ids-file` without
   * the row ever having actually been checked — 11.1's exact failure class,
   * reintroduced by the fix meant to close it. `batchedIn()` itself is
   * untouched by this change; its error-swallowing is filed separately as
   * SMI-T.
   */
  ids?: readonly string[]
}

/**
 * Load all stale-quarantined candidates.
 *
 * Candidate set (both paths): `quarantined = true` AND `repo_url ILIKE
 * 'https://github.com/%'` AND (`quarantine_reason IS NULL` OR
 * `quarantine_reason = 'stale'`). `quarantine_reason IS NULL` covers legacy
 * rows quarantined before the reason column was populated; `'stale'` is what
 * the stale-reconciliation path writes.
 *
 * `opts.ids`, when present, selects the id-mode path (see
 * {@link LoadCandidatesOptions.ids}); otherwise the paginated path applies
 * `opts.limit` as a page-arithmetic cutoff over the ascending-id ordering.
 */
export async function loadCandidates(
  db: SupabaseClient,
  opts: LoadCandidatesOptions = {}
): Promise<StaleQuarantinedRow[]> {
  if (opts.ids !== undefined) return loadCandidatesByIds(db, opts.ids)
  return loadCandidatesPaginated(db, opts.limit)
}

/**
 * Paginated whole-cohort load, ordered by `id` (stable PK) so page
 * boundaries are consistent. ALL rows are collected before the caller
 * processes them, so apply-mode mutations (which drop rows out of the
 * candidate set) cannot shift later page offsets.
 */
async function loadCandidatesPaginated(
  db: SupabaseClient,
  limit?: number
): Promise<StaleQuarantinedRow[]> {
  const out: StaleQuarantinedRow[] = []
  for (let page = 0; ; page++) {
    const remaining = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - out.length)
    if (remaining <= 0) break
    const from = page * PAGE_SIZE
    const { data, error } = await db
      .from('skills')
      .select(CANDIDATE_SELECT_COLUMNS)
      .eq('quarantined', true)
      .ilike('repo_url', 'https://github.com/%')
      .or('quarantine_reason.is.null,quarantine_reason.eq.stale')
      .order('id', { ascending: true })
      .range(from, from + remaining - 1)
    if (error)
      throw new Error(`Failed to load stale-quarantined rows (page ${page}): ${error.message}`)
    const rows = (data ?? []) as StaleQuarantinedRow[]
    out.push(...rows)
    if (limit !== undefined && out.length >= limit) return out.slice(0, limit)
    if (rows.length < remaining) break
  }
  return out
}

/**
 * Id-mode candidate load (design §11.2.6, round-7-review correction).
 * Chunks `ids` at `IN_QUERY_BATCH_SIZE` and issues one `.in('id', chunk)`
 * query per chunk, sequentially — each chunk is `await`ed before the next
 * runs, so an error on chunk N is thrown before chunk N+1 ever executes.
 *
 * Deliberately does NOT call `batchedIn()` — see
 * {@link LoadCandidatesOptions.ids}'s doc comment. This loop destructures
 * BOTH `data` and `error` and throws on a non-null `error` BEFORE `data` is
 * read at all (a PostgREST timeout can return a non-null PARTIAL `data`
 * alongside a non-null `error` — the `error` check must not be skipped just
 * because `data` looks usable). Fatal in both dry-run and apply mode: unlike
 * a genuine `not-loaded` divergence (design §11.2.5), a query error is never
 * a legitimate outcome to report past.
 */
async function loadCandidatesByIds(
  db: SupabaseClient,
  ids: readonly string[]
): Promise<StaleQuarantinedRow[]> {
  const out: StaleQuarantinedRow[] = []
  for (let i = 0; i < ids.length; i += IN_QUERY_BATCH_SIZE) {
    const chunk = ids.slice(i, i + IN_QUERY_BATCH_SIZE)
    const { data, error } = await db
      .from('skills')
      .select(CANDIDATE_SELECT_COLUMNS)
      .eq('quarantined', true)
      .ilike('repo_url', 'https://github.com/%')
      .or('quarantine_reason.is.null,quarantine_reason.eq.stale')
      .order('id', { ascending: true })
      .in('id', chunk)
    if (error) {
      const chunkNumber = Math.floor(i / IN_QUERY_BATCH_SIZE) + 1
      throw new Error(
        `Failed to load stale-quarantined rows by id (chunk ${chunkNumber}, ids: ${chunk.join(', ')}): ${error.message}`
      )
    }
    out.push(...((data ?? []) as StaleQuarantinedRow[]))
  }
  return out
}
