/**
 * telemetry.test.ts
 *
 * SMI-5540: Route-level test for the server-side "verified email required to
 * enable audit_email_enabled" guard in the PUT /api/account/telemetry
 * handler. The guard lives inline in `telemetry.ts` (not extracted to a pure
 * helper), so it can only be exercised by driving the actual route handler
 * end-to-end with a mocked Supabase client.
 *
 * `@supabase/supabase-js` is mocked so both call sites the route makes
 * against `createClient` resolve without touching a live project:
 *   - `resolveUser` calls `client.auth.getUser(token)`.
 *   - `userScopedClient` calls `client.from(...).select(...).eq(...).maybeSingle()`
 *     (existing-row read) and `client.from(...).upsert(...).select(...).single()`
 *     (the write).
 *
 * `telemetry.ts` reads `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` from
 * `import.meta.env` once, at module load time — so the env must be stubbed
 * non-empty BEFORE the module is imported. This file stubs the env in
 * `beforeAll` and only then dynamically imports the route, so the module's
 * module-scope constants capture the stubbed values instead of the real
 * (empty, in test) env — otherwise `resolveUser`/`userScopedClient` would
 * short-circuit to null and every request would 401/503 instead of reaching
 * the guard under test.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { APIRoute } from 'astro'

interface MockUser {
  id: string
  email_confirmed_at: string | null
}

// vi.hoisted so the vi.mock factory below (itself hoisted above these
// imports by Vitest) can close over mutable state without a
// "Cannot access before initialization" error.
const state = vi.hoisted(() => ({
  getUserResult: {
    data: { user: null as MockUser | null },
    error: null as { message: string } | null,
  },
  selectResult: {
    data: null as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  upsertResult: {
    data: null as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
}))

// SMI-6362 §3a: captures the exact row the route passes to .upsert(...) so
// tests can assert on consent_decided_at without re-deriving it from the
// mocked select/upsert echo fixtures.
const upsertCalls: Array<Record<string, unknown>> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async (_token: string) => state.getUserResult),
    },
    from: vi.fn((_table: string) => ({
      select: vi.fn((_columns: string) => ({
        eq: vi.fn((_column: string, _value: string) => ({
          maybeSingle: vi.fn(async () => state.selectResult),
        })),
      })),
      upsert: vi.fn((row: Record<string, unknown>, _options: unknown) => {
        upsertCalls.push(row)
        return {
          select: vi.fn((_columns: string) => ({
            single: vi.fn(async () => state.upsertResult),
          })),
        }
      }),
    })),
  })),
}))

const TEST_USER_ID = 'user-123'

let PUT: APIRoute

beforeAll(async () => {
  vi.stubEnv('PUBLIC_SUPABASE_URL', 'https://test-project.supabase.co')
  vi.stubEnv('PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  // Dynamic import AFTER stubbing env: telemetry.ts captures
  // import.meta.env.PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY into
  // module-scope consts at load time, so the stub must land first.
  const routeModule = await import('../../../src/pages/api/account/telemetry')
  PUT = routeModule.PUT
})

afterEach(() => {
  vi.clearAllMocks()
  upsertCalls.length = 0
})

function putRequest(body: Record<string, unknown>): Request {
  return new Request('https://example.test/api/account/telemetry', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function callPut(body: Record<string, unknown>): ReturnType<APIRoute> {
  return PUT({ request: putRequest(body) } as unknown as Parameters<APIRoute>[0])
}

function setUser(emailConfirmedAt: string | null): void {
  state.getUserResult = {
    data: { user: { id: TEST_USER_ID, email_confirmed_at: emailConfirmedAt } },
    error: null,
  }
}

function setExistingRow(row: Record<string, unknown> | null): void {
  state.selectResult = {
    data:
      row === null
        ? null
        : {
            anonymous_id: null,
            anonymous_id_created_at: null,
            inventory_sync_enabled: false,
            audit_email_enabled: false,
            ...row,
          },
    error: null,
  }
}

/**
 * SMI-6362 §1 confirmation round (NEEDLE finding 2): simulates the
 * read-before-write SELECT failing (transient DB error). The route must
 * fail closed (500) rather than silently treating `existing` as absent,
 * which would risk re-stamping an already-decided consent_decided_at.
 */
