/**
 * @fileoverview The two named user-client getters for RBAC administration
 * @module @skillsmith/mcp-server/tools/rbac-tools.live.auth
 * @see SMI-6203 (Wave 2 of SMI-6200): live RBAC service, on the caller's own JWT
 * @see SMI-6202 (Wave 1): `has_team_permission()` / `set_team_member_role()` — the gates
 * @see SMI-5905 Wave 3 / `registry-tools.live.auth.ts`: the precedent this file follows
 *
 * ONE FILE, TWO NAMES, NO DEFAULT.
 *
 * This mirrors `registry-tools.live.auth.ts` deliberately, including its central constraint: no
 * getter here takes a defaulted authorization argument. That file records a cross-provider
 * plan-review finding that rejected a defaulted `requiresAdmin: boolean` because "a defaulted
 * authorization boolean is default-preserving today and silently wrong the first time someone adds
 * a call site and omits it — the failure is invisible at the call site, which is exactly where an
 * authorization decision must be visible." Two names cannot be omitted or defaulted.
 *
 * WHY A JWT AND NOT THE TEAM LICENSE KEY.
 *
 * A shared team license key identifies a TEAM, not a PERSON: `resolve_team_from_license` is
 * `(p_license_key TEXT) RETURNS TEXT` and never reads `team_members`, and the key it resolves is
 * the single row the checkout webhook created for the purchaser and then shared with the whole
 * team. So it can name the buyer, and never the caller. Every RBAC operation asks a question only
 * a person can answer — *may YOU change who holds `registry:approve` on this team?* — so a
 * credential that cannot name a person can never authorize one. Concretely: `has_team_permission()`
 * resolves `auth.uid()` against `team_members`, and `set_team_member_role()`'s owner-anchored gates
 * compare the CALLER's own row against the target's. Under a service-role or license-key client
 * `auth.uid()` is NULL, every one of those gates fails closed, and the operation is unauthorizable
 * rather than merely unauthorized.
 *
 * Neither getter falls back to the service-role client when nobody is signed in. Such a fallback
 * would move the RBAC decision out of the database and into application code — the exact
 * silent-drift risk ADR-116's own documented cost names ("if a future contributor forgets a
 * `team_id` filter, it is silent"), and the last place to accept it is the surface that decides who
 * may administer permissions. Both throw an actionable "run `skillsmith login`" error instead.
 *
 * WHY TWO GETTERS WHEN ONLY ONE OPERATION CLASS WRITES.
 *
 * Every write (`set_team_role_permission` / `reset_team_role_permission` / `set_team_member_role`)
 * and the full-matrix read (`get_effective_team_permissions`) are gated on `team:manage_rbac`.
 * `rbac_assign_role action:'list_assignments'` is not: it reads the roster through
 * `list_team_members_with_profile()`, whose only gate is "are you a member of this team"
 * (`20260521000001:58-64`). Routing that read through the manage-gated getter would compile and
 * work, and would then tell a plain member "you need the team:manage_rbac permission" for an
 * operation that never required it — the precise inaccuracy `getMemberUserClient()`'s own header
 * calls out (plan-review finding H5). Two getters, two accurate refusals.
 *
 * NOTE ON THE NAMES: neither is called `getAdminUserClient`. The gate is the `team:manage_rbac`
 * PERMISSION, not the `admin` role — a member holding an explicit allow grant legitimately passes
 * it, and an admin under a deny grant legitimately does not. Naming these after a role would
 * describe the default matrix rather than the rule, and would be wrong for exactly the
 * configurations this feature exists to make possible.
 */

import { getSupabaseUserClient } from '../supabase-client.js'
import { resolveUserAccessToken } from './team-resolver.js'
import { accessTokenSubject } from './registry-tools.live.audit.js'

