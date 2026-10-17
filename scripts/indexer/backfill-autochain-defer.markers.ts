/**
 * SMI-7121: deferral-marker primitives for the backfill autochain
 * @module scripts/indexer/backfill-autochain-defer.markers
 *
 * Types, per-project clients, the marker insert, the live-marker read and the single
 * transition call (the SQL function backfill_autochain_marker_transition, migration
 * 20261016000000). Fail closed: a missing credential, a read error, a malformed row or an
 * unexpected RPC result THROWS. The decisions built on these (schedule target, claim,
 * reconcile) and the CLI live in backfill-autochain-defer.ts.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const MARKER_EVENT = 'indexer_backfill_autochain_deferred'
export const TRANSITION_RPC = 'backfill_autochain_marker_transition'
/** More markers than this in one project is not a state this design can produce. */
const MARKER_READ_LIMIT = 100

export type SupabaseEnv = 'prod' | 'staging'
export const ENVS: readonly SupabaseEnv[] = ['prod', 'staging']
export type MarkerState = 'open' | 'consumed' | 'dispatched' | 'needs_intervention'
export type ClientsByEnv = Record<SupabaseEnv, SupabaseClient>

export interface LiveMarker {
  env: SupabaseEnv
  id: string
  createdAt: string
  state: 'open' | 'consumed'
  metadata: Record<string, unknown>
}

/** Fields of a new marker (plan D5). `state` is always `open`. */
export interface DeferredMarkerInput {
  completed_run_id: string
  completed_run_attempt: number
  supabase_env: SupabaseEnv
  path_prefix: string
  dry_run: boolean
  deferred_at: string
  next_window_utc: string
  deferred_by_autochain_run: string
  /**
   * Halts the operator acknowledged on the deferred manual dispatch, as the canonical comma
   * list (canonicalAcknowledgedHalts); absent when none, so a resume re-applies them.
   */
  acknowledged_halts?: string
}

export class MissingCredentials extends Error {
  constructor(public readonly supabaseEnv: SupabaseEnv) {
    super(`Missing Supabase credentials for env=${supabaseEnv}; refusing to read or write markers`)
    this.name = 'MissingCredentials'
  }
}

export class MultipleOpenMarkers extends Error {
  constructor(public readonly markers: LiveMarker[]) {
    super(
      `${markers.length} open deferral markers exist (${markers.map((m) => `${m.env}:${m.id}`).join(', ')}); the one-dispatcher invariant allows at most one live chain, so none is resumed`
    )
    this.name = 'MultipleOpenMarkers'
  }
}

export const DIGITS = /^[0-9]+$/

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A run id as stored in marker metadata: digits only (string or safe integer). */
export function runIdOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v)
  if (typeof v === 'string' && DIGITS.test(v)) return v
  return null
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
}

/** One client per project, each from that project's own credentials. Missing either throws. */
export function clientsFromEnv(
  penv: NodeJS.ProcessEnv = process.env,
  makeClient: (url: string, key: string) => SupabaseClient = defaultMakeClient
): ClientsByEnv {
  return {
    prod: clientFor('prod', penv, makeClient),
    staging: clientFor('staging', penv, makeClient),
  }
}

export function clientFor(
  env: SupabaseEnv,
  penv: NodeJS.ProcessEnv = process.env,
  makeClient: (url: string, key: string) => SupabaseClient = defaultMakeClient
): SupabaseClient {
  const url = env === 'prod' ? penv.SUPABASE_URL : penv.SUPABASE_URL_STAGING
  const key =
    env === 'prod' ? penv.SUPABASE_SERVICE_ROLE_KEY : penv.SUPABASE_SERVICE_ROLE_KEY_STAGING
  if (!url || !key) throw new MissingCredentials(env)
  return makeClient(url, key)
}

function defaultMakeClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

/** Insert one open marker. Returns its id. Any error throws. */
export async function insertDeferred(
  client: SupabaseClient,
  m: DeferredMarkerInput
): Promise<string> {
  const { data, error } = await client
    .from('audit_logs')
    .insert({
      event_type: MARKER_EVENT,
      actor: 'system',
      action: 'backfill_autochain_deferred',
      resource: m.completed_run_id,
      metadata: { ...m, state: 'open' },
    })
    .select('id')
    .single()
  if (error) throw new Error(`Deferral marker insert failed: ${error.message}`)
  const id = isRecord(data) ? data.id : undefined
  if (typeof id !== 'string' || id === '') {
    throw new Error('Deferral marker insert returned no id')
  }
  return id
}

/** Live markers in one project: `open`, or `consumed` with no (or an empty) dispatched_run_id. */
async function listLiveIn(client: SupabaseClient, env: SupabaseEnv): Promise<LiveMarker[]> {
  const { data, error } = await client
    .from('audit_logs')
    .select('id, created_at, metadata')
    .eq('event_type', MARKER_EVENT)
    .in('metadata->>state', ['open', 'consumed'])
    .order('created_at', { ascending: true })
    .limit(MARKER_READ_LIMIT)
  if (error) throw new Error(`Marker read failed for env=${env}: ${error.message}`)
  if (!Array.isArray(data)) throw new Error(`Marker read for env=${env} returned no rows array`)
  if (data.length >= MARKER_READ_LIMIT) {
    throw new Error(
      `Marker read for env=${env} hit its ${MARKER_READ_LIMIT}-row limit; cannot prove the set is complete`
    )
  }
  const live: LiveMarker[] = []
  for (const row of data as unknown[]) {
    if (!isRecord(row) || typeof row.id !== 'string' || !isRecord(row.metadata)) {
      throw new Error(`Malformed marker row in env=${env}: ${JSON.stringify(row)}`)
    }
    const state = row.metadata.state
    if (state === 'open' || (state === 'consumed' && isEmpty(row.metadata.dispatched_run_id))) {
      live.push({
        env,
        id: row.id,
        createdAt: String(row.created_at ?? ''),
        state,
        metadata: row.metadata,
      })
    }
  }
  return live
}

/** Live markers across both projects, each tagged with the project it lives in. */
export async function listLiveMarkers(clientsByEnv: ClientsByEnv): Promise<LiveMarker[]> {
  const all: LiveMarker[] = []
  for (const env of ENVS) all.push(...(await listLiveIn(clientsByEnv[env], env)))
  return all
}

/** One conditional state change through the SQL function. Returns whether a row matched. */
export async function transition(
  client: SupabaseClient,
  id: string,
  from: MarkerState,
  to: MarkerState,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await client.rpc(TRANSITION_RPC, {
    p_id: id,
    p_from: from,
    p_to: to,
    p_patch: patch,
  })
  if (error) throw new Error(`${TRANSITION_RPC}(${id}, ${from} -> ${to}) failed: ${error.message}`)
  if (typeof data !== 'boolean') {
    throw new Error(
      `${TRANSITION_RPC}(${id}, ${from} -> ${to}) returned ${JSON.stringify(data)}, not a boolean`
    )
  }
  return data
}
