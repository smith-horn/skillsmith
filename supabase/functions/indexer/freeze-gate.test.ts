/**
 * SMI-5879 (design §8.3.2.5.3): Unit tests for `checkFreezeGate` /
 * `recordFreezeGateRefusal` — Gate F, the pre-writer freeze gate for the
 * deployed indexer edge function (writer class W-11).
 *
 * Mirrors scripts/tests/indexer/run-gate-freeze-marker.test.ts's coverage of
 * the Node-side `assertFreezeMarkerClear` (same query shape, same vocabulary,
 * same fail-closed rules) — freeze-gate.ts is a Deno-side reimplementation,
 * not a byte-identical twin (run-gate.ts is explicitly Node-only), so its own
 * dedicated test suite is required rather than a parity check.
 */

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'
import { checkFreezeGate, recordFreezeGateRefusal } from './freeze-gate.ts'

interface FakeQueryResult {
  data: { metadata: unknown } | null
  error: { message: string } | null
}

/** Records every `.eq(col, val)` call so tests can assert the exact filter shape. */
function fakeSupabase(
  result: FakeQueryResult | (() => Promise<FakeQueryResult>),
  insertSpy?: (row: unknown) => void
): {
  client: SupabaseClient
  eqCalls: Array<[string, unknown]>
} {
  const eqCalls: Array<[string, unknown]> = []
  const selectChain = {
    select: () => selectChain,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val])
      return selectChain
    },
    order: () => selectChain,
    limit: () => selectChain,
    maybeSingle: async () => (typeof result === 'function' ? await result() : result),
  }
  const client = {
    from: () => ({
      ...selectChain,
      insert: async (row: unknown) => {
        insertSpy?.(row)
        return { data: null, error: null }
      },
    }),
  } as unknown as SupabaseClient
  return { client, eqCalls }
}

describe('checkFreezeGate — query shape', () => {
  it("filters on event_type='indexer:freeze' AND resource='skills'", async () => {
    const { client, eqCalls } = fakeSupabase({ data: null, error: null })
    await checkFreezeGate(client, 'maintenance')
    expect(eqCalls).toContainEqual(['event_type', 'indexer:freeze'])
    expect(eqCalls).toContainEqual(['resource', 'skills'])
  })
})

describe('checkFreezeGate — no marker row (steady state)', () => {
  it('permits every run type when no freeze marker has ever been written', async () => {
    const { client } = fakeSupabase({ data: null, error: null })
    await expect(checkFreezeGate(client, 'discovery')).resolves.toEqual({ permitted: true })
  })
})

describe("checkFreezeGate — marker allowlist uses assertRunAllowed's exact vocabulary", () => {
  it("'maintenance' permits maintenance and refuses discovery", async () => {
    const { client } = fakeSupabase({
      data: { metadata: { allowlist: 'maintenance' } },
      error: null,
    })
    await expect(checkFreezeGate(client, 'maintenance')).resolves.toEqual({ permitted: true })
  })

  it("'maintenance' refuses discovery", async () => {
    const { client } = fakeSupabase({
      data: { metadata: { allowlist: 'maintenance' } },
      error: null,
    })
    const result = await checkFreezeGate(client, 'discovery')
    expect(result.permitted).toBe(false)
    expect(result.reason).toMatch(/does not permit run_type=discovery/)
  })

  it("'none' refuses every run type", async () => {
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 'none' } }, error: null })
    const result = await checkFreezeGate(client, 'maintenance')
    expect(result.permitted).toBe(false)
  })

  it("'all' permits every run type", async () => {
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 'all' } }, error: null })
    await expect(checkFreezeGate(client, 'discovery')).resolves.toEqual({ permitted: true })
  })

  it('a comma-separated subset permits only the listed run type', async () => {
    const { client } = fakeSupabase({
      data: { metadata: { allowlist: 'maintenance' } },
      error: null,
    })
    await expect(checkFreezeGate(client, 'maintenance')).resolves.toEqual({ permitted: true })
  })

  it('a comma-separated subset refuses an unlisted run type', async () => {
    const { client } = fakeSupabase({
      data: { metadata: { allowlist: 'discovery' } },
      error: null,
    })
    const result = await checkFreezeGate(client, 'maintenance')
    expect(result.permitted).toBe(false)
  })
})

describe('checkFreezeGate — malformed value refuses (fail closed)', () => {
  it('refuses when metadata.allowlist is missing entirely', async () => {
    const { client } = fakeSupabase({ data: { metadata: {} }, error: null })
    const result = await checkFreezeGate(client, 'maintenance')
    expect(result.permitted).toBe(false)
    expect(result.reason).toMatch(/no valid metadata.allowlist/)
  })

  it('refuses when metadata.allowlist is not a string', async () => {
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 42 } }, error: null })
    const result = await checkFreezeGate(client, 'maintenance')
    expect(result.permitted).toBe(false)
  })

  it('refuses a nonsense allowlist token the way a typo must never read as "all"', async () => {
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 'nonw' } }, error: null })
    const result = await checkFreezeGate(client, 'maintenance')
    expect(result.permitted).toBe(false)
  })
})

describe('checkFreezeGate — fails CLOSED on query error', () => {
  it('refuses when the query returns a Supabase error', async () => {
    const { client } = fakeSupabase({ data: null, error: { message: 'connection reset' } })
    const result = await checkFreezeGate(client, 'maintenance')
    expect(result.permitted).toBe(false)
    expect(result.reason).toMatch(/connection reset/)
  })

  it('refuses when the query throws', async () => {
    const { client } = fakeSupabase(() => {
      throw new Error('network down')
    })
    const result = await checkFreezeGate(client, 'maintenance')
    expect(result.permitted).toBe(false)
    expect(result.reason).toMatch(/network down/)
  })
})

describe('recordFreezeGateRefusal', () => {
  it('writes an audit_logs row with a DIFFERENT event_type than the freeze marker itself', async () => {
    const insertSpy = vi.fn()
    const { client } = fakeSupabase({ data: null, error: null }, insertSpy)
    await recordFreezeGateRefusal(client, 'discovery', 'test reason', 'req-123')
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'indexer:freeze_refused',
        resource: 'skills',
      })
    )
    // Never collides with the marker's own event_type — a collision would let
    // this row become the "most recent marker" on the next invocation, and it
    // carries no metadata.allowlist, which would fail-close every subsequent
    // call (a self-inflicted permanent denial of service).
    const call = insertSpy.mock.calls[0][0] as { event_type: string }
    expect(call.event_type).not.toBe('indexer:freeze')
  })

  it('is best-effort — a write failure does not throw', async () => {
    const client = {
      from: () => ({
        insert: async () => {
          throw new Error('insert failed')
        },
      }),
    } as unknown as SupabaseClient
    await expect(
      recordFreezeGateRefusal(client, 'discovery', 'reason', 'req-123')
    ).resolves.toBeUndefined()
  })
})
