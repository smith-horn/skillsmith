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
 * Tries the PROD Supabase project first, then STAGING, since the watcher
 * doesn't know ahead of time which project the completed run's own campaign
 * targeted — reading that is exactly what this script is trying to recover.
 * Whichever project has a matching row (checkpoint or audit row) for the
 * given run id wins; if PROD has neither, STAGING is tried next.
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
import { readLatestCheckpoint, type BackfillCheckpointPayload } from './backfill-checkpoint.ts'

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
 * (never a global "latest" lookup — round-3 fix). Returns `null` if this
 * project has neither, so the caller can try the other project.
 */
export async function resolveForProject(
  supabase: SupabaseClient,
  completedRunId: string,
  supabaseEnv: 'prod' | 'staging'
): Promise<ResolvedDispatch | null> {
  const checkpoint = await readLatestCheckpoint(supabase, completedRunId, { excludeDryRun: false })
  if (checkpoint) {
    if (!checkpoint.dispatch_inputs) {
      return null // predates SMI-6246 or malformed — caller fails closed
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

  // No checkpoint of its own — query the skip-branch's audit row, keyed by
  // the new github_run_id field (request_id is a fresh UUID per invocation
  // and cannot be correlated to a GitHub Actions run id at all).
  //
  // pr-reviewer finding (round 1): github_run_id lives at metadata.meta.github_run_id,
  // NOT metadata.github_run_id -- writeIndexerAuditLog (indexer-audit-log.ts) nests
  // the whole skip-branch meta object under a `meta` key, matching the documented
  // `metadata->'meta'->>'...'` convention (see indexer-audit-log.ts's own header
  // comment). The original `metadata->>github_run_id` path here would never match
  // any row, silently failing every fallback recovery.
  const { data, error } = await supabase
    .from('audit_logs')
    .select('metadata')
    .eq('event_type', 'indexer:run')
    .eq('metadata->meta->>github_run_id', completedRunId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    return null
  }

  // `dry_run` is a top-level metadata field (writeIndexerAuditLog's own
  // params.dryRun, sibling to `.meta`) reflecting env.DRY_RUN for THIS exact
  // failed attempt — the most precise source, since it needs no inference
  // from any other row.
  const metadata = data.metadata as {
    dry_run?: boolean
    meta?: Record<string, unknown>
  } | null
  const meta = metadata?.meta
  const resumedFrom = meta?.resumed_from as string | null | undefined
  const dispatchInputs = meta?.dispatch_inputs as ResolvedDispatch['dispatchInputs'] | undefined
  if (!dispatchInputs) {
    return null
  }

  // The failed attempt's own resumed_from names the checkpoint it was trying
  // to continue — retry that SAME handoff, never a "latest" lookup. If it was
  // the literal 'latest' (a genuinely fresh campaign that unluckily lock-skipped
  // on its first attempt), there is no prior checkpoint to check "done" against.
  let cursorDone = false
  if (resumedFrom && resumedFrom !== 'latest') {
    const priorCheckpoint = await readLatestCheckpoint(supabase, resumedFrom, {
      excludeDryRun: false,
    })
    cursorDone = priorCheckpoint?.cursor.facet === 'done'
  }

  return {
    supabaseEnv,
    // Retry the identical handoff — no progress was made, so resuming from
    // whatever this failed attempt was itself given is correct.
    resumeFrom: resumedFrom ?? 'latest',
    dryRun: metadata?.dry_run ?? false,
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
    return 0 // fail open on a query error — never block a real dispatch on this alone
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

async function main(): Promise<void> {
  const completedRunId = process.env.COMPLETED_RUN_ID
  if (!completedRunId) {
    throw new Error('Missing required environment variable: COMPLETED_RUN_ID')
  }

  const projects: Array<{ env: 'prod' | 'staging'; url?: string; key?: string }> = [
    {
      env: 'prod',
      url: process.env.SUPABASE_URL_PROD,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY_PROD,
    },
    {
      env: 'staging',
      url: process.env.SUPABASE_URL_STAGING,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING,
    },
  ]

  let resolved: ResolvedDispatch | null = null
  let resolvedClient: SupabaseClient | null = null
  for (const project of projects) {
    if (!project.url || !project.key) continue
    const client = createClient(project.url, project.key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    resolved = await resolveForProject(client, completedRunId, project.env)
    if (resolved) {
      resolvedClient = client
      break
    }
  }

  if (!resolved || !resolvedClient) {
    emitOutputs({
      skip: 'true',
      skip_reason:
        'No checkpoint or skip-branch audit row found for this run in either Supabase project — failing closed rather than guessing from a global "latest" lookup.',
    })
    return
  }

  if (resolved.cursorDone) {
    emitOutputs({
      skip: 'true',
      skip_reason: 'The underlying campaign already reached cursor.facet === "done".',
    })
    return
  }

  // SMI-6246 change #4c: the retry cap only applies on the retry path (no
  // progress this attempt) — a fresh checkpoint's own success is not itself
  // a "consecutive skip" and never trips this. pr-reviewer round-1 finding:
  // this was designed in the plan and documented in the runbook/CLAUDE.md as
  // already shipped, but was never actually implemented — closing that gap.
  if (resolved.isRetry) {
    const consecutiveSkips = await countConsecutiveSkipsForResumeFrom(
      resolvedClient,
      resolved.resumeFrom
    )
    if (consecutiveSkips >= RETRY_CAP) {
      emitOutputs({
        skip: 'true',
        retry_cap_exceeded: 'true',
        skip_reason: `Retry cap reached: ${consecutiveSkips} consecutive lock-skips against resume_from=${resolved.resumeFrom}. Stopping auto-chain rather than retrying indefinitely -- the campaign is not lost, a human should confirm why the lock has stayed contended this long.`,
      })
      return
    }
  }

  const d = resolved.dispatchInputs
  emitOutputs({
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
  })
}

// Only run when invoked directly (npx tsx), not when imported for its
// helper functions in tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: 'autochain_inputs_error', error: String(err) }))
    process.exit(1)
  })
}
