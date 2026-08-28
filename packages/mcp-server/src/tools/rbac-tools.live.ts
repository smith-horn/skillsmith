/**
 * @fileoverview Live Supabase-backed RBACService
 * @module @skillsmith/mcp-server/tools/rbac-tools.live
 * @see SMI-6203 (Wave 2 of SMI-6200): live RBAC service on the caller's own JWT
 * @see SMI-6202 Wave 1: `team_permission_grants` + the five resolver/read functions
 *      (`supabase/migrations/20260827000000_team_permission_grants.sql`)
 * @see SMI-6242: `default_role_permission()` security fix — see `rbac-tools.types.ts`'s
 *      `DEFAULT_ROLE_PERMISSIONS` header for the full rationale
 * @see `registry-tools.live.ts` / `registry-tools.live.submissions.ts`'s `reviewSubmission()`:
 *      the `.rpc()` call + error-handling + `resp.data`/`resp.error` shape this file copies
 *
 * Mirrors `registry-tools.live.ts`'s `createLiveRegistryService()` factory shape: one function
 * returning an object literal implementing the service interface (`RBACService`), each method a
 * thin `.rpc()` call plus mapping. Every RBAC decision lives in the database — `has_team_permission()`
 * inside each RPC composes owner-exemption, deny-wins-over-allow, and the default matrix; this file
 * never re-implements or re-checks any of that. Its entire job is making sure the RIGHT credential
 * (the caller's own JWT, via one of the two named getters in `rbac-tools.live.auth.ts`) reaches the
 * right RPC, and that the RPC's response is mapped into this module's domain types.
 *
 * TWO GETTERS, NOT ONE (`rbac-tools.live.auth.ts`): every method here that reads or writes the
 * permission matrix or a role (`listPermissions`, `setRolePermission`, `resetRolePermission`,
 * `setMemberRole`) uses `getRbacManageUserClient()` — the database gates all four on
 * `team:manage_rbac`. `listMembers` uses `getRbacReadUserClient()` instead: `list_team_members_with_
 * profile()`'s only gate is team membership (`20260521000001:58-64` / `20260708205437:246-252`), and
 * routing it through the manage-gated getter would tell a plain member "you need team:manage_rbac"
 * for an operation that never required it.
 *
 * NO CLIENT-SIDE AUDIT WRITE. Unlike `registry-tools.live.ts` (which calls `recordRegistryAudit()`
 * at this layer because the underlying tables/RPCs it wraps do not audit themselves), every RPC this
 * file calls — `set_team_role_permission`, `reset_team_role_permission` (both added in this same
 * Wave, `20260828000000_rbac_grant_writes.sql`), and `set_team_member_role` (Wave 1) — already writes
 * its own `audit_logs` row inside the SAME transaction as the write, non-fatally on audit failure.
 * Adding a second, TypeScript-side audit write here would duplicate that trail rather than
 * strengthen it. `listPermissions` / `listMembers` are reads and were never audited at either layer
 * in Wave 1 or Wave 2 — consistent with `get_effective_team_permissions()` and
 * `list_team_members_with_profile()` themselves not writing `audit_logs`.
 *
 * ERROR SHAPE: on `resp.error`, every method throws via {@link rpcError}, which carries the
 * PostgREST error's SQLSTATE across as `.code` alongside the message. The tool layer's
 * `toToolError()` (`rbac-tools.ts`) then maps a real `42501` (via `toPermissionDeniedError()`) to
 * the structured `PermissionDeniedError`, recognizing both the generic `permission_denied` sentence
 * and the authored owner-anchored/self-widening refusals (`team-permission-error.ts`'s
 * `PASSTHROUGH_REFUSALS`); anything else surfaces as a plain string error. This file does not need
 * to distinguish the two cases itself — but it MUST NOT drop the code, which is why `rpcError`
 * exists rather than a bare `new Error(resp.error.message)`. See its own doc comment.
 */

import { getRbacManageUserClient, getRbacReadUserClient } from './rbac-tools.live.auth.js'
import type {
  EffectivePermission,
  GrantableRole,
  PermissionEffect,
  PermissionSource,
  RBACService,
  TeamMemberAssignment,
  TeamMemberRole,
  TeamPermission,
} from './rbac-tools.types.js'

/** An `Error` that still carries the SQLSTATE the database refused with. */
interface RpcError extends Error {
  code?: string
}

/**
 * Turn a PostgREST `resp.error` into a thrown `Error` WITHOUT losing its SQLSTATE.
 *
 * ADVERSARIAL-REVIEW FIX (SMI-6203 security round, High). Every method here previously threw
 * `new Error(resp.error.message ?? '<fallback>')`, dropping `resp.error.code` on the floor. That
 * had two consequences, both invisible in stub-mode tests because the stub throws
 * `TeamPermissionDeniedError` directly and never travels this path:
 *
 *  1. `toPermissionDeniedError()` decides `isDenial` from `code === '42501'` (or a message that is
 *     exactly `permission_denied`). With the code dropped, the five authored refusals — whose
 *     messages are authored sentences, not `permission_denied` — were classified as NOT denials at
 *     all. So live callers got a plain string `error` where stub callers got the structured
 *     `{ code: 'permission_denied', permission, message }`, and the whole `PASSTHROUGH_REFUSALS`
 *     allowlist (including this PR's own two additions) was unreachable in production.
 *  2. Worse, the same path leaked. A `42501` raised by POSTGRES itself — `permission denied for
 *     table team_permission_grants`, which names internal schema objects — also failed the
 *     `isDenial` test, so `toToolError()` fell through to `err.message` and surfaced that internal
 *     text verbatim to the customer. That is precisely the leak `team-permission-error.ts`'s
 *     module header says the allowlist exists to prevent; the allowlist was correct, but nothing
 *     ever reached it.
 *
 * Carrying `code` across restores both properties: authored refusals render as authored copy, and
 * any other `42501` falls back to the generic sentence instead of the raw Postgres message.
 */
