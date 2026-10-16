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
// SMI-6246: campaign-defining inputs echoed onto the checkpoint so the
// indexer-backfill-autochain.yml watcher can recover them without guessing.
import type { BackfillDispatchInputs } from './backfill-dispatch-inputs.ts'
import type { CheckpointHaltFields } from './backfill-checkpoint.counters.ts' // SMI-7121

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
   * SMI-5286 1c: 0-based index of the next top-level facet to process in the
   * static {@link buildSizeFacets} ladder. Incremented when a top-level facet is
   * RETIRED — either fully drained OR bisected (its sub-ranges, tracked in
   * `pending_subranges`, then cover it). So it counts top-level facets whose
   * coverage is committed, NOT necessarily finished crawling; use `current_facet`
   * / `pending_subrange_count` (in the run summary) to tell 'bisecting' from 'done'.
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
  /**
   * SMI-5964 §1e: consecutive dispatches that stopped at THIS exact crawl
   * position (`path` + `facet` + `last_page`) without moving the cursor. Reset
   * to 0 by any dispatch that makes net progress. Purely advisory: absent/lost
   * reads as 0 (one extra dispatch before escalation), spuriously high
   * escalates one dispatch early on a unit that is already recorded truncated.
   * Nothing skips, advances, or persists based on this value alone — it only
   * chooses between "hold" and "escalate" in `runBackfillFacetCrawl`. Never
   * enters {@link FacetCrawlState} or {@link cursorToFacetState}'s output — it
   * is a cursor-only field, round-tripped exclusively through
   * {@link facetStateToCursor}'s 4th parameter.
   */
  no_progress_stalls?: number
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
 *
 * Retirement: a saturated range is REPLACED by its halves, so it must never be
 * revisited. If it was a sub-range (stack non-empty) we pop it; if it was the
 * TOP-LEVEL facet (stack empty) we advance `facetIndex` past it before pushing —
 * otherwise, once the halves drain, `currentFacetRange` would return the same
 * top-level facet again, it would re-saturate, and the crawl would loop forever
 * without advancing `facets_completed` (governance C-1).
 */
