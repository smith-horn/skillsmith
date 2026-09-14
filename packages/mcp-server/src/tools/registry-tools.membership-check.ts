/**
 * @fileoverview Confirms — or refuses to guess at — signed-in-user team membership (SMI-6622 round
 * 2 finding 3)
 * @module @skillsmith/mcp-server/tools/registry-tools.membership-check
 * @see registry-tools.live.ts's own header comment ("A license-key-team-vs-logged-in-user-
 *      membership mismatch..."): an empty `list`, a null `namespace`, and an RLS-denied `publish`
 *      insert are all indistinguishable, from the caller's point of view, from "the signed-in user
 *      simply is not on the team the license key/API key resolved" — RLS fails closed on a
 *      mismatch exactly the same way it fails closed on genuine absence, by design.
 *
 * This module runs ONE extra, best-effort read — a member-JWT `SELECT id FROM teams WHERE id =
 * <resolved teamId>` — ONLY on that already-ambiguous path, to turn a silent, confusing
 * empty/not-found/denied result into an actionable "you are not a member of the team resolved from
 * <source>" error when (and only when) membership can be POSITIVELY ruled out. It changes no RLS
 * policy and adds no new grant — `teams` SELECT is already member-scoped; this reads the exact
 * boundary that policy already draws, the same way `registry-tools.live.member-reads.ts`'s
 * `auditedGetNamespace()` already does for its own narrower purpose.
 *
 * Fails inconclusive (`'unknown'`), never a false membership claim, on anything but a clean
 * PGRST116 ("no rows") response: not signed in, a network/transport error, or any other query
 * failure all mean "the original ambiguous result must stand unmodified" — this module must never
 * be the reason a genuine outage gets misreported as "you're not on this team."
 */

import { getMemberUserClient } from './registry-tools.live.auth.js'
import { describeCredentialSource, type RegistryCredentialSource } from './registry-tools.team.js'

interface TeamsRow {
  id: string
}

interface MinimalTeamsClient {
  from<T>(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: unknown
      ): {
        single(): PromiseLike<{ data: T | null; error: { code?: string } | null }>
      }
    }
  }
}

/** PostgREST's "no rows" code via `.single()` — same constant every sibling module (e.g.
 *  registry-tools.live.member-reads.ts's isNoRowsError()) checks independently, by convention. */
const NO_ROWS_CODE = 'PGRST116'

export type MembershipVerdict = 'member' | 'not_member' | 'unknown'

/**
 * Probe whether the signed-in user (their own JWT, via `getMemberUserClient`) can see the resolved
 * team's own row — the same boundary `private_registry_skills_member_read`'s policy already draws.
 * `'not_member'` is the ONLY verdict this function will act on to change a result; `'unknown'`
 * covers every other outcome (not signed in, network/transport failure, a non-PGRST116 query
 * error) and must be treated as "say nothing," not as either membership answer.
 */
export async function probeTeamMembership(teamId: string): Promise<MembershipVerdict> {
  try {
    const { client } = await getMemberUserClient('membership check')
    const resp = await (client as unknown as MinimalTeamsClient)
      .from<TeamsRow>('teams')
      .select('id')
      .eq('id', teamId)
      .single()
    if (!resp.error) return 'member'
    return resp.error.code === NO_ROWS_CODE ? 'not_member' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * The actionable message for a POSITIVELY CONFIRMED non-member — never constructed for
 * `'unknown'`. Names the credential source (finding 3) so the caller knows which configured
 * credential resolved a team they are not on.
 */
export function nonMemberMessage(source: RegistryCredentialSource): string {
  return (
    `Your account is not a member of the team resolved from ${describeCredentialSource(source)}. ` +
    'Ask a team admin to add you, or configure a credential for a team you already belong to.'
  )
}

/**
 * Run the membership probe and return the actionable message ONLY when membership is positively
 * ruled out (`'not_member'`) — `null` for `'member'` or `'unknown'`, meaning the caller's original
 * ambiguous result/error must stand unmodified. Convenience wrapper around
 * {@link probeTeamMembership} + {@link nonMemberMessage} for the three call sites in
 * registry-tools.ts.
 */
export async function confirmedNonMemberMessage(
  teamId: string,
  source: RegistryCredentialSource
): Promise<string | null> {
  const verdict = await probeTeamMembership(teamId)
  return verdict === 'not_member' ? nonMemberMessage(source) : null
}
