/**
 * SMI-7121: the backfill autochain's deferral markers (plan D5, D6)
 * @module scripts/indexer/backfill-autochain-defer
 *
 * Outside the busy-hour window a link does not dispatch: it inserts one
 * `indexer_backfill_autochain_deferred` audit_logs row (a "marker", state `open`) in the
 * project the campaign runs against. A scheduled tick of the same workflow resumes it:
 * it reconciles markers a previous tick claimed, picks the single open marker, and claims
 * it (open -> consumed) before dispatching. Every state change is one call to the SQL
 * function `backfill_autochain_marker_transition` (migration 20261016000000), which is
 * conditioned on the expected current state and merges its patch server-side.
 *
 * Fail closed throughout: a missing credential, a read error, a malformed marker or an
 * unexpected RPC result THROWS, which turns the calling workflow step red.
 *
 * The CLI (subcommand in argv[2]) writes GITHUB_OUTPUT keys; GitHub API access for
 * `reconcile` lives in backfill-autochain-defer.github.ts, and the marker primitives (types,
 * clients, insert, live read, transition) in backfill-autochain-defer.markers.ts. See
 * docs/internal/implementation/smi-7121-autochain-driver-halts.md.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { canonicalAcknowledgedHalts } from './backfill-autochain-halts.ts'
import {
  listBackfillRunsCreatedSince,
  type BackfillRunRef,
} from './backfill-autochain-defer.github.ts'
import {
  DIGITS,
  MultipleOpenMarkers,
  clientFor,
  clientsFromEnv,
  insertDeferred,
  listLiveMarkers,
  runIdOf,
  transition,
  type ClientsByEnv,
  type LiveMarker,
  type SupabaseEnv,
} from './backfill-autochain-defer.markers.ts'

export * from './backfill-autochain-defer.markers.ts'

/** A consumed marker with no matching dispatched run after this long needs a human. */
export const RECONCILE_GRACE_MS = 15 * 60 * 1000
/** The run-list scan starts this long before consumed_at (clock skew between runner and DB). */
export const RECONCILE_LOOKBACK_MS = 5 * 60 * 1000

export type ScheduleTarget =
  | { resume: false; reason: string }
  | {
      resume: true
      markerId: string
      completedRunId: string
      completedRunAttempt: string
      supabaseEnv: SupabaseEnv
      /** Canonical acknowledgement carried on the marker; '' when none. */
      acknowledgedHalts: string
    }

/** The single open marker to resume, or a no-op reason. More than one open marker throws. */
export async function scheduleTarget(clientsByEnv: ClientsByEnv): Promise<ScheduleTarget> {
  const open = (await listLiveMarkers(clientsByEnv)).filter((m) => m.state === 'open')
  if (open.length === 0)
    return { resume: false, reason: 'No open deferral marker in either project.' }
  if (open.length > 1) throw new MultipleOpenMarkers(open)
  const m = open[0]
  const runId = runIdOf(m.metadata.completed_run_id)
  const attempt = runIdOf(m.metadata.completed_run_attempt)
  if (!runId || !attempt) {
    throw new Error(
      `Open marker ${m.env}:${m.id} has a malformed completed_run_id or completed_run_attempt: ${JSON.stringify(m.metadata)}`
    )
  }
  if (m.metadata.supabase_env !== m.env) {
    throw new Error(
      `Open marker ${m.id} lives in env=${m.env} but records supabase_env=${JSON.stringify(m.metadata.supabase_env)}`
    )
  }
  // Absent, null or '' means none. Anything else is re-validated (an unknown or
  // unacknowledgeable name throws): a stored value is never trusted blindly.
  const rawAck = m.metadata.acknowledged_halts
  if (rawAck !== undefined && rawAck !== null && typeof rawAck !== 'string') {
    throw new Error(`Open marker ${m.env}:${m.id} has a non-string acknowledged_halts`)
  }
  return {
    resume: true,
    markerId: m.id,
    completedRunId: runId,
    completedRunAttempt: attempt,
    supabaseEnv: m.env,
    acknowledgedHalts: canonicalAcknowledgedHalts(rawAck ?? ''),
  }
}

/** open -> consumed, recording which autochain run claimed it. False: another tick has it. */
export async function claim(
  client: SupabaseClient,
  markerId: string,
  autochainRunId: string,
  now: Date = new Date()
): Promise<boolean> {
  return transition(client, markerId, 'open', 'consumed', {
    consumed_by_autochain_run: autochainRunId,
    consumed_at: now.toISOString(),
  })
}

/** open -> needs_intervention with a reason. False: the marker was no longer open. */
export async function markNeedsIntervention(
  client: SupabaseClient,
  markerId: string,
  reason: string,
  autochainRunId: string,
  now: Date = new Date()
): Promise<boolean> {
  return transition(client, markerId, 'open', 'needs_intervention', {
    reason,
    closed_by_autochain_run: autochainRunId,
    closed_at: now.toISOString(),
  })
}

export interface MovedMarker {
  env: SupabaseEnv
  id: string
  completed_run_id: string
  reason: string
}

