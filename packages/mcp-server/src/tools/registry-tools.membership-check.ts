/**
 * @fileoverview Confirms — or refuses to guess at — signed-in-user team membership (SMI-6622 round
 * 2 finding 3; error-bearing verdict added round 4 PR-07; verdict re-derived to carry no free text
 * round 5 PR-07)
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
 * PR-07 round 4: the ORIGINAL version of this module folded every failure mode — not signed in, a
 * network/transport error, a non-PGRST116 query error — into an `'unknown'` verdict that its only
 * wrapper then mapped to `null`, exactly as it did for a confirmed member, so a network outage or
 * expired JWT looked identical to a genuinely empty registry (`success:true, skills:[]`). Round 4
 * added a distinct `'probe_failed'` verdict carrying the raw error TEXT.
 *
 * PR-07 round 5 (second consecutive finding on this surface, so it was re-derived rather than
 * patched): round 4's `error: string` field copied PostgREST `error.message` or a thrown
 * exception's `.message` into the MCP tool result, and nothing stopped credential text in that
 * string from reaching the caller. Redacting free text was rejected; the module now has no path by
 * which external text reaches its result:
 *
 * - The `probe_failed` variant carries only a closed-enum `reason` and, for `query_error`, an
 *   optional `code` that must match {@link SAFE_ERROR_CODE_PATTERN} or is dropped.
 * - {@link probeFailedMessage} returns fixed, authored text per `reason`.
 * - No code path here reads an exception's or a query error's `.message`, and nothing is logged.
 *
 * Guarantee (this module only): every string it returns is authored in this file, plus a validated
 * short error code. Other registry call sites still forward upstream error text; that class is
 * tracked in SMI-6649.
 *
 * Every caller MUST branch on `'probe_failed'` explicitly rather than treating a missing/falsy
 * result as "safe to proceed" — see {@link membershipOverrideError}'s own doc comment for the two
 * call-site shapes this module supports (list/namespace's "never succeed on an unresolved probe"
 * vs. publish's "an already-failed RLS denial keeps its own message when the probe itself can't
 * run").
 */

import { getMemberUserClient } from './registry-tools.live.auth.js'
import { resolveUserAccessToken } from './team-resolver.js'
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

/**
 * Allow-pattern for a `query_error`'s PostgREST/Postgres error CODE (never its message — that field
 * is never read at all). Real codes are short, uppercase-alnum tokens: a Postgres SQLSTATE is
 * exactly 5 characters from `[0-9A-Z]` (e.g. `42501` insufficient_privilege, `08006`
 * connection_failure); PostgREST's own codes are `PGRST` + digits (e.g. `PGRST301`, 8 characters).
 * `{2,10}` comfortably covers both with margin and rejects anything shaped like a JWT (lowercase +
 * `.` + far longer), an `sk_live_`-style API key (lowercase + `_`), a license key, or any other
 * hostile value a misbehaving driver might place in this field — tested against a case table
 * including all of those (round 5 report). A code that fails this pattern is silently dropped, not
 * surfaced in any form.
 */
const SAFE_ERROR_CODE_PATTERN = /^[A-Z0-9]{2,10}$/

function safeErrorCode(code: string | undefined): string | undefined {
  return code !== undefined && SAFE_ERROR_CODE_PATTERN.test(code) ? code : undefined
}

/** Why the probe could not determine membership either way — a closed enum, never free text. */
export type ProbeFailureReason =
  | 'not_signed_in'
  | 'client_unavailable'
  | 'query_error'
  | 'transport_error'

export type MembershipVerdict = 'member' | 'not_member' | 'probe_failed'

export type MembershipProbeResult =
  | { verdict: 'member' }
  | { verdict: 'not_member' }
  | {
      verdict: 'probe_failed'
      reason: ProbeFailureReason
      /** Present ONLY for `reason === 'query_error'`, and ONLY when it passed
       *  {@link SAFE_ERROR_CODE_PATTERN} — never raw error text. */
      code?: string
    }

