/**
 * @fileoverview SMI-5822 regression suite — deprecate/undeprecate are user-authorized, not
 *   license-key-authorized
 * @see SMI-5822: a team's shared license key was, in effect, an admin credential
 * @see SMI-5882: red-team assessment, What Changes §2 / Wave 3
 * @see docs/internal/implementation/smi-5882-redteam-private-registry-privacy-assessment.md
 *
 * **This suite is the inversion of a proven gap, not a hypothetical.** SMI-5882 Wave 1 ran
 * `scripts/staging/smi-5882-private-registry-rls-role-boundary.sql` against staging and
 * demonstrated the escalation as an asymmetry in one transaction: block E1 showed a team
 * *member* deprecating over the authenticated/RLS path reaches `0 rows`
 * (`private_registry_skills_admin_update` is correctly restrictive), while block E2 showed the
 * identical `UPDATE` as `service_role` deprecated 2 rows. Because `createLiveRegistryService()`
 * used the service-role client for all CRUD, and `resolve_team_from_license` is
 * `(p_license_key TEXT) RETURNS TEXT` — a *team*, never a *person* — any holder of the shared
 * team key reached exactly the unrestricted E2 path.
 *
 * **Why the assertions here are shaped the way they are.** E2 cannot be inverted in SQL: at the
 * database layer `service_role` still bypasses RLS, by design, and that is not changing. The fix
 * is that the MCP path no longer *reaches* it for these two operations. So the inversion has to
 * be asserted where the change actually is — in which credential the service picks — which is
 * what every test below checks:
 *
 *   1. the deprecating UPDATE is issued on the **user** client, and the service-role client
 *      never sees an UPDATE to `private_registry_skills` at all;
 *   2. with no signed-in user, the operation fails with an actionable error and issues **no**
 *      write — rather than silently falling back to the service-role client, which would restore
 *      the escalation;
 *   3. a member whose rows are readable but not writable is told they are not an admin, not that
 *      the skill does not exist;
 *   4. the audit row for these operations names the **user** who authorized them, not the license
 *      key that did not (cross-provider review finding #3);
 *   5. a failed readability probe surfaces as a real error, never as "not found" (finding #4).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createLiveRegistryService } from './registry-tools.live.js'

/**
 * A realistically-shaped access token, so `accessTokenSubject()` has a real `sub` to read.
 * `vi.hoisted` because `vi.mock` factories are hoisted above ordinary `const` declarations.
 */
const { FAKE_USER_ID, FAKE_JWT } = vi.hoisted(() => {
  const userId = '11111111-2222-3333-4444-555555555555'
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return {
    FAKE_USER_ID: userId,
    FAKE_JWT: `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: userId, role: 'authenticated' })}.sig`,
  }
})

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
  resolveUserAccessToken: vi.fn(async () => FAKE_JWT),
}))

const TEAM = 'team-alpha'
const SKILL = 'myteam/skill-a'

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update'
  filters: Array<{ column: string; value: unknown }>
  payload?: Record<string, unknown>
}

/**
 * Recording fake whose `then()` result is decided per call, so one client can answer the UPDATE
 * with zero rows and the follow-up readability probe with one — the exact shape of a member who
 * can see a skill but not deprecate it.
 */
function createRecorder(
  respond: (record: Recorded) => {
    data: unknown[] | null
    error: { message?: string } | null
  } = () => ({
    data: [{ id: 'row-1' }],
    error: null,
  })
): { client: unknown; calls: Recorded[] } {
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
      // `.single()` answers from the same `respond` hook so a caller that uses it (publish,
      // getNamespace) is driven by the same per-call script as the array-returning callers.
      single: async () => {
        const r = respond(record)
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      },
      then: (onFulfilled: (v: { data: unknown[] | null; error: unknown }) => unknown) =>
        Promise.resolve(onFulfilled(respond(record))),
    }
    return chain
  }
  return { client: { from: (table: string) => makeQuery(table) }, calls }
}

