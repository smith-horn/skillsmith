/**
 * @fileoverview The two named user-client getters for the private registry
 * @module @skillsmith/mcp-server/tools/registry-tools.live.auth
 * @see SMI-5822: a team's shared license key identifies a team, not a person
 * @see SMI-5882: red-team assessment — member/admin privilege escalation on this table
 * @see SMI-5905 Wave 3: `getUserClient()` split into two explicitly-named getters
 *
 * ONE FILE, TWO NAMES, NO DEFAULT.
 *
 * Until SMI-5905 Wave 3 this was a single `getUserClient()` in `registry-tools.live.ts`, used only
 * by `setDeprecated()`. Adding a member-level content read needed a second variant, and the first
 * design gave the existing function a defaulted `requiresAdmin: boolean` (default `true`, so no
 * existing call site changed behavior). Cross-provider plan review (finding #6) rejected that: a
 * defaulted authorization boolean is default-preserving today and silently wrong the first time
 * someone adds a call site and omits it — the failure is invisible at the call site, which is
 * exactly where an authorization decision must be visible. Two names cannot be omitted or
 * defaulted, so the wrong choice has to be written out deliberately to happen at all.
 *
 * They are kept together, in their own module, so the difference between them is readable side by
 * side rather than 300 lines apart in the service file — and so `registry-tools.live.ts` and
 * `registry-tools.live.content.ts` can each import the one they need without importing each other.
 *
 * Neither getter falls back to the service-role client when no user is signed in. That fallback
 * would restore precisely the SMI-5822 escalation this path exists to remove, so both throw an
 * actionable "run `skillsmith login`" error instead.
 */

import { getSupabaseUserClient } from '../supabase-client.js'
import { resolveUserAccessToken } from './team-resolver.js'
import { accessTokenSubject } from './registry-tools.live.audit.js'
import type { MinimalSupabaseClient } from './registry-tools.live.js'

/** A user-bound client plus the identity that client presents, for the audit trail. */
export interface UserClientBinding {
  client: MinimalSupabaseClient
  /** JWT `sub` — the principal RLS evaluates. Null when the token is not decodable. */
  actorUserId: string | null
  /**
   * Which getter produced this binding. Recorded in the audit row (`auth_role`) so "no call site
   * uses the wrong getter" is observable in production, not only asserted in a unit test.
   */
  role: 'admin' | 'member'
}

/**
 * Shared body of {@link getAdminUserClient} and {@link getMemberUserClient}.
 *
 * Deliberately NOT exported, and deliberately NOT reachable with a defaulted `role` — every caller
 * goes through one of the two named wrappers below. A defaulted `requiresAdmin: boolean` was the
 * original design here and was rejected in cross-provider plan review (finding #6) as a durable
 * authorization footgun: default-preserving today, silently wrong the first time someone adds a
 * call site and omits the argument. Two names cannot be omitted.
 *
 * Throws an actionable error rather than silently falling back to the service-role client — a
 * fallback would restore exactly the SMI-5822 escalation this path exists to remove.
 *
 * Returns the token's subject alongside the client so the audit trail can name the principal that
 * actually authorized the call. Without it, these rows were attributed to the license key, which
 * did not (cross-provider review finding #3).
 */
/**
 * The "Failed to X" clause for `bindUserClient`'s catch branch below.
 *
 * `Failed to ${operation} skill` reads naturally for `publish`/`deprecate`/`undeprecate`/`install`
 * — each names a verb that takes "skill" as its object. It does NOT for the three SMI-5949 Wave 2
 * review-gate operations (adversarial-review nit): `submissions` is a plural noun, not a verb
 * ("Failed to submissions skill" does not parse), and `approve`/`reject` act on one specific
 * pending submission (a skillId@version awaiting review), not "the skill" as a whole — "Failed to
 * approve skill" misleadingly reads as approving the entire skill rather than one version's
 * review. Special-cased here rather than accepting the ungrammatical/misleading default for these
 * three known operation names.
 */
function describeClientBindFailure(operation: string): string {
  switch (operation) {
    case 'submissions':
      return 'Failed to list private-registry submissions'
    case 'approve':
    case 'reject':
      return `Failed to ${operation} submission`
    default:
      return `Failed to ${operation} skill`
  }
}

async function bindUserClient(
  role: 'admin' | 'member',
  operation: string,
  noUserMessage: string
): Promise<UserClientBinding> {
  const token = await resolveUserAccessToken()
  if (!token) throw new Error(noUserMessage)
  try {
    const client = (await getSupabaseUserClient(token)) as MinimalSupabaseClient
    return { client, actorUserId: accessTokenSubject(token), role }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    throw new Error(`${describeClientBindFailure(operation)}: ${message}`)
  }
}

