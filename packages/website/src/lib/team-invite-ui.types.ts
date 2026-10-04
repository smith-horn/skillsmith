/**
 * Shared types for the team-members / team-invite UI wiring.
 * @module lib/team-invite-ui.types
 *
 * Split out of `team-invite-ui.ts` (SMI-6636 Wave 1a) when that file crossed the
 * 500-line pre-commit gate. Types rather than helpers, matching the existing
 * `auth-callback-handler.types.ts` sibling convention in this directory. These
 * are consumed by `members.astro` as well as by the UI module, so a types file
 * is the honest home for them regardless of the line count that forced the split.
 */

/**
 * Row shape returned by `list_team_members_with_profile(p_team_id)` RPC
 * (SMI-4294 follow-up). Flat columns — no nested `profiles:` object — because
 * the RPC is SECURITY DEFINER and reads `profiles` itself, bypassing the
 * profiles RLS that filtered out non-self rows in the previous PostgREST join.
 */
export interface TeamMemberRow {
  member_id: string
  user_id: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string | null
  invited_at: string | null
  full_name: string | null
  email: string | null
  /** SMI-5589. `null` resolves to `identity_unlinked` (warn) in the compliance check. */
  github_username: string | null
  /**
   * SMI-6205 (Wave 4). How this row was provisioned. `NOT NULL DEFAULT
   * 'manual'` at the `team_members` table level with a CHECK-enforced enum
   * (`20260827000000_team_permission_grants.sql:828-829`), so this is a
   * closed union like `role` above, not a nullable string. `'sso'`-
   * provisioned rows are the ones an IdP group-claim change can promote,
   * demote, or expire; `'invite'`/`'billing'`-provisioned rows keep the
   * role their team admin gave them even if the member also authenticates
   * via SSO.
   */
  provisioned_via: 'invite' | 'billing' | 'sso' | 'manual'
  /**
   * SMI-6205 (Wave 4). When the identity provider itself last actually
   * authenticated this user — stamped from the JWT's own `amr` timestamp
   * (`record_sso_login()`), not wall-clock time at RPC-call time. `null`
   * for a member who has never signed in via SSO.
   */
  sso_verified_at: string | null
}

/**
 * The viewer's role + auth id, used to decide whether to render per-row
 * Remove buttons. Resolved at page-load time from
 * `check_team_tier_access` (role) + `supabase.auth.getUser()` (user_id).
 */
export interface Viewer {
  role: 'owner' | 'admin' | 'member'
  userId: string | null
  /**
   * SMI-6241 Wave 3. Resolved once per page load via the caller-scoped
   * `has_team_permission(teamId, 'team:manage_members')` RPC — the real
   * permission-system source of truth for the remove/edit gates below,
   * rather than the `role` literal above (which stays on the interface for
   * display purposes: role badges, the invite-role default, etc.).
   *
   * SMI-6653 (Wave 1a) gave this a second consumer: the Pending Invites
   * section is gated on it, because the `team_invitations` SELECT policy now
   * admits only managers. Without that gate a plain member's UI degrades to
   * "No pending invites." — `listPending` swallows its error and returns [] —
   * which asserts something false to someone who simply cannot see.
   */
  canManageMembers: boolean
}