function setExistingRowError(message: string): void {
  state.selectResult = { data: null, error: { message } }
}

function setUpsertSuccess(row: Record<string, unknown>): void {
  state.upsertResult = {
    data: {
      user_id: TEST_USER_ID,
      enabled: true,
      anonymous_id: null,
      anonymous_id_created_at: null,
      updated_at: '2026-01-01T00:00:00.000Z',
      inventory_sync_enabled: false,
      audit_email_enabled: false,
      ...row,
    },
    error: null,
  }
}

describe('PUT /api/account/telemetry — audit-email verified-email guard (SMI-5540)', () => {
  beforeEach(() => {
    // Default fixtures: no existing row, a successful upsert echo. Individual
    // tests override via setExistingRow / setUpsertSuccess as needed.
    setExistingRow(null)
    setUpsertSuccess({})
  })

  it('rejects enabling audit_email_enabled when the user has not verified their email', async () => {
    setUser(null)

    const response = await callPut({ enabled: true, audit_email_enabled: true })
    const json = await response.json()

    expect(response.status).toBe(400)
    expect(json.error).toBe('email_not_verified')
  })

  it('allows enabling audit_email_enabled when the user has verified their email', async () => {
    setUser('2026-01-01T00:00:00.000Z')
    setUpsertSuccess({ audit_email_enabled: true })

    const response = await callPut({ enabled: true, audit_email_enabled: true })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.preference.audit_email_enabled).toBe(true)
  })

  it('allows an unverified user to PUT with audit_email_enabled=false', async () => {
    setUser(null)
    setUpsertSuccess({ audit_email_enabled: false })

    const response = await callPut({ enabled: true, audit_email_enabled: false })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(json.preference.audit_email_enabled).toBe(false)
  })

  it('does not fire the gate when audit_email_enabled is omitted and the stored value is already false', async () => {
    setUser(null)
    setExistingRow({ audit_email_enabled: false })
    setUpsertSuccess({ audit_email_enabled: false })

    const response = await callPut({ enabled: true })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(json.preference.audit_email_enabled).toBe(false)
  })
})

describe('PUT /api/account/telemetry — consent_decided_at stamp (SMI-6362 §3a, rev 4 round-3 item 2)', () => {
  beforeEach(() => {
    setUser('2026-01-01T00:00:00.000Z')
    setUpsertSuccess({})
  })

  it('stamps consent_decided_at on a first-time save (no existing row)', async () => {
    setExistingRow(null)

    await callPut({ enabled: true })

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].consent_decided_at).toEqual(expect.any(String))
  })

  it('preserves the ORIGINAL consent_decided_at on a second save — never re-stamps (first-decision-wins)', async () => {
    const originalDecision = '2026-01-15T09:30:00.000Z'
    setExistingRow({ consent_decided_at: originalDecision })

    await callPut({ enabled: false })

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].consent_decided_at).toBe(originalDecision)
  })

  it('stamps consent_decided_at on an existing row that is enabled=true but was never decided — the exact production state this fix exists for', async () => {
    setExistingRow({ enabled: true, consent_decided_at: null })

    await callPut({ enabled: true })

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].consent_decided_at).toEqual(expect.any(String))
    expect(upsertCalls[0].consent_decided_at).not.toBeNull()
  })

  it('stamps consent_decided_at on an explicit opt-out (enabled=false) exactly like an opt-in — a refusal is a decision too', async () => {
    setExistingRow(null)

    await callPut({ enabled: false })

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].consent_decided_at).toEqual(expect.any(String))
  })
})

describe('PUT /api/account/telemetry — read-before-write failure fails closed (SMI-6362 §1 confirmation round)', () => {
  beforeEach(() => {
    setUser('2026-01-01T00:00:00.000Z')
    setUpsertSuccess({})
  })

  it('returns 500 when the read-before-write SELECT errors, instead of silently treating existing as absent', async () => {
    setExistingRowError('connection reset')

    const response = await callPut({ enabled: true })
    const json = await response.json()

    expect(response.status).toBe(500)
    expect(json.error).toBe('fetch_failed')
    // The upsert must never be reached — a re-stamped consent_decided_at
    // (or any other field) must not be written from a guessed "no existing
    // row" state.
    expect(upsertCalls).toHaveLength(0)
  })
})
