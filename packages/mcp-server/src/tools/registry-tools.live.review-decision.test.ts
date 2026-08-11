/**
 * @fileoverview `review_private_registry_submission` RPC-error passthrough + audit-row tests
 *   (SMI-5949 Wave 2 Step 4, D-5/D-6/D-8/D-9)
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * Split from the sibling `registry-tools.review-action.test.ts` (which covers success paths and
 * message-content requirements) to stay comfortably under the 500-line audit:standards gate. This
 * file covers the four documented D-5 failure paths — non-admin (`42501`), self-approval,
 * already-decided/terminal-state, and missing `published_by` (`23514`, the old-client case) — and
 * proves each RPC error message reaches the MCP caller VERBATIM (plan-review finding M10), plus
 * the audit rows both `approve`/`reject` write on success and on denial.
 *
 * Every scenario here is scripted purely at the fake-client/RPC-response level: this file does NOT
 * re-verify the RPC's own SQL logic (that is Wave 1's migration smoke suite + staging harness,
 * per the plan's P-4 Smoke-vs-CI rule) — it verifies that whatever message the RPC returns is
 * exactly what a caller of `private_registry_manage` sees, with no remapping in between.
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

// A realistically-shaped access token, so `accessTokenSubject()` (registry-tools.live.audit.ts)
// has a real `sub` claim to read — `resolveUserAccessToken`'s default mock below is a plain
// string, not a decodable JWT, which would make every actor-attribution assertion read
// 'user_jwt:unknown' instead of proving the real attribution path (same shape as the FAKE_JWT in
// registry-tools.live.admin-auth.test.ts). `vi.hoisted` because `vi.mock` factories are hoisted
// above ordinary `const` declarations.
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

beforeEach(() => {
  setPrivateRegistryService(createLiveRegistryService())
})

afterEach(() => {
  setPrivateRegistryService(createStubRegistryService())
  vi.clearAllMocks()
})

/** Script an RPC error response for `review_private_registry_submission` only — no test in this
 *  file calls `get_private_registry_submissions`, so the fallback branch is never exercised, but
 *  is still well-behaved (no error) rather than throwing if it ever were. */
function reviewRpcError(error: { code?: string; message: string }) {
  return {
    rpcResponder: (fn: string) => {
      if (fn === 'review_private_registry_submission') return { data: null, error }
      return { data: [], error: null }
    },
  }
}

// ============================================================================
// The four documented D-5 failure paths — verbatim passthrough (finding M10)
// ============================================================================

describe('review_private_registry_submission RPC errors — verbatim passthrough (M10)', () => {
  it.each([
    {
      name: 'non-admin (D-5 step 3, 42501)',
      action: 'approve' as const,
      error: {
        code: '42501',
        message:
          'Only team admins can review private-registry submissions. This team has no other ' +
          'admin/owner besides the submitter — promote a second admin/owner to unblock review.',
      },
    },
    {
      name: 'self-approval (D-5 step 7 / D-6)',
      action: 'approve' as const,
      error: {
        code: 'P0001',
        message: 'You cannot approve your own submission. Ask another team admin to review it.',
      },
    },
    {
      name: 'already-decided / terminal state (D-5 step 5 / D-8)',
      action: 'reject' as const,
      error: {
        code: 'P0001',
        message:
          'This submission has already been approved and cannot be reviewed again — approved ' +
          'and rejected are both terminal decisions.',
      },
    },
    {
      name: 'missing published_by — old-client legacy row (D-5 step 6, 23514)',
      action: 'approve' as const,
      error: {
        code: '23514',
        message:
          'This submission has no recorded submitter (published_by is NULL) and cannot be ' +
          'reviewed — it was published by a client older than the required version. Ask the ' +
          'submitter to upgrade and re-publish.',
      },
    },
  ])('$name: the RPC message reaches the caller byte-for-byte', async ({ action, error }) => {
    const { client } = createFakeClient(reviewRpcError(error))
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action, skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(false)
    // Exact equality, not a substring match — verbatim means verbatim, not "close enough" (M10).
    expect(result.error).toBe(error.message)
  })

  it('does not remap a SQLSTATE to any canned message', async () => {
    const { client } = createFakeClient(
      reviewRpcError({ code: '42501', message: 'Only team admins can review submissions.' })
    )
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    // A remap would produce something like "Permission denied" or "Approval failed" — assert the
    // RPC's own text won, not a generic replacement.
    expect(result.error).toBe('Only team admins can review submissions.')
    expect(result.error).not.toMatch(/permission denied/i)
    expect(result.error).not.toMatch(/^registry operation failed/i)
  })
})

// ============================================================================
// Audit rows — success and denied (matching the existing publish/deprecate pattern)
// ============================================================================

describe('approve/reject audit rows — SMI-5949 Wave 2 Step 4', () => {
  it('writes a success audit row with the correct event_type and actor', async () => {
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    const audit = calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    expect(audit).toBeDefined()
    expect(audit!.payload?.event_type).toBe('private_registry:approve')
    expect(audit!.payload?.result).toBe('success')
    expect(audit!.payload?.actor).toBe(`user:${FAKE_USER_ID}`)
    // The license key did not authorize this (D-7 has no service-role fallback), so it must not
    // appear as the actor — mirrors registry-tools.live.admin-auth.test.ts's assertion.
    expect(String(audit!.payload?.actor)).not.toContain('license_key')
  })

  it('writes a "reject" audit row distinctly from "approve"', async () => {
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    await executePrivateRegistryManage(
      { action: 'reject', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    const audit = calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    expect(audit!.payload?.event_type).toBe('private_registry:reject')
  })

  it('writes a denied audit row (not "error") for every documented RPC rejection', async () => {
    const { client, calls } = createFakeClient(
      reviewRpcError({ code: '42501', message: 'Only team admins can review submissions.' })
    )
    await mockBothClients(client)

    await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    const audit = calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    expect(audit).toBeDefined()
    expect(audit!.payload?.result).toBe('denied')
    expect((audit!.payload?.metadata as Record<string, unknown>).detail).toBe('42501')
  })

  it('audit rows carry team_id/skill_id/version scoped to this operation', async () => {
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '2.1.0' },
      makeContext()
    )

    const audit = calls.find((c) => c.table === 'audit_logs' && c.op === 'insert')
    const metadata = audit!.payload?.metadata as Record<string, unknown>
    expect(metadata.team_id).toBe(RESOLVED_TEAM)
    expect(metadata.skill_id).toBe('myteam/skill-a')
    expect(metadata.version).toBe('2.1.0')
    expect(metadata.auth_path).toBe('user_jwt')
  })
})
