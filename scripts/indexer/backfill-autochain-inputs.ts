#!/usr/bin/env node
/**
 * SMI-6246: indexer-backfill-autochain.yml's checkpoint-recovery step.
 * @module scripts/indexer/backfill-autochain-inputs
 *
 * Given the GitHub Actions run id of a just-completed `indexer-backfill.yml`
 * dispatch, recovers the exact campaign-defining inputs to replay on the next
 * `gh workflow run` call — never guessing from a globally-"latest" checkpoint
 * (round-3 review finding), and correctly distinguishing "this run made no
 * checkpoint of its own because it lock-skipped" (retry from the last known
 * state) from "this checkpoint/audit row is missing for some other reason"
 * (fail closed). See docs/internal/implementation/
 * indexer-backfill-lock-yield-plan.md, change #3, and ADR-140.
 *
 * SMI-7112: queries ONLY the Supabase project the completed run targeted.
 * That project comes from the run's `display_title` (`run-name` carries
 * `env=<prod|staging>`), handed in as RUN_DISPLAY_TITLE (or an explicit
 * RECOVERY_ENV for an operator running this by hand). A title with no env
 * marker is `indeterminate` and fails the job red -- it is never defaulted to
 * prod. Missing credentials for the selected project, a read error, a
 * malformed row and an incomplete intent all THROW; only "no checkpoint and no
 * audit row" is a legitimate skip.
 *
 * Emits GITHUB_OUTPUT keys for the calling workflow step to consume:
 *   skip=true|false, skip_reason=<string>, and (only when skip=false) every
 *   recovered dispatch input plus resume_from/dry_run/supabase_env.
 *
 * Invoked directly via `npx tsx`, not imported — no exported entrypoint
 * beyond the pure helper functions, which are unit-tested directly.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { appendFileSync } from 'node:fs'
import { readCheckpoint, type BackfillCheckpointPayload } from './backfill-checkpoint.ts'

/** Credentials for the selected project are absent: red, never a silent skip. */
export class MissingCredentials extends Error {
  constructor(public readonly supabaseEnv: 'prod' | 'staging') {
    super(`Missing Supabase credentials for env=${supabaseEnv}; refusing to guess another project`)
    this.name = 'MissingCredentials'
  }
}

/** A checkpoint/audit row exists but lacks the recorded dispatch intent. */
export class IncompleteIntent extends Error {
  constructor(detail: string) {
    super(`Incomplete dispatch intent: ${detail}`)
    this.name = 'IncompleteIntent'
  }
}

/** The run's env could not be determined (no `env=` marker in its title). */
export class IndeterminateEnv extends Error {
  constructor(title: string | undefined) {
    super(`Cannot determine supabase_env from run display_title: ${JSON.stringify(title ?? null)}`)
    this.name = 'IndeterminateEnv'
  }
}

const TITLE_PATTERN = /^Skill Indexer Backfill \(env=(prod|staging)\)( \[tok=[A-Za-z0-9-]*\])?$/

/** Parse the env out of a backfill run's `display_title`; never defaults. */
export function parseSupabaseEnvFromTitle(
  title: string | undefined
): 'prod' | 'staging' | 'indeterminate' {
  const m = title === undefined ? null : TITLE_PATTERN.exec(title)
  return m ? (m[1] as 'prod' | 'staging') : 'indeterminate'
}

/**
 * SMI-6246 change #4c: consecutive retries against the same resume_from
 * before auto-chaining stops and alerts, rather than retrying indefinitely.
 * ~5 * (H_worst + G) ≈ 100 minutes of legitimate retrying before escalating
 * — an order of magnitude independent of SMI-6209's own Arm A threshold, not
 * dependent on it.
 */
const RETRY_CAP = 5

interface ResolvedDispatch {
  supabaseEnv: 'prod' | 'staging'
  resumeFrom: string
  dryRun: boolean
  dispatchInputs: NonNullable<BackfillCheckpointPayload['dispatch_inputs']>
  cursorDone: boolean
  /**
   * True when this resolution came from the failed attempt's own skip-branch
   * audit row (no progress made), never true for a fresh checkpoint. The
   * retry cap (change #4c) only applies here — a run that just made real
   * progress resets the count implicitly, since its own checkpoint IS the
   * new "last real progress" the count is measured from.
   */
  isRetry: boolean
}

/**
 * Resolves what to re-dispatch for one Supabase project: exact-match
 * checkpoint first, then the completed run's own skip-branch audit row
 * (never a global "latest" lookup -- round-3 fix).
 *
 * Returns `null` ONLY when the project has neither (legitimate "no row").
 * Throws on a read error, a malformed row, or a row lacking dispatch_inputs.
 */
