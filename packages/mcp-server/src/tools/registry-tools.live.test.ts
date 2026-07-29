/**
 * @fileoverview Live-mode tests for private_registry_publish + private_registry_manage
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 *
 * Exercises the live Supabase-backed service (registry-tools.live.ts) by mocking
 * `getSupabaseAdminClient` with a recording fake client. Focus areas (the exact
 * bug classes plan-review flagged for the notification layer, hardened here since
 * Wave 2 builds on this table):
 *   - every operation is scoped to the license-resolved team_id (a caller can never
 *     target another team — the service-layer half of cross-tenant isolation; the
 *     DB/RLS half is asserted in scripts/tests/private-registry-rls.test.ts);
 *   - published (team_id, skill_id, version) triples are immutable (clean error, no
 *     silent upsert);
 *   - content over 2 MB and content missing SKILL.md are rejected before insert;
 *   - a missing service-role key surfaces as a typed error, not a raw 42501.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sha256Hex } from '@skillsmith/core'
import type { ToolContext } from '../context.js'

import {
  executePrivateRegistryPublish,
  executePrivateRegistryManage,
  setPrivateRegistryService,
  createStubRegistryService,
} from './registry-tools.js'
import { createLiveRegistryService } from './registry-tools.live.js'

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
  resolveUserAccessToken: vi.fn(async () => 'fake-user-access-token'),
}))

const RESOLVED_TEAM = 'team-alpha'
const SAMPLE_CONTENT = { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' }

// ============================================================================
// Fake Supabase client (recorder + scripted responses)
// ============================================================================

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  filters: Array<{ column: string; value: unknown }>
  payload?: Record<string, unknown>
  selectCalled: boolean
}

type SingleResponder = () => { data: unknown; error: { code?: string; message?: string } | null }
type ThenResponder = () => { data: unknown[] | null; error: { message?: string } | null }

interface FakeClientOptions {
  singleResponder?: SingleResponder
  thenResponder?: ThenResponder
}

function createFakeClient(opts: FakeClientOptions = {}): { client: unknown; calls: Recorded[] } {
  const calls: Recorded[] = []

  function makeQuery(table: string) {
    const record: Recorded = { table, op: 'select', filters: [], selectCalled: false }
    calls.push(record)
    const chain: Record<string, unknown> = {
      select: (_columns?: string) => {
        record.selectCalled = true
        return chain
      },
      eq: (column: string, value: unknown) => {
        record.filters.push({ column, value })
        return chain
      },
      insert: (row: Record<string, unknown>) => {
        record.op = 'insert'
        record.payload = row
        return chain
      },
      update: (row: Record<string, unknown>) => {
        record.op = 'update'
        record.payload = row
        return chain
      },
      single: async () => opts.singleResponder?.() ?? { data: null, error: null },
      then: (onFulfilled: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
        // Mirrors real PostgREST: insert/update only return row data (`data`) when
        // .select() was chained (sets `Prefer: return=representation`) — without it,
        // `data` is null even on a successful mutation. A fake that always returns
        // the scripted response regardless of whether .select() was called would not
        // have caught the real bug this guards against (deprecate/undeprecate
        // originally omitted .select() and so always reported "not found").
        if ((record.op === 'update' || record.op === 'insert') && !record.selectCalled) {
          return Promise.resolve(onFulfilled({ data: null, error: null }))
        }
        const resp = opts.thenResponder?.() ?? { data: [], error: null }
        return Promise.resolve(onFulfilled(resp))
      },
    }
    return chain
  }

  return { client: { from: (table: string) => makeQuery(table) }, calls }
}

function makeContext(): ToolContext {
  return {} as unknown as ToolContext
}

/**
 * Point both client factories at one recorder.
 *
 * Since SMI-5822, deprecate/undeprecate run through the signed-in user's client while the
 * audit write still uses the service-role client, so a test touching those paths needs both.
 */
