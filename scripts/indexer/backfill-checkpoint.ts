/**
 * Backfill checkpoint/resume scaffold (SMI-5286 Wave 1b §#5)
 * @module scripts/indexer/backfill-checkpoint
 *
 * The out-of-band backfill workflow (Wave 1b; the workflow YAML ships
 * separately) runs across the 6h GHA cap as a sequence of dispatches. Each
 * dispatch does as many facets/pages as fit, writes ONE checkpoint, and exits
 * 0; the operator re-dispatches with `resume_from=latest` until
 * `facets_remaining == 0`. This module owns the checkpoint read/write so the
 * orchestrator stays under the 500-line CI gate.
 *
 * Storage: reuses the existing `audit_logs` table (SMI-2199 decision #1 — no new
 * table), matching the `writeIndexerAuditLog` shape exactly
 * (`event_type` / `actor` / `action` / `result` / `metadata` JSONB). The
 * checkpoint payload lives under `metadata` (the table's JSONB column — the SPARC
 * §#5 "payload" wording maps to `audit_logs.metadata`, the column that actually
 * exists). `event_type='indexer_backfill_checkpoint'` is the discriminator.
 *
 * Scope note: the facet-iterating DRIVER that produces these cursors lands in
 * Wave 1c (facet partitioning). Wave 1b ships only the typed read/write surface
 * the workflow worker + 1c consume — the cursor fields can be written now.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { type SizeFacet, buildSizeFacets, facetId, bisectFacet } from './code-search.facets.ts'

/** `event_type` discriminator for backfill checkpoint rows in `audit_logs`. */
export const BACKFILL_CHECKPOINT_EVENT_TYPE = 'indexer_backfill_checkpoint'

/**
 * A persisted size sub-range `[lo, hi]`. `hi` is `null` when the range is
 * open-ended (`Infinity`) — `Infinity` does NOT survive `JSON.stringify`
 * (it serializes to `null`), so the cursor uses an explicit `null` sentinel and
 * {@link deserializeRange} maps it back to `Number.POSITIVE_INFINITY`.
 */
export type PersistedSubrange = [number, number | null]

/**
 * Resume cursor. `(path, facet, last_page)` lets a re-dispatch resume mid-facet,
 * not just at facet boundaries (SPARC §#5 facet-AND-page granularity).
 */
export interface BackfillCursor {
  /** The path-prefix being crawled ('' = the broad, no-`path:` query). */
  path: string
  /** Stable id of the active size facet/sub-range ({@link facetId}); 'done' when complete. */
  facet: string
  /** Last code-search page consumed within the current (sub)range (1-based; 0 = none yet). */
  last_page: number
  /**
   * SMI-5286 1c: 0-based index of the current TOP-LEVEL facet in the static
   * {@link buildSizeFacets} ladder. Equals the number of fully-completed facets.
   */
  facet_index?: number
  /**
   * SMI-5286 1c: the in-progress bisection frontier — sub-ranges of the current
   * facet not yet fully crawled (DFS stack; the LAST element is crawled next).
   * Persisted so a dispatch boundary mid-bisection resumes without losing
   * not-yet-crawled sub-ranges (the bare `(path,facet,last_page)` cursor cannot
   * represent a partial bisection tree, C-2).
   */
  pending_subranges?: PersistedSubrange[]
}

/** Map a runtime {@link SizeFacet} to its JSON-safe persisted form (`Infinity` → `null`). */
function serializeRange(facet: SizeFacet): PersistedSubrange {
  return [facet.lo, Number.isFinite(facet.hi) ? facet.hi : null]
}

/** Map a persisted sub-range back to a runtime {@link SizeFacet} (`null` → `Infinity`). */
function deserializeRange([lo, hi]: PersistedSubrange): SizeFacet {
  return { lo, hi: hi == null ? Number.POSITIVE_INFINITY : hi }
}

/**
 * Runtime crawl frontier reconstructed from a {@link BackfillCursor}. The facet
 * driver is a depth-first walk of the static size ladder: each top-level facet
 * that saturates the 1000-result cap is bisected into `pendingSubranges`, which
 * are drained (themselves bisecting further) before `facetIndex` advances.
 */