/**
 * A user-bound client for ADMIN-gated operations (`deprecate`/`undeprecate`).
 *
 * Behavior is byte-for-byte what the single `getUserClient()` did before SMI-5905 Wave 3, error
 * string included — the only change is the name. RLS
 * (`private_registry_skills_admin_update`) is still the authorization decision; this getter just
 * makes sure a real person's token is what reaches it.
 */
export async function getAdminUserClient(operation: string): Promise<UserClientBinding> {
  return bindUserClient(
    'admin',
    operation,
    `Only team admins can ${operation} a private-registry skill, so this operation needs a ` +
      'signed-in user — a shared team license key identifies a team, not a person. ' +
      'Run `skillsmith login` on this machine and retry.'
  )
}

/**
 * A user-bound client for MEMBER-level operations — `getContent()` (SMI-5905 Wave 3) and
 * `publish()` (SMI-5949 Wave 2 Step 2, D-7).
 *
 * `private_registry_skills_member_read` / `_member_insert` already grant any team member the row
 * / the insert, so this is NOT an admin gate and must not claim to be one — the error message
 * below says so explicitly (plan-review finding H5), precisely because it would otherwise be easy
 * to mistake for {@link getAdminUserClient}'s "only team admins" message, which is factually wrong
 * for a member-level operation like publish. It exists because the operation still has to run as
 * a *person*: the shared license key resolves a team, so a service-role call here would (for
 * `getContent`) hand a team's packaged content to anyone holding the key regardless of whether
 * they are still a member, and (for `publish`) leave `published_by` NULL — unrecoverable for D-6's
 * self-approval check, which needs a real submitter to compare against.
 *
 * Unchanged by SMI-6622 round 6 (its message stays in scope for SMI-6649, not this fix) — see
 * {@link tryBindMemberUserClient} below for the probe-safe variant that fix added.
 */
export async function getMemberUserClient(operation: string): Promise<UserClientBinding> {
  return bindUserClient(
    'member',
    operation,
    `A private-registry ${operation} runs as you, not as your team's shared license key — a ` +
      'license key identifies a team, not a person, so it cannot prove you are still a member. ' +
      'Any team member can do this once signed in — it does not require a team admin. ' +
      'Run `skillsmith login` on this machine and retry.'
  )
}

/** Why {@link tryBindMemberUserClient} could not produce a binding — a closed enum, never text. */
export type ProbeBindFailureReason = 'not_signed_in' | 'token_unavailable' | 'client_unavailable'

export type ProbeBindResult =
  | { ok: true; binding: UserClientBinding }
  | { ok: false; reason: ProbeBindFailureReason }

/**
 * Probe-safe member-client binder (SMI-6622 round 6 PR-07) — the ONLY caller is
 * `registry-tools.membership-check.ts`'s `probeTeamMembership()`, which must never see upstream
 * error text (a keychain/token-store failure, a Supabase client-construction error) in any form,
 * message included. Resolves `resolveUserAccessToken()` EXACTLY ONCE, inside a `try`, so the probe
 * no longer makes a second, duplicate resolution call the way it did when it checked the token
 * itself before also calling {@link getMemberUserClient} (round 5) — that duplicated keychain/
 * refresh work and left a window where the credential could change between the two reads.
 *
 * Never throws; every failure returns a `reason`, never a message. `getMemberUserClient()` above
 * is UNCHANGED — its message text is SMI-6649 scope, not this fix.
 */
export async function tryBindMemberUserClient(): Promise<ProbeBindResult> {
  let token: string | null
  try {
    token = await resolveUserAccessToken()
  } catch {
    // `resolveFreshAccessToken()` (packages/core) can reject — a token-store/keychain read or a
    // refresh-endpoint call failing — with upstream text; never read here.
    return { ok: false, reason: 'token_unavailable' }
  }
  if (!token) return { ok: false, reason: 'not_signed_in' }
  try {
    const client = (await getSupabaseUserClient(token)) as MinimalSupabaseClient
    return { ok: true, binding: { client, actorUserId: accessTokenSubject(token), role: 'member' } }
  } catch {
    // A token existed, so this is client CONSTRUCTION failing (an invalid URL, the test-time prod
    // guard in supabase-client.ts, etc.) — not an auth problem, so the caller must not advise
    // logging in for it. Its message is never read here either.
    return { ok: false, reason: 'client_unavailable' }
  }
}