export function bisectCurrentFacet(state: FacetCrawlState, range: SizeFacet): boolean {
  const halves = bisectFacet(range)
  if (!halves) return false
  if (state.pendingSubranges.length > 0) {
    state.pendingSubranges.pop() // retire the sub-range being bisected
  } else {
    state.facetIndex++ // retire the top-level facet — its halves now cover it
  }
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

/**
 * Serialize the crawl frontier back into a persisted {@link BackfillCursor}.
 *
 * @param noProgressStalls - SMI-5964 §1e: the `no_progress_stalls` value to
 *   persist on the returned cursor. Optional and defaults to 0 so the three
 *   existing call sites in `backfill-checkpoint.statemachine.test.ts` (which
 *   pass only the first 3 args) stay byte-stable. `runBackfillFacetCrawl` is
 *   the one production caller that ever passes a non-zero value.
 */
export function facetStateToCursor(
  state: FacetCrawlState,
  pathPrefix: string,
  facets: SizeFacet[] = buildSizeFacets(),
  noProgressStalls = 0
): BackfillCursor {
  const range = currentFacetRange(state, facets)
  return {
    path: pathPrefix,
    facet: range ? facetId(range) : 'done',
    last_page: state.lastPage,
    facet_index: state.facetIndex,
    pending_subranges: state.pendingSubranges.map(serializeRange),
    no_progress_stalls: noProgressStalls,
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
  /**
   * SMI-6073: count of ranges this dispatch where at least one page carried
   * `incomplete_results: true` (GitHub's own documented query-timeout signal
   * — see `docs.github.com/en/rest/search/search`). Aggregated per range (not
   * per page) to avoid per-page log noise; surfaced in the
   * `[Backfill] Facet crawl:` summary line (`subdirectory-search.ts`).
   */
  incomplete_results_ranges: number
}

/**
 * Checkpoint payload persisted under `audit_logs.metadata`. `run_id` lets a
 * resume scope to a single dispatch lineage; the rest is operator observability.
 *
 * `dry_run` tags whether the writing dispatch was a dry run. Used by
 * {@link readCheckpoint} with `excludeDryRun: true` so a LIVE
 * `resume_from=latest` does not accidentally resume from a DRY_RUN cursor.
 *
 * Legacy rows written before this field was added have `dry_run` absent
 * (null in JSONB). {@link readCheckpoint} treats those as LIVE rows
 * (not excluded) — the operator is responsible for cleaning up any pre-existing
 * dry-run checkpoints during pre-flight before the first tagged live run
 * (SMI-5319 plan).
 */
export interface BackfillCheckpointPayload extends CheckpointHaltFields {
  run_id: string
  cursor: BackfillCursor
  facets_completed: number
  facets_total: number
  /** True when a facet hit the 1000-result code-search cap before exhausting. */
  cap_saturated: boolean
  /** Repos skipped because their Trees response truncated (cap or API). */
  truncated_repo_count: number
  /**
   * SMI-6073: count of ranges this dispatch where at least one page carried
   * `incomplete_results: true` — GitHub's own query-timeout signal. Mirrors
   * {@link BackfillCrawlOutcome.incomplete_results_ranges}; persisted here (not
   * just logged) so `audit_logs`-based monitoring queries (runbook §3.1) can
   * surface it, not only the GHA run log.
   */
  incomplete_results_ranges: number
  /**
   * Whether this checkpoint was written by a DRY_RUN dispatch. Tagged so live
   * resumes can skip dry-run checkpoints via {@link readCheckpoint}
   * `excludeDryRun: true`.
   */
  dry_run: boolean
  /**
   * SMI-6246: campaign-defining `workflow_dispatch` inputs echoed from the run
   * that wrote this checkpoint. Lets `indexer-backfill-autochain.yml` replay
   * the exact same campaign (including `dry_run` semantics carried alongside
   * this field) instead of defaulting every input except `resume_from` on
   * auto-chain, which would silently turn a live campaign into a dry run.
   * Optional so pre-SMI-6246 checkpoint rows still deserialize; a watcher that
   * finds one missing this field must fail closed, never default it.
   */
  dispatch_inputs?: BackfillDispatchInputs
}

/**
 * Write ONE checkpoint row to `audit_logs`. Never throws — logs internally so a
 * checkpoint failure cannot abort an in-flight backfill mid-facet (the operator
 * loop tolerates a missed checkpoint by re-running the same facet idempotently).
 *
 * DRY_RUN dispatches intentionally write checkpoints so the operator can verify
 * the resume loop end-to-end before flipping to live writes. The `dry_run` field
 * in `metadata` lets a subsequent live `resume_from=latest` skip these rows when
 * {@link readCheckpoint} is called with `excludeDryRun: true`.
 *
 * @param supabase - Supabase admin client.
 * @param payload - The checkpoint cursor + progress counters, including `dry_run`.
 * @returns true on a clean insert, false if the write was rejected/threw.
 */
/**
 * SMI-6246: the checkpoint-write RPC's contribution to `H_worst` (ADR-140's
 * timing invariant) must be a real enforced bound, not an unstated assumption
 * — see the SMI-6246 implementation plan's Change #1 arithmetic table.
 */
export const CHECKPOINT_WRITE_TIMEOUT_MS = 30_000

export async function writeCheckpoint(
  supabase: SupabaseClient,
  payload: BackfillCheckpointPayload
): Promise<boolean> {
  try {
    // SMI-6246: explicit timeout so this call's contribution to H_worst
    // (ADR-140) is a real enforced bound, not an unstated assumption. A
    // timeout still returns false (same as any other write failure) — the
    // operator loop already tolerates a missed checkpoint by re-running the
    // same facet idempotently.
    const insertPromise = supabase.from('audit_logs').insert({
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
        incomplete_results_ranges: payload.incomplete_results_ranges,
        dry_run: payload.dry_run,
        dispatch_inputs: payload.dispatch_inputs,
        dispatch_counters: payload.dispatch_counters,
        resumed_from: payload.resumed_from,
      },
    })
    // pr-reviewer round-1 finding: clear the timer on both outcomes -- an
    // uncleared setTimeout keeps the process alive for its remaining
    // duration even after the real insert wins the race.
    let timer: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<{ error: { message: string } }>((resolve) => {
      timer = setTimeout(
        () => resolve({ error: { message: 'checkpoint write timed out' } }),
        CHECKPOINT_WRITE_TIMEOUT_MS
      )
    })
    let error: { message: string } | null
    try {
      ;({ error } = await Promise.race([insertPromise, timeoutPromise]))
    } finally {
      clearTimeout(timer!)
    }
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
  /**
   * SMI-5286 1c (M-2): true crawl position. `facets_remaining` is coarse — it
   * reads 0 once the last top-level facet is retired even while its bisected
   * sub-ranges are still draining. `current_facet` (the active (sub)range id, or
   * 'done') + `pending_subrange_count` (bisection-frontier depth) let the operator
   * distinguish "finished" from "still bisecting".
   */
  current_facet?: string
  pending_subrange_count?: number
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
 * Options for {@link readCheckpoint}.
 */
export interface ReadCheckpointOptions {
  /**
   * When true, excludes rows whose `metadata.dry_run` is exactly `'true'`
   * (PostgREST text-cast of the JSONB boolean). Rows where `dry_run` is absent
   * (null -- legacy rows written before SMI-5319) are NOT excluded.
   *
   * Use `excludeDryRun: true` on a LIVE `resume_from=latest` call so it never
   * resumes from a DRY_RUN cursor. DRY_RUN dispatches pass `false` (default).
   *
   * @default false
   */
  excludeDryRun?: boolean
}

/**
 * SMI-7112: three-way outcome of a checkpoint read. `none` is ONLY "the query
 * succeeded and matched no row" -- a read error or a malformed row is `error`,
 * never `none`, so no caller can mistake a failed read for a cold start.
 */
export type ReadCheckpointResult =
  | { kind: 'found'; payload: BackfillCheckpointPayload }
  | { kind: 'none' }
  | { kind: 'error'; reason: string }

/** Minimal structural check: a string `run_id` and a `cursor` with a string `facet`. */
export function isCheckpointPayload(value: unknown): value is BackfillCheckpointPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { run_id?: unknown; cursor?: unknown }
  if (typeof v.run_id !== 'string') return false
  if (typeof v.cursor !== 'object' || v.cursor === null) return false
  return typeof (v.cursor as { facet?: unknown }).facet === 'string'
}

/**
 * Read the most recent checkpoint, optionally scoped to a single `run_id`.
 * Never collapses failure into absence: returns `{kind:'error'}` on a query
 * error, a throw, or a row whose metadata is not a valid payload. `none` means
 * no error AND no row (a cold-start id such as `coldstart-<prefix>` lands here).
 *
 * @param supabase - Supabase admin client.
 * @param runId - Optional dispatch lineage to scope the resume to. Omit,
 *   `''` or `'latest'` reads the latest checkpoint across all runs.
 * @param options - See {@link ReadCheckpointOptions}.
 */
export async function readCheckpoint(
  supabase: SupabaseClient,
  runId?: string,
  options: ReadCheckpointOptions = {}
): Promise<ReadCheckpointResult> {
  const { excludeDryRun = false } = options
  try {
    let query = supabase
      .from('audit_logs')
      .select('metadata')
      .eq('event_type', BACKFILL_CHECKPOINT_EVENT_TYPE)

    if (runId !== undefined && runId !== '' && runId !== 'latest') {
      // `metadata->>'run_id'` text-extract filter (PostgREST JSON operator).
      query = query.eq('metadata->>run_id', runId)
    }

    if (excludeDryRun) {
      // Keep legacy rows where dry_run is absent/null: `.not(...,'eq','true')`
      // would emit `NOT (col = 'true')`, NULL for a missing field, dropping the
      // row. The `.or(neq.true | is.null)` form is `IS DISTINCT FROM 'true'`.
      query = query.or('metadata->>dry_run.neq.true,metadata->>dry_run.is.null')
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error(`[BackfillCheckpoint] read failed: ${error.message}`)
      return { kind: 'error', reason: `query error: ${error.message}` }
    }
    if (data === null || data === undefined) return { kind: 'none' }
    if (!isCheckpointPayload(data.metadata)) {
      return { kind: 'error', reason: 'malformed checkpoint metadata' }
    }
    return { kind: 'found', payload: data.metadata }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown'
    console.error(`[BackfillCheckpoint] read threw: ${msg}`)
    return { kind: 'error', reason: `read threw: ${msg}` }
  }
}