export async function resolveForProject(
  supabase: SupabaseClient,
  completedRunId: string,
  supabaseEnv: 'prod' | 'staging'
): Promise<ResolvedDispatch | null> {
  const read = await readCheckpoint(supabase, completedRunId, { excludeDryRun: false })
  if (read.kind === 'error') {
    throw new Error(`Checkpoint read failed for run ${completedRunId}: ${read.reason}`)
  }
  if (read.kind === 'found') {
    const checkpoint = read.payload
    if (!checkpoint.dispatch_inputs) {
      throw new IncompleteIntent(`checkpoint for run ${completedRunId} has no dispatch_inputs`)
    }
    return {
      supabaseEnv,
      resumeFrom: completedRunId,
      dryRun: checkpoint.dry_run,
      dispatchInputs: checkpoint.dispatch_inputs,
      cursorDone: checkpoint.cursor.facet === 'done',
      isRetry: false,
    }
  }

  // No checkpoint of its own -- query the skip-branch's audit row, keyed by
  // metadata.meta.github_run_id (writeIndexerAuditLog nests the skip-branch meta
  // under `meta`; request_id is a fresh UUID and cannot be correlated).
  const { data, error } = await supabase
    .from('audit_logs')
    .select('metadata')
    .eq('event_type', 'indexer:run')
    .eq('metadata->meta->>github_run_id', completedRunId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Audit-row fallback read failed for run ${completedRunId}: ${error.message}`)
  }
  if (!data) {
    return null // zero rows: the only legitimate "no row"
  }

  // `dry_run` is a top-level metadata field (sibling to `.meta`) reflecting
  // env.DRY_RUN for THIS exact failed attempt -- the most precise source.
  const metadata = data.metadata as { dry_run?: boolean; meta?: Record<string, unknown> } | null
  const meta = metadata?.meta
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    typeof meta !== 'object' ||
    meta === null
  ) {
    throw new Error(`Audit row for run ${completedRunId} is malformed (no metadata.meta object)`)
  }
  const resumedFrom = meta.resumed_from as string | null | undefined
  const dispatchInputs = meta.dispatch_inputs as ResolvedDispatch['dispatchInputs'] | undefined
  if (!dispatchInputs) {
    throw new IncompleteIntent(`audit row for run ${completedRunId} has no dispatch_inputs`)
  }

  // The failed attempt's own resumed_from names the checkpoint it was trying
  // to continue -- retry that SAME handoff, never a "latest" lookup. A literal
  // 'latest' (fresh campaign that lock-skipped first time) has nothing to check
  // "done" against.
  let cursorDone = false
  if (resumedFrom && resumedFrom !== 'latest') {
    const prior = await readCheckpoint(supabase, resumedFrom, { excludeDryRun: false })
    if (prior.kind === 'error') {
      throw new Error(`Prior checkpoint read failed for ${resumedFrom}: ${prior.reason}`)
    }
    cursorDone = prior.kind === 'found' && prior.payload.cursor.facet === 'done'
  }

  return {
    supabaseEnv,
    // Retry the identical handoff -- no progress was made.
    resumeFrom: resumedFrom ?? 'latest',
    dryRun: metadata.dry_run ?? false,
    dispatchInputs,
    cursorDone,
    isRetry: true,
  }
}

/**
 * SMI-6246 change #4c: counts consecutive `skipped_lock` rows recorded
 * against the same `resumed_from` value, most-recent first, stopping at the
 * first row that is either a real (non-skip) success or resumes from a
 * DIFFERENT value. Used to trip the retry cap before the lock-skip
 * fallback loop (change #3) would otherwise retry indefinitely.
 */
export async function countConsecutiveSkipsForResumeFrom(
  supabase: SupabaseClient,
  resumeFrom: string,
  limit = 50
): Promise<number> {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('metadata')
    .eq('event_type', 'indexer:run')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error || !data) {
    // Fail open on a query error -- never block a real dispatch on this alone --
    // but say so: a silently-zero count would disable the retry cap unseen.
    console.log(
      `::warning::retry-cap count unavailable (${error?.message ?? 'no data'}); treating as 0`
    )
    return 0
  }

  // Scheduled discovery/maintenance/recheck rows share this same table and
  // interleave chronologically with backfill's own attempts — they must be
  // ignored entirely when counting, not treated as breaking the streak.
  // Only a backfill row (one that carries `resumed_from` at all) that is
  // EITHER a different handoff OR genuine progress ends the count.
  let count = 0
  for (const row of data as Array<{ metadata: { meta?: Record<string, unknown> } | null }>) {
    const meta = row.metadata?.meta
    if (meta?.resumed_from === undefined) {
      continue // not a backfill row at all (cron discovery/maintenance/recheck) — skip over it
    }
    if (meta.status === 'skipped_lock' && meta.resumed_from === resumeFrom) {
      count += 1
    } else {
      break // a different handoff, or real progress on this one — streak ends
    }
  }
  return count
}

/**
 * SMI-6246 change #4c: the retry-cap decision, pulled out as a pure function
 * so the exact threshold (>= RETRY_CAP, not ==, so a count that somehow
 * overshoots 5 still trips) is directly unit-testable without mocking a
 * Supabase client — the same "export only pure helpers, never `main()`
 * itself" pattern this file already uses for {@link resolveForProject} and
 * {@link countConsecutiveSkipsForResumeFrom}.
 */
export function buildRetryCapOutcome(
  consecutiveSkips: number,
  resumeFrom: string
): { skip: 'true'; retry_cap_exceeded: 'true'; skip_reason: string } | null {
  if (consecutiveSkips < RETRY_CAP) {
    return null
  }
  return {
    skip: 'true',
    retry_cap_exceeded: 'true',
    skip_reason: `Retry cap reached: ${consecutiveSkips} consecutive lock-skips against resume_from=${resumeFrom}. Stopping auto-chain rather than retrying indefinitely -- the campaign is not lost, a human should confirm why the lock has stayed contended this long.`,
  }
}

function emitOutputs(outputs: Record<string, string>): void {
  const outputFile = process.env.GITHUB_OUTPUT
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}<<EOF\n${value}\nEOF`)
    .join('\n')
  if (outputFile) {
    appendFileSync(outputFile, lines + '\n')
  } else {
    console.log(lines)
  }
}