function rpcError(error: { message?: string; code?: string } | null, fallback: string): RpcError {
  const err = new Error(error?.message ?? fallback) as RpcError
  if (typeof error?.code === 'string') err.code = error.code
  return err
}

/** Row shape returned by `get_effective_team_permissions(p_team_id)` (Wave 1, Section 7). */
interface EffectivePermissionRow {
  role: string
  permission: string
  effect: string
  source: string
}

/**
 * `role`/`permission`/`effect`/`source` are trusted verbatim from the RPC's own `RETURNS TABLE`
 * shape — the database is the single source of truth for these enums (the `team_permission_grants`
 * CHECK constraints and the RPC's own fixed `unnest(ARRAY[...])` cross product), so this mapping
 * does not re-validate them, mirroring `mapSubmissionRow()`'s trust-the-RPC convention
 * (`registry-tools.live.submissions.ts`).
 */
function mapEffectivePermissionRow(row: EffectivePermissionRow): EffectivePermission {
  return {
    role: row.role as GrantableRole,
    permission: row.permission as TeamPermission,
    effect: row.effect as PermissionEffect,
    source: row.source as PermissionSource,
  }
}

/**
 * Row shape returned by `list_team_members_with_profile(p_team_id)` — 8 columns as of
 * `20260708205437_team_members_set_github_username_rpc.sql:228-238` (adds `github_username` to the
 * original 7-column `20260521000001` shape). `github_username` has no home in
 * {@link TeamMemberAssignment} and is intentionally dropped by the mapping below — this service
 * type predates that column and Wave 2 did not extend it.
 */
interface TeamMemberProfileRow {
  member_id: string
  user_id: string
  role: string
  joined_at: string | null
  invited_at: string | null
  full_name: string | null
  email: string | null
  github_username: string | null
}

function mapTeamMemberRow(row: TeamMemberProfileRow): TeamMemberAssignment {
  return {
    memberId: row.member_id,
    userId: row.user_id,
    role: row.role as TeamMemberRole,
    fullName: row.full_name,
    email: row.email,
    joinedAt: row.joined_at,
    invitedAt: row.invited_at,
  }
}

/**
 * Create a live Supabase-backed RBACService. Every method resolves a user-bound client via one of
 * `rbac-tools.live.auth.ts`'s two named getters, calls exactly one RPC, and maps the result — the
 * authorization decision is made entirely inside the RPC, never re-implemented here.
 */
export function createLiveRBACService(): RBACService {
  return {
    // RPC self-gates on team:manage_rbac (Wave 1, Section 7) — let a refusal propagate to the
    // tool layer's toPermissionDeniedError() mapping rather than re-checking it here.
    async listPermissions(teamId): Promise<EffectivePermission[]> {
      const { client } = await getRbacManageUserClient('read team permissions')
      const resp = await client.rpc<EffectivePermissionRow[]>('get_effective_team_permissions', {
        p_team_id: teamId,
      })
      if (resp.error) {
        throw rpcError(resp.error, 'Failed to read team permissions.')
      }
      return (resp.data ?? []).map(mapEffectivePermissionRow)
    },

    // set_team_role_permission RETURNS VOID (20260828000000_rbac_grant_writes.sql, Section 2) —
    // resp.data carries nothing meaningful; only resp.error matters.
    async setRolePermission(teamId, role, permission, effect): Promise<void> {
      const { client } = await getRbacManageUserClient('set a role permission')
      const resp = await client.rpc<null>('set_team_role_permission', {
        p_team_id: teamId,
        p_role: role,
        p_permission: permission,
        p_effect: effect,
      })
      if (resp.error) {
        throw rpcError(resp.error, 'Failed to set the role permission.')
      }
    },

    // reset_team_role_permission RETURNS BOOLEAN, never raises for "nothing to clear"
    // (20260828000000_rbac_grant_writes.sql, Section 3) — resp.data IS the answer.
    async resetRolePermission(teamId, role, permission): Promise<boolean> {
      const { client } = await getRbacManageUserClient('reset a role permission')
      const resp = await client.rpc<boolean>('reset_team_role_permission', {
        p_team_id: teamId,
        p_role: role,
        p_permission: permission,
      })
      if (resp.error) {
        throw rpcError(resp.error, 'Failed to reset the role permission.')
      }
      if (resp.data === null) {
        throw new Error(
          'reset_team_role_permission reported success but returned no value — this should ' +
            'not happen; retry or check with a team admin.'
        )
      }
      return resp.data
    },

    // MEMBER getter, deliberately — list_team_members_with_profile's only gate is team
    // membership, not team:manage_rbac. See this file's header.
    async listMembers(teamId): Promise<TeamMemberAssignment[]> {
      const { client } = await getRbacReadUserClient('list team members')
      const resp = await client.rpc<TeamMemberProfileRow[]>('list_team_members_with_profile', {
        p_team_id: teamId,
      })
      if (resp.error) {
        throw rpcError(resp.error, 'Failed to list team members.')
      }
      return (resp.data ?? []).map(mapTeamMemberRow)
    },

    // set_team_member_role RETURNS VOID (Wave 1, Section 8) — no .select() needed.
    async setMemberRole(memberId, role): Promise<void> {
      const { client } = await getRbacManageUserClient("change a member's role")
      const resp = await client.rpc<null>('set_team_member_role', {
        p_member_id: memberId,
        p_role: role,
      })
      if (resp.error) {
        throw rpcError(resp.error, "Failed to change the member's role.")
      }
    },
  }
}
