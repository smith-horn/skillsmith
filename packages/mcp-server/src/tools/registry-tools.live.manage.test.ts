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
 *     approval_status='approved' in-query predicate, since RLS does not enforce it either
 *     (still true post-SMI-6109 — see the class doc comment below);
 *   - deprecate/undeprecate require a real representation (`.select()`) so a successful
 *     update is never misreported as not-found;
 *   - SMI-6109: list/get/getNamespace moved off the service-role client onto the signed-in
 *     user's own JWT (member-level, `getMemberUserClient()`) — every test below now mocks
 *     `getSupabaseUserClient` via `mockBothClients()` (both credential getters point at one
 *     recorder) rather than `getSupabaseAdminClient()` alone, and a new describe block covers
 *     the not-logged-in path these three now share with `getContent`/`publish`.
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
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.namespace).toBe('myteam')
  })

  it('surfaces a typed error when the namespace cannot be resolved', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({ data: null, error: { message: 'not found' } }),
    })
    await mockBothClients(client)

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
    await mockBothClients(client)

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
    await mockBothClients(client)

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
    await mockBothClients(client)

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
    await mockBothClients(client)

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

  // ==========================================================================
  // SMI-5949 Wave 3: `deprecated` read-filter closure
  // ==========================================================================

  it('list filters by deprecated=false by default (SMI-5949 Wave 3)', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated' && f.value === false)).toBe(true)
  })

  it('list with includeDeprecated:true skips the deprecated predicate (SMI-5949 Wave 3)', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'list', includeDeprecated: true },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated')).toBe(false)
  })

  it('list with includeDeprecated:false still filters deprecated=false (explicit false is the same as omitted)', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'list', includeDeprecated: false },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated' && f.value === false)).toBe(true)
  })

  it('get (pinned version) always filters deprecated=false, with no opt-in (SMI-5949 Wave 3)', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({ data: publishedRow(), error: null }),
    })
    await mockBothClients(client)

    // `get` has no `includeDeprecated` field at all — passing extra input is not possible through
    // the typed handler, so this asserts the predicate is present unconditionally.
    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated' && f.value === false)).toBe(true)
  })

  it('get (latest, no version) always filters deprecated=false, with no opt-in (SMI-5949 Wave 3)', async () => {
    const { client, calls } = createFakeClient({
      thenResponder: () => ({ data: [publishedRow()], error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated' && f.value === false)).toBe(true)
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
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/ghost', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })
})

// ============================================================================
// SMI-6109: list/get/getNamespace now require a signed-in user (member-level), not just a
// license key — mirrors registry-tools.live.admin-auth.test.ts's pattern for the admin-gated
// deprecate/undeprecate pair.
// ============================================================================

describe('private_registry_manage live mode — SMI-6109 member-credential requirement', () => {
  it('list refuses — and issues no query — when no user is signed in', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/skillsmith login/i)
    // Any team member may list — this is not an admin-only error.
    expect(result.error).not.toMatch(/only team admins/i)
    expect(calls.find((c) => c.table === 'private_registry_skills')).toBeUndefined()
  })

  it('get refuses — and issues no query — when no user is signed in', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/skillsmith login/i)
    expect(calls.find((c) => c.table === 'private_registry_skills')).toBeUndefined()
  })

  // getNamespace's documented contract (registry-tools.ts's PrivateRegistryService interface) is
  // "or null if it could not be resolved" — it never throws, unlike list/get above, so a
  // not-logged-in caller sees the same typed {success:false} response as any other unresolvable
  // namespace, not a distinguishable "please log in" error. See
  // registry-tools.live.member-reads.ts's header comment for why this asymmetry is deliberate.
  it('namespace resolves to "unable to resolve", not a login error, when no user is signed in', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unable to resolve/i)
    expect(calls.find((c) => c.table === 'teams')).toBeUndefined()
  })
})