/**
 * THE TWO GRANT-WRITE RPCs THIS MODULE'S CALLERS NEED (SQL not yet written — sketched here so the
 * shape is decided once, by the design pass, rather than improvised by whoever writes it).
 *
 * Wave 1's migration states the constraint they satisfy: "Writes go ONLY through a future Wave-2
 * SECURITY DEFINER RPC, never a direct-table RLS policy" — and it backs that up by revoking
 * INSERT/UPDATE/DELETE/TRUNCATE on `team_permission_grants` from `anon` and `authenticated`
 * outright. So there is no direct-table option to fall back on.
 *
 * ```sql
 * set_team_role_permission(
 *   p_team_id TEXT, p_role TEXT, p_permission TEXT, p_effect TEXT
 * ) RETURNS VOID
 *
 * reset_team_role_permission(
 *   p_team_id TEXT, p_role TEXT, p_permission TEXT
 * ) RETURNS BOOLEAN   -- TRUE if a grant row existed and was removed; idempotent, never raises
 * ```
 *
 * Both `SECURITY DEFINER`, `SET search_path = public, pg_temp` — the same guard shape as every
 * other function in the Wave 1 migration. Two names, not one function with a nullable `p_effect`
 * meaning "reset": a nullable argument that silently changes the operation is the same class of
 * footgun as the defaulted authorization boolean this file's header rejects.
 *
 * Gate order, mirroring `set_team_member_role()`'s exactly (its own gates were rewritten twice in
 * adversarial review; copying the FINAL shape is the point):
 *
 *  1. `p_role IN ('admin','member')` / `p_permission IN (<the four>)` / `p_effect IN
 *     ('allow','deny')` → `22023`. Validated in the function so a bad input is a typed refusal,
 *     not the table CHECK's raw `23514` after a partial batch.
 *  2. Team must exist → raise the SAME `permission_denied` / `42501` as gate 3, never a distinct
 *     not-found code (migration fix L1: a distinct code is a cross-tenant existence oracle).
 *  3. `IF NOT has_team_permission(p_team_id, 'team:manage_rbac') THEN RAISE ... 42501`.
 *  4. Owner-anchored META-PERMISSION gate: only a caller whose own `team_members.role` is `owner`
 *     may write or clear a row for EITHER meta-permission — `team:manage_rbac` OR
 *     `team:manage_sso`. Both carry the identical owner-only default in the plan's design table
 *     (owner ✓ / admin ✗ / member ✗), and delegating either is the owner's decision alone.
 *
 *     ADVERSARIAL-REVIEW CORRECTION (SMI-6203 security round). This spec originally scoped the
 *     gate to `team:manage_rbac` alone, reasoning that it is the self-referential one and that an
 *     elevated `team:manage_rbac` holder is therefore trusted with everything else. That is wrong
 *     for `team:manage_sso` specifically, for three reasons the migration's own header records in
 *     full: (a) `team:manage_sso` gates IdP registration and domain claims, so a non-owner who
 *     can grant it to themselves can authenticate AS the owner and take the authority the gate
 *     was protecting — the escalation chain the original scoping claimed to prevent, reached in
 *     two hops instead of one; (b) grants have no sub-scope, so an owner could not express
 *     "configure registry:* but not SSO" even deliberately, and an explicit `team:manage_sso`
 *     deny row could be overwritten by the very holder it was meant to constrain — making "full
 *     trust" the only expressible shape rather than a chosen one; (c) `set_team_member_role()`'s
 *     own F-2 gate already treats *gaining `team:manage_sso` off a `team:manage_rbac`-only grant*
 *     as self-escalation, so leaving the grant-write path open contradicted the adjacent surface.
 *  5. No self-widening (the F-2 mirror): only an `owner`- or `admin`-role caller may write
 *     `p_effect = 'allow'`. A `member`-role caller — reachable only via an explicit
 *     `team:manage_rbac` allow grant — may still read the matrix and remove grants, but not add an
 *     allow; otherwise a single party hands their own role permissions the default matrix denies
 *     it, which is exactly the self-escalation `set_team_member_role()`'s promotion gate closed.
 *     NULL-closed, mirroring F-2's own form: the caller's role is read in a separate statement
 *     from gate 3, so a caller removed from the team in between reads NULL, and a `= 'member'`
 *     test would not fire — failing open.
 *  6. `INSERT ... ON CONFLICT (team_id, role, permission) DO UPDATE SET effect, created_by,
 *     created_at`, with `created_by = auth.uid()`. Then one `audit_logs` row per call
 *     (`event_type = 'rbac:set_role_permission'` / `'rbac:reset_role_permission'`), same as
 *     `set_team_member_role()` writes — an RBAC change with no audit row is the one change class
 *     an Enterprise customer will always be asked to produce.
 *
 * `REVOKE ALL ... FROM PUBLIC` then `GRANT EXECUTE ... TO authenticated, service_role` on both,
 * matching all five Wave 1 functions and keeping the `anon`-holds-no-EXECUTE smoke assertion in
 * `20260729000001` true.
 */

