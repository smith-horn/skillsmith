/**
 * SMI-7121: an in-memory Supabase project for the deferral-marker tests. It keeps marker rows
 * and implements backfill_autochain_marker_transition's contract (allowed pairs, conditional
 * on the current state, patch merged with state last). Not a `*.test.ts` file, so vitest does
 * not collect it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { MARKER_EVENT, type ClientsByEnv } from '../../indexer/backfill-autochain-defer.ts'

export interface Row {
  id: string
  created_at: string
  event_type: string
  metadata: Record<string, unknown>
}

const ALLOWED = new Set([
  'open>consumed',
  'open>needs_intervention',
  'consumed>dispatched',
  'consumed>needs_intervention',
])

export function fakeProject(
  rows: Row[],
  fail: { read?: string; rpc?: string; insert?: string; rpcData?: unknown } = {}
) {
  const calls = {
    inserts: [] as unknown[],
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    filters: [] as unknown[][],
  }
  const query = () => {
    const filters: unknown[][] = []
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push(['eq', c, v]), b),
      in: (c: string, v: unknown) => (filters.push(['in', c, v]), b),
      order: () => b,
      limit: (n: number) => (filters.push(['limit', n]), b),
      then: (resolve: (v: unknown) => void) => {
        calls.filters.push(filters)
        if (fail.read) return resolve({ data: null, error: { message: fail.read } })
        const eventType = filters.find((f) => f[0] === 'eq' && f[1] === 'event_type')?.[2]
        const states = filters.find((f) => f[0] === 'in' && f[1] === 'metadata->>state')?.[2] as
          | string[]
          | undefined
        const data = rows
          .filter(
            (r) =>
              r.event_type === eventType && (!states || states.includes(String(r.metadata.state)))
          )
          .map((r) => ({ id: r.id, created_at: r.created_at, metadata: { ...r.metadata } }))
        resolve({ data, error: null })
      },
    }
    return b
  }
  const client = {
    from: (table: string) => {
      if (table !== 'audit_logs') throw new Error(`unexpected table ${table}`)
      const b = query()
      return Object.assign(b, {
        insert: (row: Row & { metadata: Record<string, unknown> }) => {
          calls.inserts.push(row)
          return {
            select: () => ({
              single: async () => {
                if (fail.insert) return { data: null, error: { message: fail.insert } }
                const id = `m${rows.length + 1}`
                rows.push({ ...row, id, created_at: new Date().toISOString() })
                return { data: { id }, error: null }
              },
            }),
          }
        },
      })
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.rpc.push({ name, args })
      if (fail.rpc) return { data: null, error: { message: fail.rpc } }
      if ('rpcData' in fail) return { data: fail.rpcData, error: null }
      const { p_id, p_from, p_to, p_patch } = args as {
        p_id: string
        p_from: string
        p_to: string
        p_patch: Record<string, unknown>
      }
      if (!ALLOWED.has(`${p_from}>${p_to}`))
        return { data: null, error: { message: `transition ${p_from} -> ${p_to} is not allowed` } }
      const row = rows.find(
        (r) => r.id === p_id && r.event_type === MARKER_EVENT && r.metadata.state === p_from
      )
      if (!row) return { data: false, error: null }
      row.metadata = { ...row.metadata, ...p_patch, state: p_to }
      return { data: true, error: null }
    },
  }
  return { client: client as unknown as SupabaseClient, rows, calls }
}

export const NOW = new Date('2026-10-16T12:00:00Z')
export const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString()

export function marker(
  id: string,
  metadata: Record<string, unknown>,
  created = minutesAgo(60)
): Row {
  return {
    id,
    created_at: created,
    event_type: MARKER_EVENT,
    metadata: {
      completed_run_id: '900',
      completed_run_attempt: 1,
      supabase_env: 'prod',
      ...metadata,
    },
  }
}

export function projects(prod: Row[], staging: Row[] = []) {
  const p = fakeProject(prod)
  const s = fakeProject(staging)
  return { p, s, clients: { prod: p.client, staging: s.client } as ClientsByEnv }
}
