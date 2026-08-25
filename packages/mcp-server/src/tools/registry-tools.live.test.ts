/**
 * @fileoverview Live-mode tests for private_registry_publish
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 *
 * Exercises the live Supabase-backed service (registry-tools.live.ts) by mocking
 * `getSupabaseAdminClient`/`getSupabaseUserClient` with recording fake clients (see
 * registry-tools.live.test-helpers.ts). `manage` (list/get/deprecate/namespace) coverage lives in
 * the sibling registry-tools.live.manage.test.ts — split from one file, SMI-5949 Wave 2, to stay
 * under the 500-line audit:standards gate. Focus areas (the exact bug classes plan-review flagged
 * for the notification layer, hardened here since Wave 2 builds on this table):
 *   - every operation is scoped to the license-resolved team_id (a caller can never
 *     target another team — the service-layer half of cross-tenant isolation; the
 *     DB/RLS half is asserted in scripts/tests/private-registry-rls.test.ts);
 *   - published (team_id, skill_id, version) triples are immutable (clean error, no
 *     silent upsert);
 *   - content over 2 MB and content missing SKILL.md are rejected before insert;
 *   - SMI-5949 Wave 2 Step 2 (D-7): publish() runs on the signed-in user's client, not
 *     service-role — the insert lands on the user client, sends no content_hash (not in the
 *     authenticated GRANT INSERT column list), and is representation-free (D-4(a)); a missing
 *     service-role key no longer blocks publish at all, only a missing user credential does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  executePrivateRegistryPublish,
  setPrivateRegistryService,
  createStubRegistryService,
} from './registry-tools.js'
import { createLiveRegistryService } from './registry-tools.live.js'
import {
  RESOLVED_TEAM,
  SAMPLE_CONTENT,
  createFakeClient,
  makeContext,
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
// publish — team scoping, content hash, immutability, size cap
// ============================================================================

// ============================================================================
// publish — team scoping, content hash, immutability, size cap
// ============================================================================

describe('private_registry_publish live mode — SMI-5816', () => {
  it('inserts on the USER client (not service-role) with the resolved team_id, and sends no content_hash — SMI-5949 D-7/D-4(a)', async () => {
    // Separate recorders for admin vs. user, so the assertions below can tell WHICH credential
    // the insert actually reached — the exact SMI-5822-shaped question this file's sibling
    // (registry-tools.live.admin-auth.test.ts) already asks of deprecate/undeprecate.
    const admin = createFakeClient()
    const user = createFakeClient()
    const { getSupabaseAdminClient, getSupabaseUserClient, getSupabaseClient } =
      await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(admin.client)
    vi.mocked(getSupabaseUserClient).mockResolvedValue(user.client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    expect(getSupabaseUserClient).toHaveBeenCalled()
    // anon client is never used for CRUD in live mode
    expect(getSupabaseClient).not.toHaveBeenCalled()

    const insertCall = user.calls.find((c) => c.op === 'insert')
    expect(insertCall).toBeDefined()
    expect(insertCall!.table).toBe('private_registry_skills')
    expect(insertCall!.payload?.team_id).toBe(RESOLVED_TEAM)
    expect(insertCall!.payload?.skill_id).toBe('myteam/skill-a')
    expect(insertCall!.payload?.content).toEqual(SAMPLE_CONTENT)
    // D-4(a): the insert is representation-free — no .select() requested.
    expect(insertCall!.selectCalled).toBe(false)
    // The GRANT INSERT column list on `authenticated` (20260729000000:268-269) does not include
    // content_hash — empirically confirmed against staging that sending it here raises a
    // column-privilege 42501. The trigger derives it server-side instead.
    expect(insertCall!.payload).not.toHaveProperty('content_hash')
    // The service-role client never sees an insert into this table on the publish path.
    expect(
      admin.calls.some((c) => c.op === 'insert' && c.table === 'private_registry_skills')
    ).toBe(false)

    // mapSubmissionRow() populated the new fields from the RPC read-back (D-4(c)).
    expect(result.skill?.approvalStatus).toBe('pending')
    expect(result.skill?.approvalMode).toBe('review')
    // A pending publish must not present a live Registry URL in the message (plan-review M9).
    expect(result.message).not.toMatch(/Registry URL/i)
    expect(result.message).toMatch(/^Submitted .* for review/i)
  })

  it('surfaces a clean immutability error when the (team, skill, version) already exists', async () => {
    const { client } = createFakeClient({
      thenResponder: () => ({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      }),
    })
    const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
    vi.mocked(getSupabaseUserClient).mockResolvedValue(client)

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
    // Size guard runs before any skill-row insert. Scoped to `private_registry_skills`
    // specifically (not "any insert") since SMI-6109: the namespace pre-check's getNamespace()
    // call still runs first regardless of the eventual size-cap rejection, and — with no
    // getSupabaseUserClient mock configured in this test — fails internally and records its own
    // (unrelated, expected) `audit_logs` insert via the fail-soft recordRegistryAudit() path.
    expect(
      calls.find((c) => c.op === 'insert' && c.table === 'private_registry_skills')
    ).toBeUndefined()
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

  // SMI-5949 Wave 2 Step 2 (D-7) rewrite of the pre-existing "SUPABASE_SERVICE_ROLE_KEY not
  // configured" test: publish() no longer touches the service-role client for its own write —
  // only the best-effort namespace pre-check and the fail-soft audit write do, and neither is on
  // the success path. That is a real behavior change worth its own regression test, not just a
  // deletion: a reader could otherwise assume (wrongly) that publish still needs the service-role
  // key, the way it did before this Wave.
  it('publish succeeds via the user client even when SUPABASE_SERVICE_ROLE_KEY is entirely unavailable (D-7)', async () => {
    const { client: userClient } = createFakeClient()
    const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockRejectedValue(
      new Error('Supabase admin not configured: SUPABASE_SERVICE_ROLE_KEY required')
    )
    vi.mocked(getSupabaseUserClient).mockResolvedValue(userClient)

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.skill?.approvalStatus).toBe('pending')
  })

  it('publish fails with an actionable error, and writes nothing, when no user is signed in (D-7)', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    // SMI-6109: the namespace pre-check (registry-tools.ts) now calls getNamespace(), which itself
    // resolves a user token before publish() gets its own turn. A genuinely-not-signed-in caller
    // has no token for EITHER call, so both of this test's two calls need to see null — queuing
    // two `Once` responses (not a persistent mockResolvedValue(null), which would outlive this
    // test: vi.clearAllMocks() in afterEach clears call history, not a configured implementation,
    // so a persistent override here would silently leak "not logged in" into every later test in
    // this file).
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    const { client } = createFakeClient()
    const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
    vi.mocked(getSupabaseUserClient).mockResolvedValue(client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'myteam/skill-a', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/skillsmith login/i)
    // A license key alone must never be reinterpreted as "any team member" — the whole point
    // of this credential move (D-7) is that a shared key cannot name a submitter.
    expect(result.error).toMatch(/any team member/i)
    expect(result.error).not.toMatch(/only team admins/i)
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
    // SMI-6109: the pre-check's getNamespace() call now runs on the signed-in user's own JWT
    // (getMemberUserClient), not the service-role client — both getters need mocking now, matching
    // this describe block's other two tests below.
    const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
    vi.mocked(getSupabaseUserClient).mockResolvedValue(client)

    const result = await executePrivateRegistryPublish(
      { skillId: 'anthropic/commit', version: '1.0.0', content: SAMPLE_CONTENT },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/myteam/)
    // The UX pre-check short-circuits — the DB trigger never needs to reject it. Scoped to
    // `private_registry_skills` specifically (not "any insert"): SMI-6109 added audit logging to
    // getNamespace() itself, so a successful pre-check now legitimately writes one `audit_logs`
    // row (recordRegistryAudit, fail-soft) even though the skill row is never inserted.
    expect(
      calls.find((c) => c.op === 'insert' && c.table === 'private_registry_skills')
    ).toBeUndefined()
  })

  it('includes the team namespace on a successful publish (AC-11)', async () => {
    // The fake client's singleResponder isn't table-aware, so it's shared between the
    // pre-check's `teams` lookup (the only remaining .single() call — the insert itself is
    // representation-free, D-4(a)) and any other .single() caller. Both admin (namespace
    // pre-check) and user (the actual insert + RPC read-back) point at the same recorder.
    const { client } = createFakeClient({
      singleResponder: () => ({
        data: { ...publishedRow(), skill_namespace: 'myteam' },
        error: null,
      }),
    })
    const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
    vi.mocked(getSupabaseUserClient).mockResolvedValue(client)

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
    const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
    vi.mocked(getSupabaseUserClient).mockResolvedValue(client)

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