export interface ReconcileResult {
  dispatched: Array<{ env: SupabaseEnv; id: string; dispatched_run_id: string }>
  needsIntervention: MovedMarker[]
  left: Array<{ env: SupabaseEnv; id: string }>
}

/** consumed_at, else created_at when it is missing, unparseable or in the future (the watcher's rule). */
function consumedAtMs(m: LiveMarker, nowMs: number): number {
  const raw = m.metadata.consumed_at
  const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN
  if (Number.isFinite(parsed) && parsed <= nowMs) return parsed
  const created = Date.parse(m.createdAt)
  if (!Number.isFinite(created))
    throw new Error(`Marker ${m.env}:${m.id} has no usable consumed_at or created_at`)
  return created
}

/**
 * For each consumed marker with no dispatched_run_id, find the backfill run its claim
 * dispatched (display_title carries `[tok=ac-<consumed_by_autochain_run>]`). Exactly one:
 * consumed -> dispatched. None after the grace period, or several: consumed ->
 * needs_intervention. None and still fresh: left alone.
 */
export async function reconcileConsumed(opts: {
  clientsByEnv: ClientsByEnv
  listRuns: (createdSinceIso: string) => Promise<BackfillRunRef[]>
  autochainRunId: string
  now?: Date
}): Promise<ReconcileResult> {
  const now = opts.now ?? new Date()
  const nowMs = now.getTime()
  const result: ReconcileResult = { dispatched: [], needsIntervention: [], left: [] }
  const consumed = (await listLiveMarkers(opts.clientsByEnv)).filter((m) => m.state === 'consumed')
  for (const m of consumed) {
    const client = opts.clientsByEnv[m.env]
    const completedRunId = String(m.metadata.completed_run_id ?? 'unknown')
    const moveToIntervention = async (reason: string) => {
      const moved = await transition(client, m.id, 'consumed', 'needs_intervention', {
        reason,
        closed_by_autochain_run: opts.autochainRunId,
        closed_at: now.toISOString(),
      })
      if (moved)
        result.needsIntervention.push({
          env: m.env,
          id: m.id,
          completed_run_id: completedRunId,
          reason,
        })
      else result.left.push({ env: m.env, id: m.id })
    }
    const claimer = runIdOf(m.metadata.consumed_by_autochain_run)
    if (!claimer) {
      await moveToIntervention(
        `consumed marker has a malformed consumed_by_autochain_run (${JSON.stringify(m.metadata.consumed_by_autochain_run ?? null)}), so its dispatch cannot be resolved`
      )
      continue
    }
    const consumedMs = consumedAtMs(m, nowMs)
    const since = new Date(consumedMs - RECONCILE_LOOKBACK_MS).toISOString()
    const token = `[tok=ac-${claimer}]`
    const matches = (await opts.listRuns(since)).filter((r) => r.display_title.includes(token))
    if (matches.length === 1) {
      const runId = String(matches[0].id)
      const moved = await transition(client, m.id, 'consumed', 'dispatched', {
        dispatched_run_id: runId,
        reconciled_by_autochain_run: opts.autochainRunId,
        reconciled_at: now.toISOString(),
      })
      if (moved) result.dispatched.push({ env: m.env, id: m.id, dispatched_run_id: runId })
      else result.left.push({ env: m.env, id: m.id })
    } else if (matches.length > 1) {
      await moveToIntervention(
        `${matches.length} indexer-backfill runs carry ${token} (${matches.map((r) => r.id).join(', ')}); a claim must dispatch at most one`
      )
    } else if (nowMs - consumedMs > RECONCILE_GRACE_MS) {
      await moveToIntervention(
        `no indexer-backfill run carries ${token} more than ${RECONCILE_GRACE_MS / 60000} minutes after the claim; the resume dispatch failed or was cancelled`
      )
    } else {
      result.left.push({ env: m.env, id: m.id })
    }
  }
  return result
}

// ---------------------------------------------------------------- CLI

/** Append outputs with a random heredoc delimiter, so no value can inject another key. */
export function formatOutputs(outputs: Record<string, string>): string {
  return Object.entries(outputs)
    .map(([k, v]) => {
      const delim = `ghadelim_${randomBytes(12).toString('hex')}`
      return `${k}<<${delim}\n${v}\n${delim}\n`
    })
    .join('')
}

function emit(outputs: Record<string, string>): void {
  const text = formatOutputs(outputs)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  else process.stdout.write(text)
}

function required(penv: NodeJS.ProcessEnv, name: string): string {
  const v = penv[name]
  if (v === undefined || v === '') throw new Error(`Missing required environment variable: ${name}`)
  return v
}

function envName(raw: string | undefined, name: string): SupabaseEnv {
  if (raw === 'prod' || raw === 'staging') return raw
  throw new Error(`${name} must be prod or staging, got ${JSON.stringify(raw ?? null)}`)
}

