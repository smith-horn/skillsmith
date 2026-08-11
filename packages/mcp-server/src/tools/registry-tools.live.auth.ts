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
