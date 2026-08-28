/**
 * @fileoverview SMI-6202 — `review_private_registry_submission()`'s admin-check widened from a
 *   raw `p_team_id NOT IN (SELECT user_admin_team_ids())` predicate to
 *   `NOT has_team_permission(p_team_id, 'registry:approve')`
 * @see supabase/migrations/20260827000000_team_permission_grants.sql
 * @see supabase/migrations/20260827000001_rbac_seam_widening.sql
 * @see registry-tools.live.admin-auth.test.ts — this file's SMI-5822 sibling (deprecate/
 *   undeprecate/publish credential coverage). Split out rather than appended there, to stay under
 *   the 500-line audit:standards budget — that file's own coverage was already close to it.
 *
 * These are app-layer verbatim-passthrough tests, the SAME convention already established by
 * `registry-tools.live.review-decision.test.ts`'s M10 suite: the RPC's own SQL resolution logic
 * (owner exemption, deny-wins, default-matrix fallback) is proven once, by the first migration's
 * own inline smoke block (s1-s6) and the second migration's own inline smoke block (s1-s12b,
 * s-explain) — this file only confirms `review()` forwards whatever the RPC decides, unmodified,
 * for each of the scenarios `team_permission_grants` introduces. No test anywhere in the codebase
 * previously exercised `review()` against more than the OLD admin/owner-only predicate — b1/b2/b3
 * and the cross-team case below are all genuinely new coverage, not updates to prior cases.
 *
 * Mock/fixture style deliberately mirrors registry-tools.live.admin-auth.test.ts's own local
 * `createRecorder` (a chain-based `from()` fake plus a `respond`-per-call script), extended with
 * one `rpc()` branch for `review_private_registry_submission` — not the `createFakeClient`/
 * `rpcResponder` helper from registry-tools.live.test-helpers.ts, so this suite reads as a direct
 * continuation of the admin-auth file it was split from rather than a differently-styled sibling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createLiveRegistryService } from './registry-tools.live.js'

/**
 * A realistically-shaped access token, so `accessTokenSubject()` has a real `sub` to read.
 * `vi.hoisted` because `vi.mock` factories are hoisted above ordinary `const` declarations. Same
 * shape as registry-tools.live.admin-auth.test.ts's own FAKE_USER_ID/FAKE_JWT (duplicated per
 * file, matching the existing convention — see registry-tools.live.review-decision.test.ts's
 * identical duplication for the same reason).
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
  /** Request params for an `rpc()` call recorded via the `review_private_registry_submission`
   *  branch below (`table` is set to the function name for these). */
  params?: Record<string, unknown>
}

/**
 * Recording fake, same shape as registry-tools.live.admin-auth.test.ts's own `createRecorder`,
 * extended with an `rpc('review_private_registry_submission', ...)` branch routed through the
 * SAME `respond` hook every `.then()`/`.single()` call already uses — so a test scripts an
 * allow/deny/cross-team RBAC scenario the identical way it would script any other response.
 */
function createRecorder(
  respond: (record: Recorded) => {
    data: unknown[] | null
    error: { code?: string; message?: string } | null
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
      single: async () => {
        const r = respond(record)
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      },
      then: (onFulfilled: (v: { data: unknown[] | null; error: unknown }) => unknown) =>
        Promise.resolve(onFulfilled(respond(record))),
    }
    return chain
  }
  return {
    client: {
      from: (table: string) => makeQuery(table),
      rpc: async (fn: string, params?: Record<string, unknown>) => {
        // SMI-6202: the only RPC this file's tests ever call. A `respond` that reports no error
        // gets a row synthesized from the RPC's own request params (mirrors
        // registry-tools.live.test-helpers.ts's defaultReviewRpc) rather than a hand-rolled
        // fixture; a `respond` that reports an error passes it straight through.
        if (fn === 'review_private_registry_submission') {
          const record: Recorded = { table: fn, op: 'select', filters: [], params }
          calls.push(record)
          const r = respond(record)
          if (r.error) return { data: null, error: r.error }
          if (Array.isArray(r.data) && r.data.length > 0) return { data: r.data, error: null }
          return {
            data: [
              {
                id: 'row-1',
                skill_id: params?.p_skill_id,
                version: params?.p_version,
                approval_status: params?.p_decision,
                approved_by: FAKE_USER_ID,
                approved_at: '2026-08-27T00:00:00Z',
                review_note: (params?.p_note as string | null | undefined) ?? null,
              },
            ],
            error: null,
          }
        }
        return { data: null, error: null }
      },
    },
    calls,
  }
}