export interface FacetCrawlState {
  /** Index into {@link buildSizeFacets} of the current top-level facet. */
  facetIndex: number
  /** DFS stack of sub-ranges still to crawl for the current facet; head crawled next. */
  pendingSubranges: SizeFacet[]
  /** Last page consumed within the current (sub)range (0 = none). */
  lastPage: number
}

/** Reconstruct the crawl frontier from a persisted cursor (or a cold start). */
export function cursorToFacetState(cursor: BackfillCursor | null | undefined): FacetCrawlState {
  if (!cursor) return { facetIndex: 0, pendingSubranges: [], lastPage: 0 }
  return {
    facetIndex: cursor.facet_index ?? 0,
    pendingSubranges: (cursor.pending_subranges ?? []).map(deserializeRange),
    lastPage: cursor.last_page ?? 0,
  }
}

/**
 * The range currently being crawled: the head of the bisection stack, else the
 * top-level facet at `facetIndex`. `null` once the ladder is exhausted.
 */
export function currentFacetRange(
  state: FacetCrawlState,
  facets: SizeFacet[] = buildSizeFacets()
): SizeFacet | null {
  if (state.pendingSubranges.length > 0) {
    return state.pendingSubranges[state.pendingSubranges.length - 1]
  }
  if (state.facetIndex < facets.length) return facets[state.facetIndex]
  return null
}

/**
 * Replace the current saturated range with its two halves (the first half is
 * crawled next). Resets the page cursor. Returns false when the range cannot
 * subdivide (the caller then records truncation and advances).
 */
export function bisectCurrentFacet(state: FacetCrawlState, range: SizeFacet): boolean {
  const halves = bisectFacet(range)
  if (!halves) return false
  if (state.pendingSubranges.length > 0) state.pendingSubranges.pop()
  // Push so halves[0] ends up on top (LIFO) → the lower sub-range is crawled next.
  state.pendingSubranges.push(halves[1], halves[0])
  state.lastPage = 0
  return true
}

/**
 * Advance past the current exhausted (or unbisectable-saturated) range: pop the
 * bisection stack if non-empty, else advance the top-level facet index. Resets
 * the page cursor.
 */
export function advanceFacet(state: FacetCrawlState): void {
  if (state.pendingSubranges.length > 0) state.pendingSubranges.pop()
  else state.facetIndex++
  state.lastPage = 0
}

/** True when every top-level facet AND its bisection frontier are exhausted. */
export function isFacetCrawlDone(
  state: FacetCrawlState,
  facets: SizeFacet[] = buildSizeFacets()
): boolean {
  return state.facetIndex >= facets.length && state.pendingSubranges.length === 0
}

/** Serialize the crawl frontier back into a persisted {@link BackfillCursor}. */
export function facetStateToCursor(
  state: FacetCrawlState,
  pathPrefix: string,
  facets: SizeFacet[] = buildSizeFacets()
): BackfillCursor {
  const range = currentFacetRange(state, facets)
  return {
    path: pathPrefix,
    facet: range ? facetId(range) : 'done',
    last_page: state.lastPage,
    facet_index: state.facetIndex,
    pending_subranges: state.pendingSubranges.map(serializeRange),
  }
}

/**
 * The outcome of one dispatch's facet crawl: the advanced cursor to persist, a
 * terminal flag, and the operator-observable counters. Lives here (not in
 * `subdirectory-search.ts`) so `indexer-types.ts` can reference it without
 * importing the search module.
 */
export interface BackfillCrawlOutcome {
  cursor: BackfillCursor
  done: boolean
  cap_saturated: boolean
  truncated_repo_count: number
  facets_completed: number
  facets_total: number
  ranges_crawled: number
}

/**
 * Checkpoint payload persisted under `audit_logs.metadata`. `run_id` lets a
 * resume scope to a single dispatch lineage; the rest is operator observability.
 */
export interface BackfillCheckpointPayload {
  run_id: string
  cursor: BackfillCursor
  facets_completed: number
  facets_total: number
  /** True when a facet hit the 1000-result code-search cap before exhausting. */
  cap_saturated: boolean
  /** Repos skipped because their Trees response truncated (cap or API). */
  truncated_repo_count: number
}

/**
 * Write ONE checkpoint row to `audit_logs`. Never throws — logs internally so a
 * checkpoint failure cannot abort an in-flight backfill mid-facet (the operator
 * loop tolerates a missed checkpoint by re-running the same facet idempotently).
 *
 * @param supabase - Supabase admin client.
 * @param payload - The checkpoint cursor + progress counters.
 * @returns true on a clean insert, false if the write was rejected/threw.
 */
