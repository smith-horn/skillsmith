/**
 * @fileoverview Live-mode tests for private_registry_manage (list/get/deprecate/namespace)
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 *
 * Exercises the live Supabase-backed service (registry-tools.live.ts) by mocking
 * `getSupabaseAdminClient`/`getSupabaseUserClient` with recording fake clients (see
 * registry-tools.live.test-helpers.ts). `publish` coverage lives in the sibling
 * registry-tools.live.test.ts — split from one file, SMI-5949 Wave 2, to stay under the 500-line
 * audit:standards gate. Focus areas:
 *   - every operation is scoped to the license-resolved team_id (a caller can never
 *     target another team — the service-layer half of cross-tenant isolation; the
 *     DB/RLS half is asserted in scripts/tests/private-registry-rls.test.ts);
 *   - SMI-5949 Wave 2 Step 3 (D-4 surfaces 3/4): list/get carry a mandatory
 *     approval_status='approved' in-query predicate, since service-role bypasses the RLS
 *     policy that would otherwise enforce it;
 *   - deprecate/undeprecate require a real representation (`.select()`) so a successful
 *     update is never misreported as not-found.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  executePrivateRegistryManage,
  setPrivateRegistryService,
  createStubRegistryService,
} from './registry-tools.js'
import { createLiveRegistryService } from './registry-tools.live.js'
import {
  RESOLVED_TEAM,
  createFakeClient,
  makeContext,
  mockBothClients,
  publishedRow,
} from './registry-tools.live.test-helpers.js'

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
// manage — namespace action
// ============================================================================

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
  it('list filters by the resolved team_id AND approval_status=approved (SMI-5949 D-4 surface 3)', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === RESOLVED_TEAM)).toBe(true)
    expect(q!.filters.some((f) => f.column === 'approval_status' && f.value === 'approved')).toBe(
      true
    )
  })

  it('get filters by resolved team_id + skill_id + version + approval_status=approved (SMI-5949 D-4 surface 4)', async () => {
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
    expect(q!.filters.some((f) => f.column === 'approval_status' && f.value === 'approved')).toBe(
      true
    )
    expect(result.skill?.approvalStatus).toBe('approved')
  })

  it('get (latest, no version) filters by approval_status=approved (SMI-5949 D-4 surface 4)', async () => {
    const { client, calls } = createFakeClient({
      thenResponder: () => ({ data: [publishedRow()], error: null }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'approval_status' && f.value === 'approved')).toBe(
      true
    )
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