async function setClients(userClient: unknown, adminClient: unknown): Promise<void> {
  const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseAdminClient).mockResolvedValue(adminClient)
  vi.mocked(getSupabaseUserClient).mockResolvedValue(userClient)
}

describe('SMI-6202 — review(): RBAC seam widening via team_permission_grants', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValue(FAKE_JWT)
  })

  // Verbatim from 20260827000001_rbac_seam_widening.sql:165-169 (`%` substituted for the team id).
  const notAdminMessage = (teamId: string): string =>
    'only a team admin or owner, or a holder of an explicit registry:approve grant, may ' +
    'review ' +
    `private-registry submissions for team ${teamId}. If this team has exactly one admin ` +
    'and that admin is also the submitter, nothing can be approved until a second admin or ' +
    'owner exists -- promote one in team_members (self-approval is refused, see below).'

  it('b1: a plain member with no grant is refused, with the widened RAISE message', async () => {
    const user = createRecorder(() => ({
      data: null,
      error: { code: '42501', message: notAdminMessage(TEAM) },
    }))
    const admin = createRecorder()
    await setClients(user.client, admin.client)

    const service = createLiveRegistryService()
    await expect(service.review(TEAM, SKILL, '1.0.0', 'approved')).rejects.toThrow(
      notAdminMessage(TEAM)
    )
  })

  it('b2: a member holding an explicit registry:approve allow grant now succeeds (new capability)', async () => {
    const user = createRecorder((record) =>
      record.table === 'review_private_registry_submission'
        ? { data: null, error: null } // no error -> rpc() synthesizes the success row
        : { data: [{ id: 'row-1' }], error: null }
    )
    const admin = createRecorder()
    await setClients(user.client, admin.client)

    const service = createLiveRegistryService()
    await expect(service.review(TEAM, SKILL, '1.0.0', 'approved')).resolves.toMatchObject({
      skillId: SKILL,
      version: '1.0.0',
      approvalStatus: 'approved',
    })
  })

  it('b3: an admin holding an explicit registry:approve deny grant is refused (deny wins)', async () => {
    // From review()'s perspective this is the identical RPC-error shape as b1 — the
    // deny-over-admin-default resolution happens entirely inside has_team_permission()
    // (20260827000000_team_permission_grants.sql's own smoke s4b proves that resolution
    // separately). What this asserts is that review() still surfaces the RPC's refusal verbatim
    // rather than special-casing "but they hold team_members.role = admin".
    const user = createRecorder(() => ({
      data: null,
      error: { code: '42501', message: notAdminMessage(TEAM) },
    }))
    const admin = createRecorder()
    await setClients(user.client, admin.client)

    const service = createLiveRegistryService()
    await expect(service.review(TEAM, SKILL, '1.0.0', 'approved')).rejects.toThrow(
      notAdminMessage(TEAM)
    )
  })

  // ADR-129 risk control: "per-team isolation must be verified with a cross-team negative test,
  // not just a happy-path test". No test anywhere in the codebase previously called review() with
  // more than one team_id, so this is new coverage, not an update to an existing case.
  it('cross-team: an admin/grant-holder on one team cannot review a submission for another team', async () => {
    const OTHER_TEAM = 'team-bravo'
    const user = createRecorder((record) => {
      if (record.table !== 'review_private_registry_submission') {
        return { data: [{ id: 'row-1' }], error: null }
      }
      // Simulates the database enforcing per-team isolation: has_team_permission() re-derives the
      // caller's role from team_members/team_permission_grants for THIS CALL's p_team_id — it
      // never caches or carries forward a resolution from a different team, so a caller who is
      // admin/grant-holder on TEAM has no standing at all on OTHER_TEAM.
      return {
        data: null,
        error: { code: '42501', message: notAdminMessage(record.params?.p_team_id as string) },
      }
    })
    const admin = createRecorder()
    await setClients(user.client, admin.client)

    const service = createLiveRegistryService()
    await expect(service.review(OTHER_TEAM, SKILL, '1.0.0', 'approved')).rejects.toThrow(
      notAdminMessage(OTHER_TEAM)
    )

    // The RPC call carries the REQUESTED team verbatim — no silent substitution of the team the
    // caller actually holds rights on, and no cross-team fallback path.
    const rpcRecord = user.calls.find((c) => c.table === 'review_private_registry_submission')
    expect(rpcRecord?.params?.p_team_id).toBe(OTHER_TEAM)
  })
})