async function setClients(userClient: unknown, adminClient: unknown): Promise<void> {
  const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseAdminClient).mockResolvedValue(adminClient)
  vi.mocked(getSupabaseUserClient).mockResolvedValue(userClient)
}

describe('SMI-5822 — deprecate/undeprecate require a user credential, not the team license key', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValue(FAKE_JWT)
  })

  it.each([
    { op: 'deprecate' as const, expected: true },
    { op: 'undeprecate' as const, expected: false },
  ])(
    '$op issues its UPDATE on the user client — the service-role client never updates the table',
    async ({ op, expected }) => {
      const user = createRecorder()
      const admin = createRecorder()
      await setClients(user.client, admin.client)

      const service = createLiveRegistryService()
      await expect(service[op](TEAM, SKILL)).resolves.toBe(true)

      const userUpdate = user.calls.find(
        (c) => c.op === 'update' && c.table === 'private_registry_skills'
      )
      expect(userUpdate).toBeDefined()
      expect(userUpdate!.payload?.deprecated).toBe(expected)
      // Tenant scoping is still explicit in-query (ADR-116), now backed by _admin_update's
      // USING clause rather than standing on its own.
      expect(userUpdate!.filters).toEqual(
        expect.arrayContaining([
          { column: 'team_id', value: TEAM },
          { column: 'skill_id', value: SKILL },
        ])
      )

      // This is the assertion that inverts Wave 1's block E2.
      expect(
        admin.calls.some((c) => c.op === 'update' && c.table === 'private_registry_skills')
      ).toBe(false)
    }
  )

  it.each(['deprecate', 'undeprecate'] as const)(
    '%s refuses — and writes nothing — when no user is signed in',
    async (op) => {
      const { resolveUserAccessToken } = await import('./team-resolver.js')
      vi.mocked(resolveUserAccessToken).mockResolvedValue(null)

      const user = createRecorder()
      const admin = createRecorder()
      await setClients(user.client, admin.client)

      const service = createLiveRegistryService()
      await expect(service[op](TEAM, SKILL)).rejects.toThrow(/skillsmith login/i)

      // No silent service-role fallback: that would be the SMI-5822 escalation, restored.
      expect(user.calls).toHaveLength(0)
      expect(admin.calls.some((c) => c.table === 'private_registry_skills')).toBe(false)
    }
  )

  it.each(['deprecate', 'undeprecate'] as const)(
    '%s tells a non-admin member they are not an admin, rather than "not found"',
    async (op) => {
      // RLS UPDATE denials do not raise — the row is simply invisible to the statement, which
      // affects zero rows. The readability probe is what distinguishes the two cases.
      const user = createRecorder((record) =>
        record.op === 'update'
          ? { data: [], error: null }
          : { data: [{ id: 'row-1' }], error: null }
      )
      const admin = createRecorder()
      await setClients(user.client, admin.client)

      const service = createLiveRegistryService()
      await expect(service[op](TEAM, SKILL)).rejects.toThrow(/only team admins/i)
    }
  )

  it.each(['deprecate', 'undeprecate'] as const)(
    '%s still reports not-found when the skill is not even readable',
    async (op) => {
      const user = createRecorder(() => ({ data: [], error: null }))
      const admin = createRecorder()
      await setClients(user.client, admin.client)

      const service = createLiveRegistryService()
      await expect(service[op](TEAM, SKILL)).resolves.toBe(false)
    }
  )

  // ==========================================================================
  // Finding #4 — a broken readability probe is an outage, not an absence.
  //
  // The UPDATE matching zero rows is ambiguous, and the probe is what resolves it. If the probe
  // ITSELF fails (expired token, network fault, permission/config problem), nothing has been
  // resolved — reporting `not_found`/`false` would tell the caller the skill does not exist and
  // make a real outage indistinguishable from a genuine absence. This is the same reasoning the
  // file's `isNoRowsError()` convention encodes for every other query.
  // ==========================================================================
  it.each(['deprecate', 'undeprecate'] as const)(
    '%s surfaces a failed readability probe as an error instead of reporting "not found"',
    async (op) => {
      const user = createRecorder((record) =>
        record.op === 'update'
          ? { data: [], error: null }
          : { data: null, error: { code: 'PGRST301', message: 'JWT expired' } }
      )
      const admin = createRecorder()
      await setClients(user.client, admin.client)

      const service = createLiveRegistryService()
      await expect(service[op](TEAM, SKILL)).rejects.toThrow(/cannot tell whether it is missing/i)

      const audit = admin.calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
      expect(audit).toBeDefined()
      expect(audit!.payload?.result).toBe('error')
      expect((audit!.payload?.metadata as Record<string, unknown>).detail).toBe('PGRST301')
    }
  )

  it('treats a CONFIRMED no-rows probe (PGRST116) as a genuine absence, not an error', async () => {
    const user = createRecorder((record) =>
      record.op === 'update'
        ? { data: [], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    )
    const admin = createRecorder()
    await setClients(user.client, admin.client)

    await expect(createLiveRegistryService().deprecate(TEAM, SKILL)).resolves.toBe(false)

    const audit = admin.calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    expect(audit!.payload?.result).toBe('not_found')
  })

  // ==========================================================================
  // Finding #3 — the audit row names the credential that actually authorized the write.
  //
  // `deprecate`/`undeprecate` are authorized by `private_registry_skills_admin_update` against a
  // real `auth.uid()`. Recording `license_key:<fingerprint>` as the actor named a credential with
  // no say in the decision. The key fingerprint stays in metadata (still useful for correlation);
  // the ACTOR is the user.
  // ==========================================================================
  it('attributes an admin-authorized deprecate to the JWT user, not to the license key', async () => {
    const user = createRecorder()
    const admin = createRecorder()
    await setClients(user.client, admin.client)

    await createLiveRegistryService().deprecate(TEAM, SKILL)

    const audit = admin.calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    expect(audit).toBeDefined()
    expect(audit!.payload?.event_type).toBe('private_registry:deprecate')
    expect(audit!.payload?.result).toBe('success')
    expect(audit!.payload?.actor).toBe(`user:${FAKE_USER_ID}`)
    // The license key did not authorize this, so it must not appear as the actor.
    expect(String(audit!.payload?.actor)).not.toContain('license_key')
    expect(String(audit!.payload?.actor)).not.toContain('sk_test_fake_license')

    const metadata = audit!.payload?.metadata as Record<string, unknown>
    expect(metadata.auth_path).toBe('user_jwt')
    expect(metadata.actor_user_id).toBe(FAKE_USER_ID)
    // Still correlatable to the key the session was configured with — as a digest, never the key.
    expect(metadata.license_key_fingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(String(metadata.license_key_fingerprint)).not.toContain('sk_test_fake_license')
  })

  it('records an explicitly-unattributed actor when the user token yields no subject', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValue('not-a-jwt')

    const user = createRecorder()
    const admin = createRecorder()
    await setClients(user.client, admin.client)

    await createLiveRegistryService().deprecate(TEAM, SKILL)

    const audit = admin.calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    // Unknown, never backfilled with the license key that did not authorize it.
    expect(audit!.payload?.actor).toBe('user_jwt:unknown')
    expect((audit!.payload?.metadata as Record<string, unknown>).actor_user_id).toBeNull()
  })

  it('still attributes a publish to the license key — that path really is key-authorized', async () => {
    const admin = createRecorder()
    await setClients(createRecorder().client, admin.client)

    await createLiveRegistryService().publish(TEAM, SKILL, '1.0.0', {
      'SKILL.md': '# a skill',
    })

    const audit = admin.calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    expect(audit!.payload?.actor).toMatch(/^license_key:[0-9a-f]{12}$/)
    expect(String(audit!.payload?.actor)).not.toContain('sk_test_fake_license')
    expect((audit!.payload?.metadata as Record<string, unknown>).auth_path).toBe('license_key')
  })
})
