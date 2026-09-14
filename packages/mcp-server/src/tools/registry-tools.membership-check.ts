/**
 * @fileoverview Confirms — or refuses to guess at — signed-in-user team membership (SMI-6622 round
 * 2 finding 3; error-bearing verdict added round 4 PR-07)
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
 * PR-07 (round 4 adversarial review): the ORIGINAL version of this module folded every failure
 * mode — not signed in, a network/transport error, a non-PGRST116 query error — into an
 * `'unknown'` verdict that its only wrapper then mapped to `null`, exactly as it did for a
 * confirmed member. So `registry-tools.manage-action.ts`'s `list`/`namespace` cases could not
 * tell "the probe could not run" apart from "you really are on this team," and a network outage
 * or expired JWT looked identical to a genuinely empty registry (`success:true, skills:[]`). `probeTeamMembership()` below now returns a distinct
 * `'probe_failed'` verdict (carrying the underlying error) instead of folding it into `'unknown'` —
 * there is no longer an `'unknown'` verdict at all, only the three real outcomes: `'member'`,
 * `'not_member'`, and `'probe_failed'`. Every caller MUST branch on `'probe_failed'` explicitly
 * rather than treating a missing/falsy result as "safe to proceed" — see
 * {@link membershipOverrideError}'s own doc comment for the two call-site shapes this module
 * supports (list/namespace's "never succeed on an unresolved probe" vs. publish's "an already-
 * failed RLS denial keeps its own message when the probe itself can't run").
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
        single(): PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>
      }
    }
  }
}

/** PostgREST's "no rows" code via `.single()` — same constant every sibling module (e.g.
 *  registry-tools.live.member-reads.ts's isNoRowsError()) checks independently, by convention. */
const NO_ROWS_CODE = 'PGRST116'

export type MembershipVerdict = 'member' | 'not_member' | 'probe_failed'

export interface MembershipProbeResult {
  verdict: MembershipVerdict
  /** Present ONLY when verdict === 'probe_failed' — the underlying reason (never raw credential
   *  material; either `getMemberUserClient()`'s own actionable message — which already names
   *  `skillsmith login` for the not-signed-in case — or the query's transport/error message). */
  error?: string
}

/**
 * Probe whether the signed-in user (their own JWT, via `getMemberUserClient`) can see the resolved
 * team's own row — the same boundary `private_registry_skills_member_read`'s policy already draws.
 * Three DISTINCT outcomes, all real: `'member'` (row visible), `'not_member'` (a clean PGRST116 —
 * the row genuinely exists per `resolve_team_from_license`, so a caller-scoped miss here means RLS
 * is hiding it), and `'probe_failed'` (not signed in, a network/transport error, or any other query
 * error — the probe simply could not answer the question). `'probe_failed'` is never silently
 * folded into either real answer — see this file's header for why that was the round-4 bug.
 */
export async function probeTeamMembership(teamId: string): Promise<MembershipProbeResult> {
  try {
    const { client } = await getMemberUserClient('membership check')
    const resp = await (client as unknown as MinimalTeamsClient)
      .from<TeamsRow>('teams')
      .select('id')
      .eq('id', teamId)
      .single()
    if (!resp.error) return { verdict: 'member' }
    if (resp.error.code === NO_ROWS_CODE) return { verdict: 'not_member' }
    return { verdict: 'probe_failed', error: resp.error.message ?? 'unknown query error' }
  } catch (err) {
    // Covers getMemberUserClient() throwing (not signed in — its own message already points to
    // `skillsmith login` — or a client-construction failure) AND a network/transport exception
    // from the query itself.
    return {
      verdict: 'probe_failed',
      error: err instanceof Error ? err.message : 'unknown error',
    }
  }
}

/**
 * The actionable message for a POSITIVELY CONFIRMED non-member. Names the credential source
 * (finding 3) so the caller knows which configured credential resolved a team they are not on.
 */
export function nonMemberMessage(source: RegistryCredentialSource): string {
  return (
    `Your account is not a member of the team resolved from ${describeCredentialSource(source)}. ` +
    'Ask a team admin to add you, or configure a credential for a team you already belong to.'
  )
}

/**
 * The actionable message when the probe itself could not determine membership either way. Distinct
 * from {@link nonMemberMessage} — this is "we don't know," not "we know you're not on this team."
 * When `error` already names `skillsmith login` (the not-signed-in case — see
 * {@link probeTeamMembership}), that text passes through verbatim rather than being duplicated.
 */
export function probeFailedMessage(error: string): string {
  return `Unable to verify your team membership: ${error}`
}

/**
 * Narrow wrapper: returns an actionable message ONLY for a POSITIVELY CONFIRMED non-member —
 * `null` for both `'member'` and `'probe_failed'`. Used by `registry-tools.ts`'s `publish` catch
 * block, which is ALREADY on a `{success:false}` path (an RLS insert denial) by the time it calls
 * this — round 4 PR-07 fix: that existing, already-specific RLS error message must keep standing
 * when the probe can't run, not be replaced by a less specific "could not verify membership"
 * message layered on top of an operation that had already failed for its own, already-clear
 * reason. Only a POSITIVE non-member confirmation is worth replacing it for.
 */
export async function confirmedNonMemberMessage(
  teamId: string,
  source: RegistryCredentialSource
): Promise<string | null> {
  const probe = await probeTeamMembership(teamId)
  return probe.verdict === 'not_member' ? nonMemberMessage(source) : null
}

/**
 * Broad wrapper: returns an actionable message for EITHER a confirmed non-member OR a failed
 * probe — `null` only for a confirmed member. Used by `registry-tools.manage-action.ts`'s
 * `list`/`namespace` cases, whose starting point is an AMBIGUOUS but not-yet-failed result (an
 * empty list, a null namespace) — round 4 PR-07 fix: those two must never fall through to
 * `success:true` just because the probe itself failed (a network outage, an expired JWT, or any
 * other transport/query error looking identical to a genuinely empty registry was the exact bug).
 * A confirmed member is the ONLY verdict that leaves the original ambiguous-but-legitimate result
 * standing.
 */
export async function membershipOverrideError(
  teamId: string,
  source: RegistryCredentialSource
): Promise<string | null> {
  const probe = await probeTeamMembership(teamId)
  if (probe.verdict === 'not_member') return nonMemberMessage(source)
  if (probe.verdict === 'probe_failed') return probeFailedMessage(probe.error ?? 'unknown error')
  return null
}
