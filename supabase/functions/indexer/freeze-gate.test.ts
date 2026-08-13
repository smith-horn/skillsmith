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
import {
  checkFreezeGate,
  recordFreezeGateRefusal,
  parseIndexerFunctionRunType,
  recordInvalidRunTypeRejection,
  INDEXER_FUNCTION_RUN_TYPES,
} from './freeze-gate.ts'

interface FakeQueryResult {
  data: { metadata: unknown } | null
  error: { message: string } | null
}

/** SMI-6020: the resolved shape of a Supabase `.insert(...)` call — `{ data, error }`
 * on success OR a DB-level failure (RLS denial, constraint violation). Configurable
 * per-test via fakeSupabase's third parameter so tests can pin the resolved-error
 * path distinctly from the thrown-exception path. */
interface FakeInsertResult {
  data: null
  error: { message: string } | null
}

/** Records every `.eq(col, val)` call so tests can assert the exact filter shape. */
function fakeSupabase(
  result: FakeQueryResult | (() => Promise<FakeQueryResult>),
  insertSpy?: (row: unknown) => void,
  insertResult: FakeInsertResult = { data: null, error: null }
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
        return insertResult
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

  it('T3.4 — is best-effort — a thrown insert is still caught', async () => {
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

  it('T3.1 — a resolved insert error is logged, not silently swallowed', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { client } = fakeSupabase({ data: null, error: null }, undefined, {
      data: null,
      error: { message: 'new row violates row-level security policy' },
    })
    await recordFreezeGateRefusal(client, 'discovery', 'test reason', 'req-123')
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const loggedArgs = consoleErrorSpy.mock.calls[0].map(String).join(' ')
    expect(loggedArgs).toContain('row-level security')
    consoleErrorSpy.mockRestore()
  })

  it('T3.2 — a resolved insert error still resolves to undefined (stays best-effort)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { client } = fakeSupabase({ data: null, error: null }, undefined, {
      data: null,
      error: { message: 'new row violates row-level security policy' },
    })
    await expect(
      recordFreezeGateRefusal(client, 'discovery', 'test reason', 'req-123')
    ).resolves.toBeUndefined()
    consoleErrorSpy.mockRestore()
  })

  it('T3.3 — a successful insert logs nothing', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { client } = fakeSupabase({ data: null, error: null }, undefined, {
      data: null,
      error: null,
    })
    await recordFreezeGateRefusal(client, 'discovery', 'test reason', 'req-123')
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })
})

describe('recordInvalidRunTypeRejection', () => {
  it('T1.6 — writes an audit_logs row with a distinct event_type', async () => {
    const insertSpy = vi.fn()
    const { client } = fakeSupabase({ data: null, error: null }, insertSpy)
    await recordInvalidRunTypeRejection(client, 'purge', 'req-123')
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'indexer:invalid_run_type',
        resource: 'skills',
      })
    )
    const call = insertSpy.mock.calls[0][0] as { event_type: string }
    // Must never collide with either existing event_type: the marker itself
    // (permanent-DoS hazard) or the freeze-refusal event (would pollute
    // freeze-refusal counts with what are actually client errors).
    expect(call.event_type).not.toBe('indexer:freeze')
    expect(call.event_type).not.toBe('indexer:freeze_refused')
  })

  it('T3.5 — a resolved insert error is logged, not silently swallowed', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { client } = fakeSupabase({ data: null, error: null }, undefined, {
      data: null,
      error: { message: 'new row violates row-level security policy' },
    })
    await recordInvalidRunTypeRejection(client, 'purge', 'req-123')
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const loggedArgs = consoleErrorSpy.mock.calls[0].map(String).join(' ')
    expect(loggedArgs).toContain('row-level security')
    consoleErrorSpy.mockRestore()
  })

  it('T3.5 — a resolved insert error still resolves to undefined (stays best-effort)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { client } = fakeSupabase({ data: null, error: null }, undefined, {
      data: null,
      error: { message: 'new row violates row-level security policy' },
    })
    await expect(
      recordInvalidRunTypeRejection(client, 'purge', 'req-123')
    ).resolves.toBeUndefined()
    consoleErrorSpy.mockRestore()
  })

  it('T3.5 — a successful insert logs nothing', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { client } = fakeSupabase({ data: null, error: null }, undefined, {
      data: null,
      error: null,
    })
    await recordInvalidRunTypeRejection(client, 'purge', 'req-123')
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })
})

describe('parseIndexerFunctionRunType', () => {
  it('T1.1 — accepts exactly discovery and maintenance', () => {
    expect(parseIndexerFunctionRunType('discovery')).toEqual({ ok: true, runType: 'discovery' })
    expect(parseIndexerFunctionRunType('maintenance')).toEqual({
      ok: true,
      runType: 'maintenance',
    })
    // Exhaustive over this function's own vocabulary — every member parses ok.
    for (const runType of INDEXER_FUNCTION_RUN_TYPES) {
      expect(parseIndexerFunctionRunType(runType)).toEqual({ ok: true, runType })
    }
  })

  it('T1.2 — absent runType defaults to discovery', () => {
    expect(parseIndexerFunctionRunType(undefined)).toEqual({ ok: true, runType: 'discovery' })
    expect(parseIndexerFunctionRunType(null)).toEqual({ ok: true, runType: 'discovery' })
  })

  it('T1.3 — the purge exploit token is rejected, not gate-evaluated', () => {
    // The exploit signature: a token that IS in Gate F's broader
    // GATED_RUN_TYPES vocabulary but is NOT one this function implements.
    // Direct regression pin for the reported SMI-6020 bypass.
    const gatedButUnimplementedTokens = ['purge', 'recheck', 'dequarantine', 'revalidate']
    for (const token of gatedButUnimplementedTokens) {
      expect(parseIndexerFunctionRunType(token)).toEqual({
        ok: false,
        received: token,
        gatedButUnimplemented: true,
      })
    }
  })

  it('T1.4 — arbitrary and non-string runType values are rejected without the gated flag', () => {
    const invalidValues: unknown[] = ['DISCOVERY', ' discovery', '', 'all', 'none', 42, true, {}, []]
    for (const value of invalidValues) {
      const result = parseIndexerFunctionRunType(value)
      expect(result.ok, `expected ok:false for ${JSON.stringify(value)}`).toBe(false)
      if (!result.ok) {
        expect(
          result.gatedButUnimplemented,
          `expected gatedButUnimplemented:false for ${JSON.stringify(value)}`
        ).toBe(false)
      }
    }
  })

  it('T1.5 — received is sanitized and length-capped', () => {
    const malicious = 'a\n\x00' + 'x'.repeat(500)
    const result = parseIndexerFunctionRunType(malicious)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x1f\x7f]/.test(result.received)).toBe(false)
      expect(result.received.length).toBeLessThanOrEqual(80)
    }
  })
})
