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
 * the audit rows `approve`/`reject` write on denial (and, since SMI-6114, do not write on success).
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
  AUDIT_RPC_PARAM_KEYS,
  RESOLVED_TEAM,
  auditRpcCalls,
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
const { FAKE_JWT } = vi.hoisted(() => {
  const userId = '11111111-2222-3333-4444-555555555555'
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return {
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

// readLicenseKey is kept — registry-tools.live.audit.ts still calls it directly for the audit
// row's masked-credential metadata. resolveLicenseTeamId is dropped: registry-tools.ts no longer
// calls it (SMI-6622 — see the registry-tools.team.js mock below).
vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveUserAccessToken: vi.fn(async () => FAKE_JWT),
}))

// SMI-6622: registry-tools.ts's resolveTeamId() now delegates to registry-tools.team.js, not
// team-resolver.js's resolveLicenseTeamId.
// importOriginal + spread (SMI-6622 round 2) — see registry-tools.install-action.test.ts's
// identical comment for why (a future new export never needs re-adding to every mock).
vi.mock('./registry-tools.team.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry-tools.team.js')>()
  return {
    ...actual,
    resolveRegistryTeamId: vi.fn(async () => ({
      teamId: 'team-alpha',
      source: 'env:SKILLSMITH_LICENSE_KEY',
    })),
    readRegistryCredential: vi.fn(() => 'sk_test_fake_license'),
  }
})

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
        // SMI-6202 widened the RPC's own RAISE text from "only a team admin or owner may
        // review ..." to also name an explicit registry:approve grant as a path to review —
        // verbatim from migrations/20260827000001_rbac_seam_widening.sql:165-169 (`%`
        // substituted for `p_team_id`). This file proves verbatim passthrough, not fidelity to
        // the RPC's real text (see this file's own header), so any distinctive fixture text
        // exercises the same code path either way — updated here purely so a reader searching
        // for the real message string finds a match, not a stale pre-SMI-6202 paraphrase.
        message:
          'only a team admin or owner, or a holder of an explicit registry:approve grant, may ' +
          'review ' +
          'private-registry submissions for team team-alpha. If this team has exactly one ' +
          'admin and that admin is also the submitter, nothing can be approved until a second ' +
          'admin or owner exists -- promote one in team_members (self-approval is refused, see ' +
          'below).',
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
// Audit rows. SMI-6114: a SUCCESSFUL approve/reject writes no client-side row — the RPC's UPDATE
// fires trg_prs_audit, which records the decision in the same transaction (pinned against a real
// Postgres in scripts/tests/private-registry-audit-trigger.test.ts). This client still records the
// attempts that did not commit.
// ============================================================================

describe('approve/reject audit rows — SMI-5949 Wave 2 Step 4, SMI-6114', () => {
  it.each(['approve', 'reject'] as const)(
    'a successful %s writes no client-side audit row (the trigger owns it)',
    async (action) => {
      const { client, calls, rpcCalls } = createFakeClient()
      await mockBothClients(client)
      const { getSupabaseAdminClient } = await import('../supabase-client.js')

      const result = await executePrivateRegistryManage(
        { action, skillId: 'myteam/skill-a', version: '1.0.0' },
        makeContext()
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.table === 'audit_logs')).toBe(false)
      expect(auditRpcCalls(rpcCalls)).toHaveLength(0)
      expect(vi.mocked(getSupabaseAdminClient)).not.toHaveBeenCalled()
    }
  )

  it('attributes a denied review to the JWT user, never to the license key', async () => {
    const { client, rpcCalls } = createFakeClient(
      reviewRpcError({ code: '42501', message: 'Only team admins can review submissions.' })
    )
    await mockBothClients(client)

    await executePrivateRegistryManage(
      { action: 'reject', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    // ADR-178: the actor is derived by the RPC from auth.uid(), so what a client can get wrong is
    // what it sends: one report on the user client, no actor-shaped parameter, no license key.
    const audit = auditRpcCalls(rpcCalls)
    expect(audit).toHaveLength(1)
    expect(audit[0].params.p_operation).toBe('reject')
    expect(Object.keys(audit[0].params).sort()).toEqual(AUDIT_RPC_PARAM_KEYS)
    expect(JSON.stringify(Object.values(audit[0].params))).not.toContain('license_key')
    expect(JSON.stringify(audit[0].params)).not.toContain('sk_test_fake_license')
    expect(String(audit[0].params.p_license_key_fingerprint)).toMatch(/^[0-9a-f]{12}$/)
  })

  it('writes a denied audit row (not "error") for every documented RPC rejection', async () => {
    const { client, rpcCalls } = createFakeClient(
      reviewRpcError({ code: '42501', message: 'Only team admins can review submissions.' })
    )
    await mockBothClients(client)

    await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    const audit = auditRpcCalls(rpcCalls)
    expect(audit).toHaveLength(1)
    expect(audit[0].params.p_result).toBe('denied')
    expect(audit[0].params.p_detail).toBe('42501')
  })

  it('audit rows carry team_id/skill_id/version scoped to this operation', async () => {
    const { client, rpcCalls } = createFakeClient(
      reviewRpcError({ code: '55000', message: 'this submission is already approved' })
    )
    await mockBothClients(client)

    await executePrivateRegistryManage(
      { action: 'approve', skillId: 'myteam/skill-a', version: '2.1.0' },
      makeContext()
    )

    // SMI-6114 untag rule is now the RPC's: it never writes a `team_id` key, and no parameter of
    // the call could ask for one. The client's part is to name the team, skill and version of THIS
    // operation, plus the member role it called with.
    const audit = auditRpcCalls(rpcCalls)
    expect(audit).toHaveLength(1)
    expect(audit[0].params).toMatchObject({
      p_operation: 'approve',
      p_team_id: RESOLVED_TEAM,
      p_skill_id: 'myteam/skill-a',
      p_version: '2.1.0',
      p_auth_role: 'member',
    })
    expect(Object.keys(audit[0].params)).not.toContain('team_id')
  })
})