export async function writeCheckpoint(
  supabase: SupabaseClient,
  payload: BackfillCheckpointPayload
): Promise<boolean> {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      event_type: BACKFILL_CHECKPOINT_EVENT_TYPE,
      actor: 'system',
      action: 'backfill_checkpoint',
      result: 'success',
      metadata: {
        run_id: payload.run_id,
        cursor: payload.cursor,
        facets_completed: payload.facets_completed,
        facets_total: payload.facets_total,
        cap_saturated: payload.cap_saturated,
        truncated_repo_count: payload.truncated_repo_count,
      },
    })
    if (error) {
      console.error(`[BackfillCheckpoint] write failed: ${error.message}`)
      return false
    }
    return true
  } catch (err) {
    console.error(
      `[BackfillCheckpoint] write threw: ${err instanceof Error ? err.message : 'Unknown'}`
    )
    return false
  }
}

/**
 * The `backfill` sub-object emitted on the indexer's stdout summary under
 * `data.backfill` when `BACKFILL_MODE` is true (SMI-5286 Wave 1b §#2). The
 * `indexer-backfill.yml` guardian reads `data.backfill.token_source` and fails
 * the run if it sees `'app'`, proving the backfill consumed the PAT rate bucket
 * — not the cron's GitHub App bucket. The facet counters are 0 in Wave 1b (facet
 * partitioning lands in Wave 1c); `token_source` is the load-bearing field here.
 */
export interface BackfillSummary {
  /** Which GitHub credential the run authenticated with. `'pat'` on a backfill dispatch. */
  token_source: 'app' | 'pat'
  /** Id of the checkpoint read/written this dispatch, or null on a cold start. */
  checkpoint_id: string | null
  facets_total: number
  facets_completed: number
  facets_remaining: number
  cap_saturated: boolean
  truncated_repo_count: number
}

/**
 * Derive the GitHub token source the run will authenticate with, mirroring the
 * exact emptiness check in `getInstallationToken()` (github-auth.ts:124-130):
 * the App path is active iff all three of `GITHUB_APP_ID`,
 * `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` are set and
 * non-empty. Kept local to the backfill surface so the shared `_shared`
 * github-auth module stays untouched.
 *
 * @param env - The process env to read (defaults to `process.env`).
 * @returns `'app'` when all three App vars are present and non-empty, else `'pat'`.
 */
export function resolveTokenSource(env: NodeJS.ProcessEnv = process.env): 'app' | 'pat' {
  const appId = env.GITHUB_APP_ID
  const installationId = env.GITHUB_APP_INSTALLATION_ID
  const privateKey = env.GITHUB_APP_PRIVATE_KEY
  return appId && installationId && privateKey ? 'app' : 'pat'
}

/**
 * Read the most recent checkpoint, optionally scoped to a single `run_id`.
 * Returns null when no checkpoint exists (cold start) or on read failure — the
 * caller treats null as "start from the beginning".
 *
 * @param supabase - Supabase admin client.
 * @param runId - Optional dispatch lineage to scope the resume to. Omit (or pass
 *   undefined) to read the latest checkpoint across all runs (the `latest`
 *   default the workflow's `resume_from` input maps to).
 * @returns The latest matching checkpoint payload, or null.
 */
export async function readLatestCheckpoint(
  supabase: SupabaseClient,
  runId?: string
): Promise<BackfillCheckpointPayload | null> {
  try {
    let query = supabase
      .from('audit_logs')
      .select('metadata')
      .eq('event_type', BACKFILL_CHECKPOINT_EVENT_TYPE)

    if (runId !== undefined && runId !== '' && runId !== 'latest') {
      // `metadata->>'run_id'` text-extract filter (PostgREST JSON operator).
      query = query.eq('metadata->>run_id', runId)
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error(`[BackfillCheckpoint] read failed: ${error.message}`)
      return null
    }
    if (!data?.metadata) return null

    return data.metadata as unknown as BackfillCheckpointPayload
  } catch (err) {
    console.error(
      `[BackfillCheckpoint] read threw: ${err instanceof Error ? err.message : 'Unknown'}`
    )
    return null
  }
}
