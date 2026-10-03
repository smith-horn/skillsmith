/**
 * @fileoverview SMI-6114 — committed private-registry mutations are audited by the database, not
 *   by a client-side service-role write
 * @see supabase/migrations/20260913000000_private_registry_audit_trigger.sql (trg_prs_audit)
 * @see scripts/tests/private-registry-audit-trigger.test.ts — the trigger itself, on real Postgres
 *
 * Production MCP hosts carry no `SUPABASE_SERVICE_ROLE_KEY`, so `getSupabaseAdminClient()` throws
 * there and every client-side audit row was silently dropped. These tests run the live service
 * with the admin getter rejecting exactly as it does in production and assert that a successful
 * publish, approve, reject, deprecate or undeprecate never reaches for it: the success record is
 * the trigger's, written in the mutation's own transaction, so a second client-side row would be
 * a duplicate on any host that does hold the key.
 *
 * The positive control at the bottom proves the harness can observe an admin-getter call at all,
 * so "not called" above cannot be an artefact of a broken mock.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createLiveRegistryService } from './registry-tools.live.js'
import { recordRegistryAudit, type RegistryAuditEvent } from './registry-tools.live.audit.js'
import {
  RESOLVED_TEAM,
  SAMPLE_CONTENT,
  createFakeClient,
} from './registry-tools.live.test-helpers.js'

const { FAKE_JWT } = vi.hoisted(() => {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return {
    FAKE_JWT: `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({
      sub: '11111111-2222-3333-4444-555555555555',
      role: 'authenticated',
    })}.sig`,
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

const SKILL = 'myteam/skill-a'

/** Wire the user client, and make the admin getter fail the way it does with no service key. */
async function productionLikeClients(userClient: unknown): Promise<void> {
  const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseUserClient).mockResolvedValue(userClient)
  vi.mocked(getSupabaseAdminClient).mockRejectedValue(
    new Error('Supabase admin not configured: SUPABASE_SERVICE_ROLE_KEY required')
  )
}

async function adminGetter() {
  const { getSupabaseAdminClient } = await import('../supabase-client.js')
  return vi.mocked(getSupabaseAdminClient)
}

