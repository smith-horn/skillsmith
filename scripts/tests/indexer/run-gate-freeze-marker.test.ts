/**
 * SMI-5879 (8.3.2.5.3/8.3.3.2): Unit tests for `assertFreezeMarkerClear`, the
 * DB-sourced second layer of the shared indexer execution gate. Reads the
 * most recent `audit_logs` row with `event_type='indexer:freeze'`,
 * `resource='skills'` and applies `assertRunAllowed`'s exact vocabulary to
 * that row's `metadata.allowlist` — 'maintenance' permits maintenance and
 * refuses discovery; a malformed value refuses (fail closed); a query error
 * refuses (fail closed); no marker row at all (steady state) permits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertFreezeMarkerClear } from '../../indexer/run-gate.ts'

const BYPASS_VAR = 'SKILLSMITH_INDEXER_FREEZE_MARKER_BYPASS'
let prevBypass: string | undefined

beforeEach(() => {
  prevBypass = process.env[BYPASS_VAR]
  delete process.env[BYPASS_VAR]
})

afterEach(() => {
  if (prevBypass === undefined) delete process.env[BYPASS_VAR]
  else process.env[BYPASS_VAR] = prevBypass
})

interface FakeQueryResult {
  data: { metadata: unknown } | null
  error: { message: string } | null
}

/** Records every `.eq(col, val)` call so tests can assert the exact filter shape. */
function fakeSupabase(result: FakeQueryResult | (() => Promise<FakeQueryResult>)): {
  client: SupabaseClient
  eqCalls: Array<[string, unknown]>
} {
  const eqCalls: Array<[string, unknown]> = []
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val])
      return chain
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => (typeof result === 'function' ? await result() : result),
  }
  const client = { from: () => chain } as unknown as SupabaseClient
  return { client, eqCalls }
}

describe('assertFreezeMarkerClear — query shape', () => {
  it("filters on event_type='indexer:freeze' AND resource='skills'", async () => {
    const { client, eqCalls } = fakeSupabase({ data: null, error: null })
    await assertFreezeMarkerClear(client, 'maintenance')
    expect(eqCalls).toContainEqual(['event_type', 'indexer:freeze'])
    expect(eqCalls).toContainEqual(['resource', 'skills'])
  })
})

describe('assertFreezeMarkerClear — no marker row (steady state)', () => {
  it('permits every run type when no freeze marker has ever been written', async () => {
    const { client } = fakeSupabase({ data: null, error: null })
    await expect(assertFreezeMarkerClear(client, 'discovery')).resolves.toBeUndefined()
  })
})

describe("assertFreezeMarkerClear — marker allowlist uses assertRunAllowed's exact vocabulary", () => {
  it("'maintenance' permits maintenance and refuses discovery", async () => {
    const { client } = fakeSupabase({
      data: { metadata: { allowlist: 'maintenance' } },
      error: null,
    })
    await expect(assertFreezeMarkerClear(client, 'maintenance')).resolves.toBeUndefined()
  })

  it("'maintenance' refuses discovery", async () => {
    const { client } = fakeSupabase({
      data: { metadata: { allowlist: 'maintenance' } },
      error: null,
    })
    await expect(assertFreezeMarkerClear(client, 'discovery')).rejects.toThrow()
  })

  it("'none' refuses every run type", async () => {
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 'none' } }, error: null })
    await expect(assertFreezeMarkerClear(client, 'purge')).rejects.toThrow()
  })

  it("'all' permits every run type", async () => {
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 'all' } }, error: null })
    await expect(assertFreezeMarkerClear(client, 'revalidate')).resolves.toBeUndefined()
  })

  it('a comma-separated subset permits only the listed run types', async () => {
    const { client } = fakeSupabase({
      data: { metadata: { allowlist: 'recheck,revalidate' } },
      error: null,
    })
    await expect(assertFreezeMarkerClear(client, 'recheck')).resolves.toBeUndefined()
    await expect(assertFreezeMarkerClear(client, 'revalidate')).resolves.toBeUndefined()
  })

  it('a comma-separated subset refuses an unlisted run type', async () => {
    const { client } = fakeSupabase({
      data: { metadata: { allowlist: 'recheck,revalidate' } },
      error: null,
    })
    await expect(assertFreezeMarkerClear(client, 'discovery')).rejects.toThrow()
  })
})

describe('assertFreezeMarkerClear — malformed value refuses (fail closed)', () => {
  it('refuses when metadata.allowlist is missing entirely', async () => {
    const { client } = fakeSupabase({ data: { metadata: {} }, error: null })
    await expect(assertFreezeMarkerClear(client, 'maintenance')).rejects.toThrow()
  })

  it('refuses when metadata.allowlist is not a string', async () => {
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 42 } }, error: null })
    await expect(assertFreezeMarkerClear(client, 'maintenance')).rejects.toThrow()
  })

  it('refuses a nonsense allowlist token the way a typo must never read as "all"', async () => {
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 'nonw' } }, error: null })
    await expect(assertFreezeMarkerClear(client, 'maintenance')).rejects.toThrow()
  })
})

describe('assertFreezeMarkerClear — fails CLOSED on query error', () => {
  it('refuses when the query returns a Supabase error', async () => {
    const { client } = fakeSupabase({ data: null, error: { message: 'connection reset' } })
    await expect(assertFreezeMarkerClear(client, 'maintenance')).rejects.toThrow(/connection reset/)
  })

  it('refuses when the query throws', async () => {
    const { client } = fakeSupabase(() => {
      throw new Error('network down')
    })
    await expect(assertFreezeMarkerClear(client, 'maintenance')).rejects.toThrow(/network down/)
  })
})

describe('assertFreezeMarkerClear — documented bypass', () => {
  it('skips the DB read entirely when SKILLSMITH_INDEXER_FREEZE_MARKER_BYPASS=1', async () => {
    process.env[BYPASS_VAR] = '1'
    // A client that would throw if ever queried — proves the bypass short-circuits
    // before any `.from()` call.
    const client = {
      from: () => {
        throw new Error('must not query when bypassed')
      },
    } as unknown as SupabaseClient
    await expect(assertFreezeMarkerClear(client, 'discovery')).resolves.toBeUndefined()
  })

  it('does not bypass on any value other than the literal "1"', async () => {
    process.env[BYPASS_VAR] = 'true'
    const { client } = fakeSupabase({ data: { metadata: { allowlist: 'none' } }, error: null })
    await expect(assertFreezeMarkerClear(client, 'discovery')).rejects.toThrow()
  })
})
