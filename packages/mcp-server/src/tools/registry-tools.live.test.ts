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
import { createHash } from 'node:crypto'
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
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
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
    const record: Recorded = { table, op: 'select', filters: [] }
    calls.push(record)
    const chain: Record<string, unknown> = {
      select: () => chain,
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
    const expectedHash = createHash('sha256')
      .update(SAMPLE_CONTENT['SKILL.md'], 'utf8')
      .digest('hex')
    expect(insertCall!.payload?.content_hash).toBe(expectedHash)
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
    vi.mocked(getSupabaseAdminClient).mockRejectedValueOnce(
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
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

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
    const { client } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage(
      { action: 'deprecate', skillId: 'myteam/ghost' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })
})