function digits(penv: NodeJS.ProcessEnv, name: string): string {
  const v = required(penv, name)
  if (!DIGITS.test(v) || /^0/.test(v))
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}`)
  return v
}

/** Exit code when more than one open marker exists (red, with `multiple=true` emitted first). */
export const MULTIPLE_EXIT_CODE = 2

export interface CliDeps {
  penv: NodeJS.ProcessEnv
  makeClient?: (url: string, key: string) => SupabaseClient
  listRuns?: (createdSinceIso: string) => Promise<BackfillRunRef[]>
  now?: Date
}

/** Runs one subcommand and returns its outputs. Throws on every failure. */
export async function runCommand(
  cmd: string | undefined,
  deps: CliDeps
): Promise<Record<string, string>> {
  const { penv } = deps
  const now = deps.now ?? new Date()
  const runId = () => digits(penv, 'GITHUB_RUN_ID')
  switch (cmd) {
    case 'live-check': {
      const live = await listLiveMarkers(clientsFromEnv(penv, deps.makeClient))
      return {
        live_count: String(live.length),
        live: live
          .map(
            (m) =>
              `${m.env}:${m.id} (${m.state}, run ${String(m.metadata.completed_run_id ?? 'unknown')})`
          )
          .join('; '),
      }
    }
    case 'insert': {
      const env = envName(penv.SUPABASE_ENV, 'SUPABASE_ENV')
      const dryRun = penv.DRY_RUN
      if (dryRun !== 'true' && dryRun !== 'false')
        throw new Error(`DRY_RUN must be true or false, got ${JSON.stringify(dryRun ?? null)}`)
      const next = required(penv, 'NEXT_WINDOW_UTC')
      if (Number.isNaN(Date.parse(next)))
        throw new Error(`NEXT_WINDOW_UTC is not a date: ${JSON.stringify(next)}`)
      const acked = canonicalAcknowledgedHalts(penv.ACKNOWLEDGE_HALTS)
      const id = await insertDeferred(clientFor(env, penv, deps.makeClient), {
        completed_run_id: digits(penv, 'COMPLETED_RUN_ID'),
        completed_run_attempt: Number(digits(penv, 'COMPLETED_RUN_ATTEMPT')),
        supabase_env: env,
        path_prefix: penv.PATH_PREFIX ?? '',
        dry_run: dryRun === 'true',
        deferred_at: now.toISOString(),
        next_window_utc: next,
        deferred_by_autochain_run: runId(),
        // Only a manual dispatch carries an acknowledgement (the workflow passes '' otherwise).
        ...(acked ? { acknowledged_halts: acked } : {}),
      })
      return { marker_id: id, marker_env: env }
    }
    case 'reconcile': {
      const listRuns =
        deps.listRuns ??
        ((since: string) =>
          listBackfillRunsCreatedSince({
            repo: required(penv, 'GITHUB_REPOSITORY'),
            token: required(penv, 'GH_TOKEN'),
            createdSinceIso: since,
          }))
      const r = await reconcileConsumed({
        clientsByEnv: clientsFromEnv(penv, deps.makeClient),
        listRuns,
        autochainRunId: runId(),
        now,
      })
      return {
        moved_count: String(r.needsIntervention.length),
        moved: JSON.stringify(r.needsIntervention),
        dispatched_count: String(r.dispatched.length),
        left_count: String(r.left.length),
      }
    }
    case 'schedule-target': {
      const t = await scheduleTarget(clientsFromEnv(penv, deps.makeClient))
      if (!t.resume) return { resume: 'false', reason: t.reason }
      return {
        resume: 'true',
        marker_id: t.markerId,
        completed_run_id: t.completedRunId,
        completed_run_attempt: t.completedRunAttempt,
        supabase_env: t.supabaseEnv,
        acknowledged_halts: t.acknowledgedHalts,
      }
    }
    case 'claim': {
      const env = envName(penv.MARKER_ENV, 'MARKER_ENV')
      const ok = await claim(
        clientFor(env, penv, deps.makeClient),
        required(penv, 'MARKER_ID'),
        runId(),
        now
      )
      return { claimed: String(ok) }
    }
    case 'needs-intervention': {
      const env = envName(penv.MARKER_ENV, 'MARKER_ENV')
      const ok = await markNeedsIntervention(
        clientFor(env, penv, deps.makeClient),
        required(penv, 'MARKER_ID'),
        required(penv, 'REASON'),
        runId(),
        now
      )
      return { moved: String(ok) }
    }
    default:
      throw new Error(
        `Unknown subcommand ${JSON.stringify(cmd ?? null)}; expected live-check, insert, reconcile, schedule-target, claim or needs-intervention`
      )
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  try {
    emit(await runCommand(cmd, { penv: process.env }))
  } catch (err) {
    if (err instanceof MultipleOpenMarkers) {
      emit({ multiple: 'true', message: err.message })
      console.error(`::error::${err.message}`)
      process.exit(MULTIPLE_EXIT_CODE)
    }
    throw err
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        event: 'autochain_defer_error',
        command: process.argv[2],
        error: String(err),
      })
    )
    process.exit(1)
  })
}
