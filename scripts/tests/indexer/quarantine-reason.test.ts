/**
 * quarantineSkillsBatch quarantine_reason threading test (SMI-4431)
 * @module scripts/tests/indexer/quarantine-reason
 *
 * Pins the SMI-4431 prevention fix: the batch quarantine helper must record
 * the `reason` it was passed on the `quarantine_reason` column via BOTH
 * paths it can take —
 *
 *  1. RPC path: `quarantine_stale_skills` sets `quarantine_reason = 'stale'`
 *     server-side (migration 088). The helper passes the same `reason` value
 *     ('stale') at the call site so the Node-side intent matches the RPC.
 *  2. Fallback path (PGRST202 / 42883 — RPC not yet deployed): the helper
 *     does a direct `.update()` and MUST include `quarantine_reason` itself,
 *     since no RPC runs.
 *
 * Regression context: migration 046 created `quarantine_stale_skills` to set
 * `quarantined=TRUE` + append a 'stale' finding but never set
 * `quarantine_reason`, so every stale-quarantined skill landed with an empty
 * `quarantine_reason` (audit-trail gap). The Node helper had no `reason`
 * parameter at all. Data restoration of pre-existing rows is the separate
 * SMI-4940.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { quarantineSkillsBatch, FINDING_STALE } from '../../indexer/_shared/quarantine.ts'

/** Captures the args passed to `supabase.rpc()`. */
interface RpcCall {
  fn: string
  args: Record<string, unknown>
}

/** Captures the payload passed to a `skills` table `.update()`. */
interface UpdateCall {
  payload: Record<string, unknown>
  id: string
}

/**
 * Build a minimal Supabase client double.
 *
 * @param rpcError - when set, `rpc()` resolves with this error so the helper
 *   takes the fallback path; when null, `rpc()` succeeds.
 */
function makeSupabaseStub(rpcError: { code: string } | null) {
  const rpcCalls: RpcCall[] = []
  const updateCalls: UpdateCall[] = []
  // Rows the fallback "read existing findings" select returns.
  const existingRows = [{ id: 'a/skill-1', security_findings: [] }]

  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args })
      return Promise.resolve(
        rpcError ? { data: null, error: rpcError } : { data: existingRows.length, error: null }
      )
    },
    from() {
      return {
        // Fallback "read existing findings" select chain:
        // .select(...).in(...).eq(...) → resolves to the rows.
        select() {
          return {
            in() {
              return {
                eq() {
                  return Promise.resolve({ data: existingRows, error: null })
                },
              }
            },
          }
        },
        // Fallback direct update chain: .update(payload).eq('id', id)
        update(payload: Record<string, unknown>) {
          return {
            eq(...args: [string, string]) {
              updateCalls.push({ payload, id: args[1] })
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
  }

  return { client: client as unknown as SupabaseClient, rpcCalls, updateCalls }
}

describe('quarantineSkillsBatch — quarantine_reason threading (SMI-4431)', () => {
  it('passes the reason through on the RPC-success path', async () => {
    const { client, rpcCalls, updateCalls } = makeSupabaseStub(null)

    const result = await quarantineSkillsBatch(client, ['a/skill-1'], FINDING_STALE, 'stale')

    // RPC path taken — exactly one rpc() call, no fallback updates.
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('quarantine_stale_skills')
    expect(updateCalls).toHaveLength(0)
    // The RPC sets quarantine_reason='stale' server-side; the helper's
    // call site passes the matching reason value.
    expect(result.quarantined).toBe(1)
    expect(result.errors).toBe(0)
  })

  it('sets quarantine_reason on the fallback direct update (PGRST202)', async () => {
    const { client, updateCalls } = makeSupabaseStub({ code: 'PGRST202' })

    const result = await quarantineSkillsBatch(client, ['a/skill-1'], FINDING_STALE, 'stale')

    // Fallback path taken — one direct update carrying quarantine_reason.
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].payload.quarantined).toBe(true)
    expect(updateCalls[0].payload.quarantine_reason).toBe('stale')
    expect(updateCalls[0].payload.security_findings).toEqual([FINDING_STALE])
    expect(result.quarantined).toBe(1)
    expect(result.errors).toBe(0)
  })

  it('sets quarantine_reason on the fallback direct update (42883)', async () => {
    const { client, updateCalls } = makeSupabaseStub({ code: '42883' })

    await quarantineSkillsBatch(client, ['a/skill-1'], FINDING_STALE, 'stale')

    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].payload.quarantine_reason).toBe('stale')
  })

  it('threads a non-default reason verbatim into the fallback update', async () => {
    const { client, updateCalls } = makeSupabaseStub({ code: 'PGRST202' })

    await quarantineSkillsBatch(client, ['a/skill-1'], FINDING_STALE, 'repo_deleted')

    expect(updateCalls[0].payload.quarantine_reason).toBe('repo_deleted')
  })
})