async function mockBothClients(client: unknown): Promise<void> {
  const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
  vi.mocked(getSupabaseUserClient).mockResolvedValue(client)
}

function publishedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    team_id: RESOLVED_TEAM,
    skill_id: 'myteam/skill-a',
    version: '1.0.0',
    description: null,
    content_hash: 'hash',
    deprecated: false,
    published_by: null,
    published_at: '2026-07-24T00:00:00Z',
    ...overrides,
  }
}

// ============================================================================
// Shared setup
// ============================================================================

beforeEach(() => {
  setPrivateRegistryService(createLiveRegistryService())
})

afterEach(() => {
  setPrivateRegistryService(createStubRegistryService())
  vi.clearAllMocks()
})

// ============================================================================
// publish — team scoping, content hash, immutability, size cap
// ============================================================================

describe('private_registry_publish live mode — SMI-5816', () => {
  it('inserts with the resolved team_id and a SKILL.md-derived content_hash', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({ data: publishedRow(), error: null }),
    })
    const { getSupabaseAdminClient, getSupabaseClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    expect(getSupabaseAdminClient).toHaveBeenCalled()
    // anon client is never used for CRUD in live mode
    expect(getSupabaseClient).not.toHaveBeenCalled()

    const insertCall = calls.find((c) => c.op === 'insert')
    expect(insertCall).toBeDefined()
    expect(insertCall!.table).toBe('private_registry_skills')
    expect(insertCall!.payload?.team_id).toBe(RESOLVED_TEAM)
    expect(insertCall!.payload?.skill_id).toBe('myteam/skill-a')
    expect(insertCall!.payload?.content).toEqual(SAMPLE_CONTENT)
    // Uses the SAME shared sha256Hex the public inventory path uses
    // (packages/core/src/journal/hash.ts) — plan doc's Shared-State/Coordination
    // Audit invariant: one hash implementation, not independent inline copies.
    expect(insertCall!.payload?.content_hash).toBe(sha256Hex(SAMPLE_CONTENT['SKILL.md']))
  })

  it('surfaces a clean immutability error when the (team, skill, version) already exists', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/immutable|already exists/i)
  })

  it('rejects content over the 2 MB cap before hitting the database', async () => {
    const { client, calls } = createFakeClient()
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const huge = { 'SKILL.md': 'x'.repeat(2 * 1024 * 1024 + 10) }
    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: huge },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/2 MB|limit/i)
    // Size guard runs before any insert.
    expect(calls.find((c) => c.op === 'insert')).toBeUndefined()
  })

  it('rejects content missing a SKILL.md entry', async () => {
    const { client } = createFakeClient()
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: { 'other.txt': 'x' } },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/SKILL\.md/i)
  })

  it('surfaces a typed error when SUPABASE_SERVICE_ROLE_KEY is not configured', async () => {
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    // mockRejectedValue (not -Once): a genuinely-missing service-role key fails EVERY
    // call, not just the first — SMI-5852's namespace pre-check (getNamespace) now makes
    // an extra call before publish() itself, and -Once would silently consume that first
    // rejection, letting publish()'s own call fall through to the mock's default (resolved)
    // behavior instead of re-throwing.
    vi.mocked(getSupabaseAdminClient).mockRejectedValue(
      new Error('Supabase admin not configured: SUPABASE_SERVICE_ROLE_KEY required')
    )

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })
})

// ============================================================================
// SMI-5852 — namespace pre-check (UX only; the DB trigger is the real boundary)
// and AC-11 namespace discoverability
// ============================================================================