describe('SMI-6114 — no client-side success audit for committed registry mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publish succeeds without touching the service-role client or writing audit_logs', async () => {
    const { client, calls } = createFakeClient()
    await productionLikeClients(client)

    const skill = await createLiveRegistryService().publish(
      RESOLVED_TEAM,
      SKILL,
      '1.0.0',
      SAMPLE_CONTENT
    )

    expect(skill.approvalStatus).toBe('pending')
    expect(await adminGetter()).not.toHaveBeenCalled()
    expect(calls.some((c) => c.table === 'audit_logs')).toBe(false)
    expect(calls.filter((c) => c.op === 'insert').map((c) => c.table)).toEqual([
      'private_registry_skills',
    ])
  })

  it('publish whose read-back fails still writes no client-side row (the insert committed)', async () => {
    const { client, calls } = createFakeClient({
      rpcResponder: () => ({ data: null, error: { code: 'PGRST000', message: 'network' } }),
    })
    await productionLikeClients(client)

    await expect(
      createLiveRegistryService().publish(RESOLVED_TEAM, SKILL, '1.0.0', SAMPLE_CONTENT)
    ).rejects.toThrow(/confirmation read-back failed/)

    expect(await adminGetter()).not.toHaveBeenCalled()
    expect(calls.some((c) => c.table === 'audit_logs')).toBe(false)
  })

  it.each(['approved', 'rejected'] as const)(
    'a %s review decision does not touch the service-role client',
    async (decision) => {
      const { client, calls, rpcCalls } = createFakeClient()
      await productionLikeClients(client)

      const review = await createLiveRegistryService().review(
        RESOLVED_TEAM,
        SKILL,
        '1.0.0',
        decision
      )

      expect(review.approvalStatus).toBe(decision)
      expect(rpcCalls.map((c) => c.fn)).toEqual(['review_private_registry_submission'])
      expect(await adminGetter()).not.toHaveBeenCalled()
      expect(calls.some((c) => c.table === 'audit_logs')).toBe(false)
    }
  )

  it.each(['deprecate', 'undeprecate'] as const)(
    'a successful %s does not touch the service-role client',
    async (op) => {
      const { client, calls } = createFakeClient({
        thenResponder: () => ({ data: [{ id: 'row-1' }], error: null }),
      })
      await productionLikeClients(client)

      await expect(createLiveRegistryService()[op](RESOLVED_TEAM, SKILL)).resolves.toBe(true)

      expect(await adminGetter()).not.toHaveBeenCalled()
      expect(calls.some((c) => c.table === 'audit_logs')).toBe(false)
    }
  )

  it('recordRegistryAudit refuses a mutation success row even from an untyped caller', async () => {
    const { client, calls } = createFakeClient()
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    for (const operation of ['publish', 'approve', 'reject', 'deprecate', 'undeprecate']) {
      await recordRegistryAudit({
        operation,
        teamId: RESOLVED_TEAM,
        skillId: SKILL,
        result: 'success',
        authPath: 'user_jwt',
      } as unknown as RegistryAuditEvent)
    }

    expect(vi.mocked(getSupabaseAdminClient)).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  // Positive control: the same harness DOES observe the admin getter when the client still owns
  // the row — an attempt that did not commit (RLS matched zero rows, probe shows the row exists).
  it('control: a denied deprecate still attempts its best-effort client-side row', async () => {
    let call = 0
    const { client } = createFakeClient({
      thenResponder: () =>
        call++ === 0 ? { data: [], error: null } : { data: [{ id: 'row-1' }], error: null },
    })
    await productionLikeClients(client)

    await expect(createLiveRegistryService().deprecate(RESOLVED_TEAM, SKILL)).rejects.toThrow(
      /only team admins/i
    )

    expect(await adminGetter()).toHaveBeenCalledTimes(1)
  })

  it('control: a read success row is still attempted (reads have no trigger)', async () => {
    const { client } = createFakeClient()
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    await recordRegistryAudit({
      operation: 'list',
      teamId: RESOLVED_TEAM,
      result: 'success',
      authPath: 'user_jwt',
    })

    expect(vi.mocked(getSupabaseAdminClient)).toHaveBeenCalledTimes(1)
  })
})

describe('SMI-6114 — client-side rows follow the untag rule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function metadataFor(event: RegistryAuditEvent): Promise<Record<string, unknown>> {
    const { client, calls } = createFakeClient()
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
    await recordRegistryAudit(event)
    const insert = calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    return insert!.payload?.metadata as Record<string, unknown>
  }

  const base = { teamId: RESOLVED_TEAM, skillId: SKILL, authPath: 'user_jwt' as const }

  it.each([
    ['a refused approve (names a pending submission)', { operation: 'approve', result: 'denied' }],
    ['a refused reject', { operation: 'reject', result: 'denied' }],
    ['a failed publish', { operation: 'publish', result: 'error' }],
    ['a get that found nothing', { operation: 'get', result: 'not_found' }],
    ['a content_read miss', { operation: 'content_read', result: 'not_found' }],
    ['a deprecate that found nothing', { operation: 'deprecate', result: 'not_found' }],
  ] as const)('%s carries no team_id', async (_label, shape) => {
    const metadata = await metadataFor({ ...base, ...shape } as RegistryAuditEvent)
    expect(metadata.team_id).toBeUndefined()
    expect(metadata).toMatchObject({ registry_team_id: RESOLVED_TEAM, member_visible: false })
  })

  it.each([
    ['a successful list', { operation: 'list', result: 'success' }],
    ['a successful get', { operation: 'get', result: 'success' }],
    [
      'a deprecate refused to a non-admin (rows were member-readable)',
      { operation: 'deprecate', result: 'denied' },
    ],
  ] as const)('%s is team-tagged', async (_label, shape) => {
    const metadata = await metadataFor({ ...base, ...shape } as RegistryAuditEvent)
    expect(metadata).toMatchObject({
      team_id: RESOLVED_TEAM,
      registry_team_id: RESOLVED_TEAM,
      member_visible: true,
    })
  })
})
