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

/** `event_type` discriminator for backfill checkpoint rows in `audit_logs`. */
export const BACKFILL_CHECKPOINT_EVENT_TYPE = 'indexer_backfill_checkpoint'

/**
 * Resume cursor. `(path, facet, last_page)` lets a re-dispatch resume mid-facet,
 * not just at facet boundaries (SPARC §#5 facet-AND-page granularity).
 */
export interface BackfillCursor {
  /** The path-prefix facet being crawled (e.g. '.agents/skills'). */
  path: string
  /** The active facet window within that path (e.g. a date/size bucket; Wave 1c). */
  facet: string
  /** Last code-search page consumed within the current facet (1-based). */
  last_page: number
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
