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

interface ResolvedDispatch {
  supabaseEnv: 'prod' | 'staging'
  resumeFrom: string
  dryRun: boolean
  dispatchInputs: NonNullable<BackfillCheckpointPayload['dispatch_inputs']>
  cursorDone: boolean
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
    }
  }

  // No checkpoint of its own — query the skip-branch's audit row, keyed by
  // the new github_run_id field (request_id is a fresh UUID per invocation
  // and cannot be correlated to a GitHub Actions run id at all).
  const { data, error } = await supabase
    .from('audit_logs')
    .select('metadata')
    .eq('event_type', 'indexer:run')
    .eq('metadata->>github_run_id', completedRunId)
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
  for (const project of projects) {
    if (!project.url || !project.key) continue
    const client = createClient(project.url, project.key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    resolved = await resolveForProject(client, completedRunId, project.env)
    if (resolved) break
  }

  if (!resolved) {
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
