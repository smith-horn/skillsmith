/**
 * SMI-7112: the backfill resume-checkpoint read, extracted from run.ts so its
 * abort-on-error contract is directly testable (run.ts runs main() on import).
 * @module scripts/indexer/backfill-resume
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readCheckpoint, type BackfillCheckpointPayload } from './backfill-checkpoint.ts'

/**
 * Load the checkpoint a backfill dispatch resumes from.
 *
 * - `found` -> the payload (resume mid-facet)
 * - `none`  -> null (a fresh crawl: no row matched, e.g. `coldstart-<prefix>`)
 * - `error` -> THROWS. A failed read must never be treated as a cold start,
 *   because that silently restarts the prefix from the beginning. The caller's
 *   existing try/finally releases the indexer lock and fails the dispatch red.
 */
export async function loadResumeCheckpoint(
  supabase: SupabaseClient,
  resumeFrom: string | undefined,
  dryRun: boolean
): Promise<BackfillCheckpointPayload | null> {
  // SMI-5319 (W3): a LIVE run excludes DRY_RUN checkpoints; a DRY_RUN run may
  // resume from the latest checkpoint of either kind.
  const read = await readCheckpoint(supabase, resumeFrom, { excludeDryRun: !dryRun })
  if (read.kind === 'error') {
    throw new Error(
      `[Backfill] checkpoint read failed -- aborting, not cold-starting: ${read.reason}`
    )
  }
  return read.kind === 'found' ? read.payload : null
}