/**
 * The Supabase surface RBAC needs: RPC only.
 *
 * Deliberately narrower than `registry-tools.live.ts`'s `MinimalSupabaseClient` (which also carries
 * `from()`). Every RBAC read and write goes through a `SECURITY DEFINER` function — Wave 1's
 * migration grants no client role INSERT/UPDATE/DELETE on `team_permission_grants` at all and
 * states that "writes go ONLY through a future Wave-2 SECURITY DEFINER RPC, never a direct-table
 * RLS policy". A client type without `from()` makes that structural instead of conventional: a
 * future direct-table write does not compile here.
 */
export interface RbacRpcResult<T> {
  data: T | null
  error: { message?: string; code?: string; details?: string; hint?: string } | null
}

export interface RbacSupabaseClient {
  rpc: <T>(fn: string, params?: Record<string, unknown>) => Promise<RbacRpcResult<T>>
}

/** A user-bound client plus the identity that client presents, for the audit trail. */
export interface RbacUserClientBinding {
  client: RbacSupabaseClient
  /** JWT `sub` — the principal `auth.uid()` resolves to. Null when the token is not decodable. */
  actorUserId: string | null
  /**
   * Which getter produced this binding. Recorded on the audit row so "no call site uses the wrong
   * getter" is observable in production, not only asserted in a unit test.
   * - `manage_rbac`: the operation is gated on the `team:manage_rbac` permission.
   * - `team_member`: the operation is gated on team membership only.
   */
  gate: 'manage_rbac' | 'team_member'
}

/**
 * Shared body of {@link getRbacManageUserClient} and {@link getRbacReadUserClient}.
 *
 * Deliberately NOT exported, and deliberately not reachable with a defaulted gate — every caller
 * goes through one of the two named wrappers below.
 */
async function bindUserClient(
  gate: 'manage_rbac' | 'team_member',
  operation: string,
  noUserMessage: string
): Promise<RbacUserClientBinding> {
  const token = await resolveUserAccessToken()
  if (!token) throw new Error(noUserMessage)
  try {
    const client = (await getSupabaseUserClient(token)) as RbacSupabaseClient
    return { client, actorUserId: accessTokenSubject(token), gate }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    throw new Error(`Failed to ${operation}: ${message}`)
  }
}

/**
 * A user-bound client for operations the database gates on `team:manage_rbac` — the full
 * permission matrix (`get_effective_team_permissions`), both grant writes, and every role change.
 *
 * The permission check itself is NOT re-implemented here. `has_team_permission()` already composes
 * owner-exemption, deny-wins and the default matrix inside every one of those functions; re-checking
 * it in TypeScript would duplicate a policy that already exists and can silently drift from it.
 * This getter's entire job is making sure a real person's token is what reaches that check.
 *
 * @param operation - a verb phrase for the failure message, e.g. `'read team permissions'`
 */
export async function getRbacManageUserClient(operation: string): Promise<RbacUserClientBinding> {
  return bindUserClient(
    'manage_rbac',
    operation,
    `Managing team roles and permissions requires the "team:manage_rbac" permission, which is ` +
      'checked against your own account — so this operation needs a signed-in user. A shared ' +
      'team license key identifies a team, not a person, and can never authorize a role or ' +
      'permission change. Run `skillsmith login` on this machine and retry.'
  )
}

/**
 * A user-bound client for the membership-gated roster read (`list_team_members_with_profile`),
 * which backs `rbac_assign_role action:'list_assignments'`.
 *
 * This is NOT a `team:manage_rbac` gate and must not claim to be one: any team member may read the
 * roster. It still runs as a person, because the RPC's gate is "is `auth.uid()` a member of this
 * team" — a license key would resolve the team while proving nothing about whether the caller is
 * still in it, which is precisely the check being made.
 */
export async function getRbacReadUserClient(operation: string): Promise<RbacUserClientBinding> {
  return bindUserClient(
    'team_member',
    operation,
    `Listing team members runs as you, not as your team's shared license key — a license key ` +
      'identifies a team, not a person, so it cannot prove you are still a member. Any team ' +
      'member can do this once signed in — it does not require the "team:manage_rbac" ' +
      'permission. Run `skillsmith login` on this machine and retry.'
  )
}
