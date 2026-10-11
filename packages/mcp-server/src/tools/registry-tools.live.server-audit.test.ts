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
import {
  recordRegistryAudit,
  type AuditRpcClient,
  type RegistryAuditEvent,
} from './registry-tools.live.audit.js'
import {
  AUDIT_RPC_PARAM_KEYS,
  RESOLVED_TEAM,
  SAMPLE_CONTENT,
  auditRpcCalls,
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
    const { client, calls, rpcCalls } = createFakeClient()
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
    expect(auditRpcCalls(rpcCalls)).toHaveLength(0)
    // Positive control: the read-back RPC did run on this client.
    expect(rpcCalls.some((c) => c.fn === 'get_private_registry_submissions')).toBe(true)
    expect(calls.filter((c) => c.op === 'insert').map((c) => c.table)).toEqual([
      'private_registry_skills',
    ])
  })

  it('publish whose read-back fails still writes no client-side row (the insert committed)', async () => {
    const { client, calls, rpcCalls } = createFakeClient({
      rpcResponder: () => ({ data: null, error: { code: 'PGRST000', message: 'network' } }),
    })
    await productionLikeClients(client)

    await expect(
      createLiveRegistryService().publish(RESOLVED_TEAM, SKILL, '1.0.0', SAMPLE_CONTENT)
    ).rejects.toThrow(/confirmation read-back failed/)

    expect(await adminGetter()).not.toHaveBeenCalled()
    expect(calls.some((c) => c.table === 'audit_logs')).toBe(false)
    expect(auditRpcCalls(rpcCalls)).toHaveLength(0)
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
      // Exactly the review RPC: no second, audit RPC call rides along on a committed decision.
      expect(rpcCalls.map((c) => c.fn)).toEqual(['review_private_registry_submission'])
      expect(await adminGetter()).not.toHaveBeenCalled()
      expect(calls.some((c) => c.table === 'audit_logs')).toBe(false)
    }
  )

  it.each(['deprecate', 'undeprecate'] as const)(
    'a successful %s does not touch the service-role client',
    async (op) => {
      const { client, calls, rpcCalls } = createFakeClient({
        thenResponder: () => ({ data: [{ id: 'row-1' }], error: null }),
      })
      await productionLikeClients(client)

      await expect(createLiveRegistryService()[op](RESOLVED_TEAM, SKILL)).resolves.toBe(true)

      expect(await adminGetter()).not.toHaveBeenCalled()
      expect(calls.some((c) => c.table === 'audit_logs')).toBe(false)
      expect(auditRpcCalls(rpcCalls)).toHaveLength(0)
    }
  )

  it('recordRegistryAudit refuses a mutation success row even from an untyped caller', async () => {
    const { client, calls, rpcCalls } = createFakeClient()
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      for (const operation of ['publish', 'approve', 'reject', 'deprecate', 'undeprecate']) {
        await recordRegistryAudit(
          client as AuditRpcClient,
          {
            operation,
            teamId: RESOLVED_TEAM,
            skillId: SKILL,
            result: 'success',
            authPath: 'user_jwt',
          } as unknown as RegistryAuditEvent
        )
      }
      // Paired presence: each refusal said so on stderr, in the same execution.
      expect(stderr).toHaveBeenCalledTimes(5)
      expect(String(stderr.mock.calls[0][0])).toMatch(/not writing a client-side row/)
    } finally {
      stderr.mockRestore()
    }

    expect(vi.mocked(getSupabaseAdminClient)).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
  })

  // Positive control: the same harness DOES observe an audit report when the client still owns
  // the row — an attempt that did not commit (RLS matched zero rows, probe shows the row exists).
  // Re-pointed (ADR-178): the report is now the audit RPC on the caller's user client, not an
  // admin-getter insert.
  it('control: a denied deprecate still reports its attempt, through the audit RPC', async () => {
    let call = 0
    const { client, rpcCalls } = createFakeClient({
      thenResponder: () =>
        call++ === 0 ? { data: [], error: null } : { data: [{ id: 'row-1' }], error: null },
    })
    await productionLikeClients(client)

    await expect(createLiveRegistryService().deprecate(RESOLVED_TEAM, SKILL)).rejects.toThrow(
      /only team admins/i
    )

    const audit = auditRpcCalls(rpcCalls)
    expect(audit).toHaveLength(1)
    expect(audit[0].params).toMatchObject({ p_operation: 'deprecate', p_result: 'denied' })
    expect(await adminGetter()).not.toHaveBeenCalled()
  })

  it('control: a read success row is still reported (reads have no trigger)', async () => {
    const { client, rpcCalls } = createFakeClient()

    await recordRegistryAudit(client as AuditRpcClient, {
      operation: 'list',
      teamId: RESOLVED_TEAM,
      result: 'success',
      authPath: 'user_jwt',
    })

    expect(auditRpcCalls(rpcCalls)).toHaveLength(1)
  })
})

// ADR-178 moved the untag rule into the RPC: no row it writes is ever member-visible or carries a
// `team_id` key. The client's part of that guarantee is that it offers no way to ask for one.
describe('SMI-6114 — client reports can never ask for a member-visible row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function paramsFor(event: RegistryAuditEvent): Promise<Record<string, unknown>> {
    const { client, rpcCalls } = createFakeClient()
    await recordRegistryAudit(client as AuditRpcClient, event)
    const audit = auditRpcCalls(rpcCalls)
    expect(audit).toHaveLength(1)
    return audit[0].params
  }

  const base = { teamId: RESOLVED_TEAM, skillId: SKILL, authPath: 'user_jwt' as const }

  it.each([
    ['a refused approve (names a pending submission)', { operation: 'approve', result: 'denied' }],
    ['a refused reject', { operation: 'reject', result: 'denied' }],
    ['a failed publish', { operation: 'publish', result: 'error' }],
    ['a get that found nothing', { operation: 'get', result: 'not_found' }],
    ['a deprecate that found nothing', { operation: 'deprecate', result: 'not_found' }],
    ['a successful list', { operation: 'list', result: 'success' }],
    ['a successful get', { operation: 'get', result: 'success' }],
    ['a deprecate refused to a non-admin', { operation: 'deprecate', result: 'denied' }],
  ] as const)(
    '%s sends only the ten named parameters, none of them a visibility tag',
    async (_l, shape) => {
      const params = await paramsFor({ ...base, ...shape } as RegistryAuditEvent)
      expect(Object.keys(params).sort()).toEqual(AUDIT_RPC_PARAM_KEYS)
      expect(params.p_team_id).toBe(RESOLVED_TEAM)
      expect(params.p_operation).toBe(shape.operation)
      expect(params.p_result).toBe(shape.result)
    }
  )

  it('a content_read miss is not reportable at all: the release RPC owns that outcome', async () => {
    const { client, rpcCalls } = createFakeClient()
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await recordRegistryAudit(
        client as AuditRpcClient,
        {
          ...base,
          operation: 'content_read',
          result: 'not_found',
        } as unknown as RegistryAuditEvent
      )
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(String(stderr.mock.calls[0][0])).toMatch(/release RPC only/)
    } finally {
      stderr.mockRestore()
    }
    expect(rpcCalls).toHaveLength(0)
  })
})