/**
 * Full recovery for one completed run: select the project from the run's env,
 * require ITS credentials (and only its), resolve, apply the retry cap, and
 * return the GITHUB_OUTPUT map. Throws on every non-"no row" failure.
 */
export async function recover(opts: {
  completedRunId: string
  supabaseEnv: 'prod' | 'staging'
  processEnv?: NodeJS.ProcessEnv
  makeClient?: (url: string, key: string) => SupabaseClient
}): Promise<Record<string, string>> {
  const { completedRunId, supabaseEnv } = opts
  const penv = opts.processEnv ?? process.env
  const url = supabaseEnv === 'prod' ? penv.SUPABASE_URL : penv.SUPABASE_URL_STAGING
  const key =
    supabaseEnv === 'prod' ? penv.SUPABASE_SERVICE_ROLE_KEY : penv.SUPABASE_SERVICE_ROLE_KEY_STAGING
  if (!url || !key) throw new MissingCredentials(supabaseEnv)
  const makeClient =
    opts.makeClient ??
    ((u: string, k: string) =>
      createClient(u, k, { auth: { autoRefreshToken: false, persistSession: false } }))
  const client = makeClient(url, key)

  const resolved = await resolveForProject(client, completedRunId, supabaseEnv)
  if (!resolved) {
    return {
      skip: 'true',
      skip_reason: `No checkpoint or skip-branch audit row found for this run in the ${supabaseEnv} project -- failing closed rather than guessing from a global "latest" lookup.`,
    }
  }
  if (resolved.cursorDone) {
    return {
      skip: 'true',
      skip_reason: 'The underlying campaign already reached cursor.facet === "done".',
    }
  }

  // SMI-6246 change #4c: the retry cap only applies on the retry path.
  if (resolved.isRetry) {
    const capOutcome = buildRetryCapOutcome(
      await countConsecutiveSkipsForResumeFrom(client, resolved.resumeFrom),
      resolved.resumeFrom
    )
    if (capOutcome) return capOutcome
  }

  const d = resolved.dispatchInputs
  return {
    skip: 'false',
    supabase_env: resolved.supabaseEnv,
    resume_from: resolved.resumeFrom,
    dry_run: String(resolved.dryRun),
    max_skills_per_repo: d.maxSkillsPerRepo,
    path_prefix: d.pathPrefix,
    max_ranges: String(d.maxRanges),
    min_size_bytes: String(d.minSizeBytes),
    max_skills_per_dispatch: String(d.maxSkillsPerDispatch),
    max_elapsed_minutes: String(d.maxElapsedMinutes),
    accept_truncation: String(d.acceptTruncation),
    token_source: d.tokenSource,
  }
}

async function main(): Promise<void> {
  const completedRunId = process.env.COMPLETED_RUN_ID
  if (!completedRunId) {
    throw new Error('Missing required environment variable: COMPLETED_RUN_ID')
  }
  const override = process.env.RECOVERY_ENV
  const supabaseEnv =
    override === 'prod' || override === 'staging'
      ? override
      : parseSupabaseEnvFromTitle(process.env.RUN_DISPLAY_TITLE)
  if (supabaseEnv === 'indeterminate') {
    throw new IndeterminateEnv(process.env.RUN_DISPLAY_TITLE)
  }
  emitOutputs(await recover({ completedRunId, supabaseEnv }))
}

// Only run when invoked directly (npx tsx), not when imported for its
// helper functions in tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: 'autochain_inputs_error', error: String(err) }))
    process.exit(1)
  })
}
