/**
 * @fileoverview Live-mode tests for `private_registry_manage(action:'submissions'|'approve'|
 *   'reject')` — the SMI-5949 D-5 review-gate actions
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * Exercises the live Supabase-backed service via `executePrivateRegistryManage` (the full tool
 * dispatch, mirroring `registry-tools.live.manage.test.ts`'s shape), using the shared fake-client
 * fixtures (`registry-tools.live.test-helpers.ts`), extended in this Wave to also script
 * `review_private_registry_submission` responses.
 *
 * RPC-error-shaped scenarios (self-approval, non-admin, terminal-state, missing `published_by`)
 * and audit-row assertions live in the sibling `registry-tools.live.review-decision.test.ts` —
 * split from this file to stay comfortably under the 500-line audit:standards gate. This file
 * covers: success paths for all three actions, required-field validation, the `submissions`
 * action's filtering/message shape, and the plan-review C1/H6 message-content requirements.
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

beforeEach(() => {
  setPrivateRegistryService(createLiveRegistryService())
})

afterEach(() => {
  setPrivateRegistryService(createStubRegistryService())
  vi.clearAllMocks()
})

// ============================================================================
// submissions — D-5's read side
// ============================================================================

describe('private_registry_manage submissions action — SMI-5949 D-5', () => {
  it('lists submissions via the RPC, scoped to the resolved team, with no status filter by default', async () => {
    const { client, rpcCalls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'submissions' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    expect(result.submissions).toBeDefined()
    // The dedicated field, not a reuse of `skills` (finding L3 — the two are semantically
    // distinct: submissions can include pending/rejected items, list never does).
    expect(result.skills).toBeUndefined()

    const call = rpcCalls.find((c) => c.fn === 'get_private_registry_submissions')
    expect(call).toBeDefined()
    expect(call!.params.p_team_id).toBe(RESOLVED_TEAM)
    expect(call!.params.p_status).toBeNull()
  })

  it('passes the status filter straight through to the RPC when provided', async () => {
    const { client, rpcCalls } = createFakeClient({
      rpcResponder: () => ({ data: [], error: null }),
    })
    await mockBothClients(client)

    await executePrivateRegistryManage({ action: 'submissions', status: 'pending' }, makeContext())

    const call = rpcCalls.find((c) => c.fn === 'get_private_registry_submissions')
    expect(call!.params.p_status).toBe('pending')
  })

  it('runs the RPC on the user client, never service-role (D-5 requires a real auth.uid())', async () => {
    const admin = createFakeClient()
    const user = createFakeClient()
    const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(admin.client)
    vi.mocked(getSupabaseUserClient).mockResolvedValue(user.client)

    await executePrivateRegistryManage({ action: 'submissions' }, makeContext())

    expect(getSupabaseUserClient).toHaveBeenCalled()
    expect(user.rpcCalls.some((c) => c.fn === 'get_private_registry_submissions')).toBe(true)
    expect(admin.rpcCalls.some((c) => c.fn === 'get_private_registry_submissions')).toBe(false)
  })

  it('does not write an audit row — submissions is a metadata read, like list/get', async () => {
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    await executePrivateRegistryManage({ action: 'submissions' }, makeContext())

    expect(calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')).toBeUndefined()
  })

  it('message states this is metadata only, never implying a full content read (finding C1)', async () => {
    const { client } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'submissions' }, makeContext())

    expect(result.message).toMatch(/metadata only/i)
    // Explicitly disclaims a full content read — must NOT read as "you have reviewed the
    // content", the exact confusion C1 exists to prevent.
    expect(result.message).toMatch(/not a full read of any submitted content/i)
  })

  it('surfaces the login-required error naming "any team member", not an admin-only claim', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)
    const { client } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'submissions' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/skillsmith login/i)
    expect(result.error).toMatch(/any team member/i)
    expect(result.error).not.toMatch(/only team admins/i)
  })
})

// ============================================================================
// approve / reject — D-5's write side, success paths
// ============================================================================

describe('private_registry_manage approve/reject actions — SMI-5949 D-5/D-6', () => {
  it('approve succeeds, calling the RPC with p_decision="approved" and the given skillId/version', async () => {
    const { client, rpcCalls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.review?.approvalStatus).toBe('approved')
    expect(result.review?.skillId).toBe('myteam/skill-a')
    expect(result.review?.version).toBe('1.0.0')

    const call = rpcCalls.find((c) => c.fn === 'review_private_registry_submission')
    expect(call).toBeDefined()
    expect(call!.params).toMatchObject({
      p_team_id: RESOLVED_TEAM,
      p_skill_id: 'myteam/skill-a',
      p_version: '1.0.0',
      p_decision: 'approved',
    })
  })

  it('reject succeeds, calling the RPC with p_decision="rejected"', async () => {
    const { client, rpcCalls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'reject', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.review?.approvalStatus).toBe('rejected')
    const call = rpcCalls.find((c) => c.fn === 'review_private_registry_submission')
    expect(call!.params.p_decision).toBe('rejected')
  })

  it('passes an optional note through as p_note', async () => {
    const { client, rpcCalls } = createFakeClient()
    await mockBothClients(client)

    await executePrivateRegistryManage(
      {
        action: 'approve',
        skillId: 'myteam/skill-a',
        version: '1.0.0',
        note: 'Looks good, matches the description.',
      },
      makeContext()
    )

    const call = rpcCalls.find((c) => c.fn === 'review_private_registry_submission')
    expect(call!.params.p_note).toBe('Looks good, matches the description.')
  })

  it('requires both skillId and version — neither the RPC nor a partial call is attempted', async () => {
    const { client, rpcCalls } = createFakeClient()
    await mockBothClients(client)

    const noSkillId = await executePrivateRegistryManage(
      { action: 'approve', version: '1.0.0' },
      makeContext()
    )
    const noVersion = await executePrivateRegistryManage(
      { action: 'reject', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(noSkillId.success).toBe(false)
    expect(noSkillId.error).toMatch(/skillId and version/i)
    expect(noVersion.success).toBe(false)
    expect(noVersion.error).toMatch(/skillId and version/i)
    expect(rpcCalls.some((c) => c.fn === 'review_private_registry_submission')).toBe(false)
  })

  it('runs the RPC on the user client, never service-role', async () => {
    const admin = createFakeClient()
    const user = createFakeClient()
    const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(admin.client)
    vi.mocked(getSupabaseUserClient).mockResolvedValue(user.client)

    await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(getSupabaseUserClient).toHaveBeenCalled()
    expect(user.rpcCalls.some((c) => c.fn === 'review_private_registry_submission')).toBe(true)
    expect(admin.rpcCalls.some((c) => c.fn === 'review_private_registry_submission')).toBe(false)
  })

  it('surfaces the login-required error naming "any team member", not an admin-only claim', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)
    const { client } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/skillsmith login/i)
    expect(result.error).toMatch(/any team member/i)
    // Approve genuinely IS admin-gated (by the RPC), but the tool layer's own no-credential
    // message must not pre-empt the RPC's own 42501 with a different claim (D-2 single-seam
    // discipline — see registry-tools.review-action.ts's header).
    expect(result.error).not.toMatch(/only team admins/i)
  })

  it.each([
    { action: 'approve' as const, mustMatch: /approved/i },
    { action: 'reject' as const, mustMatch: /rejected|terminal|resubmit/i },
  ])(
    '$action message explicitly disclaims a full content read (finding C1)',
    async ({ action, mustMatch }) => {
      const { client } = createFakeClient()
      await mockBothClients(client)

      const result = await executePrivateRegistryManage(
        { action, skillId: 'myteam/skill-a', version: '1.0.0' },
        makeContext()
      )

      expect(result.message).toMatch(mustMatch)
      // Must NOT read as "the reviewer saw the content" — it must say the opposite, explicitly.
      expect(result.message).toMatch(/did not include a full read of the submitted content/i)
    }
  )

  it('never prints "approvalStatus"/"approvalMode" as a bare field name (finding H6)', async () => {
    const { client } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.message).not.toMatch(/approvalStatus/)
    expect(result.message).not.toMatch(/approvalMode/)
    expect(result.message).not.toMatch(/approval_status/)
    expect(result.message).not.toMatch(/approval_mode/)
  })
})