describe('private_registry_publish namespace pre-check — SMI-5852', () => {
  it('rejects a mismatched skill_id namespace before ever attempting an insert', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({ data: { skill_namespace: 'myteam' }, error: null }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'anthropic/commit', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/myteam/)
    // The UX pre-check short-circuits — the DB trigger never needs to reject it.
    expect(calls.find((c) => c.op === 'insert')).toBeUndefined()
  })

  it('includes the team namespace on a successful publish (AC-11)', async () => {
    // The fake client's singleResponder isn't table-aware, so it's shared between the
    // pre-check's `teams` lookup and the actual `private_registry_skills` insert — merge
    // both shapes into one fixture rather than a bare { skill_namespace } that would make
    // the eventual mapRow() output unrealistically empty.
    const { client } = createFakeClient({
      singleResponder: () => ({
        data: { ...publishedRow(), skill_namespace: 'myteam' },
        error: null,
      }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.skillNamespace).toBe('myteam')
    expect(result.skill?.skillId).toBe('myteam/skill-a')
  })

  it('does not block publish when the namespace lookup is unresolvable (known gap, M3)', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({ data: publishedRow(), error: null }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    // publishedRow() has no skill_namespace field, so the pre-check treats it as
    // unresolvable and the DB trigger remains the sole gate — publish proceeds.
    expect(result.success).toBe(true)
    expect(calls.find((c) => c.op === 'insert')).toBeDefined()
  })
})

describe('private_registry_manage namespace action — SMI-5852 AC-11', () => {
  it('returns the team namespace without attempting a publish', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({ data: { skill_namespace: 'myteam' }, error: null }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.namespace).toBe('myteam')
  })

  it('surfaces a typed error when the namespace cannot be resolved', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({ data: null, error: { message: 'not found' } }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unable to resolve/i)
  })
})

// ============================================================================
// manage — every read/update is scoped to the resolved team (cross-tenant guard)
// ============================================================================

describe('private_registry_manage live mode — team scoping — SMI-5816', () => {
  it('list filters by the resolved team_id', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === RESOLVED_TEAM)).toBe(true)
  })

  it('get filters by resolved team_id + skill_id + version', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({ data: publishedRow(), error: null }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === RESOLVED_TEAM)).toBe(true)
    expect(q!.filters.some((f) => f.column === 'skill_id' && f.value === 'myteam/skill-a')).toBe(
      true
    )
    expect(q!.filters.some((f) => f.column === 'version' && f.value === '1.0.0')).toBe(true)
  })

  it('deprecate updates deprecated=true scoped to team_id + skill_id', async () => {
    const { client, calls } = createFakeClient({
      thenResponder: () => ({ data: [publishedRow({ deprecated: true })], error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'deprecate', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.op === 'update')
    expect(q).toBeDefined()
    expect(q!.payload?.deprecated).toBe(true)
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === RESOLVED_TEAM)).toBe(true)
    expect(q!.filters.some((f) => f.column === 'skill_id' && f.value === 'myteam/skill-a')).toBe(
      true
    )
  })

  it('deprecate returns not-found when no row in this team matches', async () => {
    // Zero updated rows AND zero readable rows: the skill genuinely does not exist for this
    // team. Contrast with the "member, not admin" case below, where the rows ARE readable.
    const { client } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'deprecate', skillId: 'myteam/ghost' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })

  // Regression test: an update without .select() gets `data: null` back from PostgREST even when
  // rows were actually changed — the fake client's `then()` enforces this. If either method ever
  // drops its .select() call again, this fails because the "successful" mutation is (correctly)
  // reported as not-found.
  it.each([
    { action: 'deprecate' as const, deprecated: true },
    { action: 'undeprecate' as const, deprecated: false },
  ])('$action requests a representation (select) so a real update is detected', async (c) => {
    const { client } = createFakeClient({
      thenResponder: () => ({ data: [publishedRow({ deprecated: c.deprecated })], error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: c.action, skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(true)
  })

  it('get distinguishes a real database error from a not-found result', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({
        data: null,
        error: { code: '08006', message: 'connection failure' },
      }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    // A connectivity/permission failure must surface as an error, not silently
    // read as "skill not found" — the two are operationally very different.
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/connection failure/i)
    expect(result.error).not.toMatch(/not found/i)
  })

  it('get returns null (not-found) for PostgREST’s genuine no-rows code', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
        },
      }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/ghost', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })
})