/**
 * Probe whether the signed-in user (their own JWT, via `getMemberUserClient`) can see the resolved
 * team's own row — the same boundary `private_registry_skills_member_read`'s policy already draws.
 * Three DISTINCT outcomes, all real: `'member'` (row visible), `'not_member'` (a clean PGRST116 —
 * the row genuinely exists per `resolve_team_from_license`, so a caller-scoped miss here means RLS
 * is hiding it), and `'probe_failed'` (the probe simply could not answer the question, for one of
 * four closed-enum reasons — see {@link ProbeFailureReason}). `'probe_failed'` is never silently
 * folded into either real answer — see this file's header for why that was the round-4 bug, and for
 * why round 5 replaced its free-text `error` field with a closed enum plus a validated code.
 *
 * `resolveUserAccessToken()` is checked directly FIRST (the same function `getMemberUserClient`'s
 * own `bindUserClient` calls internally) so a signed-out caller is classified before any client is
 * even constructed — `getMemberUserClient()` is still called when a token exists (its own internal
 * `resolveUserAccessToken()` call is therefore redundant in that case, not a second decision point;
 * confirmed no test asserts a specific call count on it).
 */
export async function probeTeamMembership(teamId: string): Promise<MembershipProbeResult> {
  const token = await resolveUserAccessToken()
  if (!token) return { verdict: 'probe_failed', reason: 'not_signed_in' }

  let client: MinimalTeamsClient
  try {
    const binding = await getMemberUserClient('membership check')
    client = binding.client as unknown as MinimalTeamsClient
  } catch {
    // A token existed, so this is NOT the not-signed-in path above — it's `getSupabaseUserClient()`
    // itself failing to bind (per `bindUserClient`'s own catch in registry-tools.live.auth.ts). The
    // thrown message is deliberately never read here.
    return { verdict: 'probe_failed', reason: 'client_unavailable' }
  }

  try {
    const resp = await client.from<TeamsRow>('teams').select('id').eq('id', teamId).single()
    if (!resp.error) return { verdict: 'member' }
    if (resp.error.code === NO_ROWS_CODE) return { verdict: 'not_member' }
    return { verdict: 'probe_failed', reason: 'query_error', code: safeErrorCode(resp.error.code) }
  } catch {
    // A network/transport exception from the query itself. Its message is deliberately never read.
    return { verdict: 'probe_failed', reason: 'transport_error' }
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
 * The actionable message when the probe itself could not determine membership either way — FIXED,
 * AUTHORED text only, one per {@link ProbeFailureReason}, with `code` appended only for
 * `query_error` and only after it already passed {@link SAFE_ERROR_CODE_PATTERN}. Never reads or
 * forwards any exception/`error.message` text (round 5 PR-07 — see this file's header).
 */
export function probeFailedMessage(reason: ProbeFailureReason, code?: string): string {
  switch (reason) {
    case 'not_signed_in':
      return (
        'Unable to verify your team membership: you are not signed in. ' +
        'Run `skillsmith login` on this machine and retry.'
      )
    case 'client_unavailable':
      return (
        'Unable to verify your team membership: your session could not be used to check ' +
        'membership. Run `skillsmith login` on this machine and retry.'
      )
    case 'query_error': {
      const safeCode = safeErrorCode(code)
      return (
        'Unable to verify your team membership: the membership check itself failed' +
        (safeCode ? ` (code ${safeCode})` : '') +
        '. Try again, and contact support if this persists.'
      )
    }
    case 'transport_error':
      return (
        'Unable to verify your team membership: a network error interrupted the check. ' +
        'Try again, and contact support if this persists.'
      )
  }
}

/**
 * Narrow wrapper: returns an actionable message ONLY for a POSITIVELY CONFIRMED non-member —
 * `null` for both `'member'` and `'probe_failed'`. Used by `registry-tools.ts`'s `publish` catch
 * block, which is ALREADY on a `{success:false}` path (an RLS insert denial) by the time it calls
 * this — round 4 PR-07 fix: that existing, already-specific RLS error message must keep standing
 * when the probe can't run, not be replaced by a less specific "could not verify membership"
 * message layered on top of an operation that had already failed for its own, already-clear
 * reason. Only a POSITIVE non-member confirmation is worth replacing it for. Unchanged by round 5.
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
  if (probe.verdict === 'probe_failed') return probeFailedMessage(probe.reason, probe.code)
  return null
}
