/**
 * @fileoverview Metadata-only read-back of `pending` private-registry rows via the
 * `get_private_registry_submissions` RPC, plus the `review_private_registry_submission`
 * decision RPC (ADR-129, SMI-5949 D-5)
 * @module @skillsmith/mcp-server/tools/registry-tools.live.submissions
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * Split out of `registry-tools.live.ts` to keep that file under CLAUDE.md's <500-line guidance
 * (the established `.live.auth.ts`/`.live.audit.ts`/`.live.content.ts` companion-module
 * convention). `readBackSubmission()` (Wave 2 Step 2) backs `publish()`'s D-4(c) read-back;
 * `listSubmissions()`/`reviewSubmission()` (Wave 2 Step 4) back the `submissions`/`approve`/
 * `reject` actions and share this file's row type and RPC name rather than duplicating either.
 *
 * WHY THESE RPCS EXIST AT ALL (D-4(a)/(c)).
 *
 * The D-4 RLS policy hides a `pending`/`rejected` row from every plain SELECT — including from its
 * own submitter — so `publish()` cannot use `INSERT … RETURNING` to confirm what it just wrote
 * (empirically confirmed against staging: an `authenticated` INSERT without `.select()` succeeds
 * and the row lands; the identical insert WITH `.select().single()` instead raises `"new row
 * violates row-level security policy"` and the whole write rolls back), and `approve`/`reject`
 * cannot be a PostgREST `UPDATE … RETURNING` for the same reason (D-4(b)). `get_private_registry_
 * submissions(p_team_id, p_status)` is a `SECURITY DEFINER` function whose `RETURNS TABLE` column
 * list has **no `content` column at all** — pending content is unreachable by construction, not by
 * an omitted predicate (D-4(c)) — and it authorizes a caller to see a non-approved row only when
 * `published_by = auth.uid()` or the caller is a team admin. `review_private_registry_submission`
 * is the paired `SECURITY DEFINER` write: it does the actual admin/self-approval/terminal-state
 * checks (D-5/D-6/D-8) inside the database, in the same transaction as the write.
 */

import type { RegistrySkill } from './registry-tools.js'
import type { RegistryReviewDecision } from './registry-tools.review.types.js'
import type { MinimalSupabaseClient } from './registry-tools.live.js'
import { recordRegistryAudit } from './registry-tools.live.audit.js'

/**
 * Row shape returned by the `get_private_registry_submissions` RPC (D-5) — metadata-only,
 * deliberately narrower than `PrivateRegistrySkillRow`: no `content` column (D-4(c)) and no
 * `deprecated`/`team_id`/`content_hash` either (not part of the RPC's `RETURNS TABLE`). Kept as
 * its own type rather than widening `PrivateRegistrySkillRow` to match, so `mapSubmissionRow()`'s
 * job — tolerating a narrower column list without throwing on the columns it does not have
 * (plan-review finding H2) — is a type-checked property, not a convention someone has to remember.
 */
export interface PrivateRegistrySubmissionRow {
  id: string
  skill_id: string
  version: string
  description: string | null
  approval_status: 'pending' | 'approved' | 'rejected'
  approval_mode: 'review' | 'auto'
  published_by: string | null
  published_at: string
  approved_by: string | null
  approved_at: string | null
  review_note: string | null
}

/**
 * Build a `RegistrySkill` from a `get_private_registry_submissions` row (D-5). Deliberately
 * separate from `registry-tools.live.ts`'s `mapRow()` rather than widening `PrivateRegistrySkillRow`
 * to match — the RPC's column list is narrower (no `content`, no `deprecated`, no `team_id`, no
 * `content_hash`), and this function must tolerate that without throwing on the columns it does
 * not have (plan-review finding H2).
 */
export function mapSubmissionRow(teamId: string, row: PrivateRegistrySubmissionRow): RegistrySkill {
  return {
    skillId: row.skill_id,
    version: row.version,
    description: row.description,
    // A row this call just inserted can never already be deprecated — deprecation is a distinct,
    // later action (deprecate()/undeprecate()) that cannot have run yet. The RPC has no
    // `deprecated` column to read (it is metadata-only, D-4(c)), so this is an honest default,
    // not a guess standing in for a real value.
    deprecated: false,
    publishedAt: row.published_at,
    publishedBy: row.published_by ?? 'unknown',
    registryUrl: `https://registry.skillsmith.app/private/${teamId}/${row.skill_id}@${row.version}`,
    approvalStatus: row.approval_status,
    approvalMode: row.approval_mode,
  }
}

/**
 * D-4(a)/(c): read a just-published row back through the metadata-only submissions RPC. See this
 * module's header for why `INSERT … RETURNING` cannot be used instead.
 *
 * `get_private_registry_submissions` has no server-side single-row lookup by key (D-5's signature
 * is `(p_team_id, p_status)` only), so the caller filters the RPC's own rows client-side by
 * `skill_id` AND `version` (plan-review finding H2).
 */
export async function readBackSubmission(
  client: MinimalSupabaseClient,
  teamId: string,
  skillId: string,
  version: string
): Promise<PrivateRegistrySubmissionRow> {
  const resp = await client.rpc<PrivateRegistrySubmissionRow[]>(
    'get_private_registry_submissions',
    { p_team_id: teamId, p_status: 'pending' }
  )
  if (resp.error) {
    throw new Error(
      `Skill ${skillId}@${version} was published, but the confirmation read-back failed: ` +
        `${resp.error.message ?? 'unknown error'}`
    )
  }
  const match = (resp.data ?? []).find((row) => row.skill_id === skillId && row.version === version)
  if (!match) {
    throw new Error(
      `Skill ${skillId}@${version} was published but could not be confirmed by read-back. It ` +
        'may still appear under private_registry_manage {action:"submissions"}.'
    )
  }
  return match
}

/**
 * SMI-5949 Wave 2 Step 4, D-5: `private_registry_manage(action:'submissions')`. A thin,
 * unfiltered wrapper over the same RPC `readBackSubmission()` uses — `p_status` passed straight
 * through (undefined -> null -> "no filter", matching the RPC's own `DEFAULT NULL`). Errors are
 * passed through VERBATIM (plan-review finding M10) — no SQLSTATE remapping.
 *
 * Note: `mapSubmissionRow()` hardcodes `deprecated: false` (see its own doc comment) because the
 * RPC has no `deprecated` column — accurate for `readBackSubmission()`'s just-inserted row, but an
 * honest limitation here too: an `approved` row that was later deprecated will still report
 * `deprecated: false` in a submissions listing. Not fixable without widening the RPC's column
 * list, which is out of this step's scope.
 */
export async function listSubmissions(
  client: MinimalSupabaseClient,
  teamId: string,
  status?: 'pending' | 'approved' | 'rejected'
): Promise<RegistrySkill[]> {
  const resp = await client.rpc<PrivateRegistrySubmissionRow[]>(
    'get_private_registry_submissions',
    {
      p_team_id: teamId,
      p_status: status ?? null,
    }
  )
  if (resp.error) {
    throw new Error(resp.error.message ?? 'Failed to list private-registry submissions.')
  }
  return (resp.data ?? []).map((row) => mapSubmissionRow(teamId, row))
}

/**
 * `review_private_registry_submission`'s own `RETURNS TABLE` shape (D-5 / the plan's PL/pgSQL
 * name-collision audit) — 6 columns, deliberately narrower than `PrivateRegistrySubmissionRow`.
 */
export interface PrivateRegistryReviewRow {
  id: string
  skill_id: string
  version: string
  approval_status: 'approved' | 'rejected'
  approved_by: string | null
  approved_at: string | null
  review_note: string | null
}

function mapReviewRow(row: PrivateRegistryReviewRow): RegistryReviewDecision {
  return {
    skillId: row.skill_id,
    version: row.version,
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    reviewNote: row.review_note,
  }
}

/**
 * SMI-5949 Wave 2 Step 4, D-5/D-6: `private_registry_manage(action:'approve'|'reject')`. Calls
 * `review_private_registry_submission` — the RPC itself does every check, in order: decision
 * value, `auth.uid()` non-null, admin-membership (`42501`), row-exists, terminal-state, non-NULL
 * `published_by` (`23514`), self-approval. On failure the RPC's `error.message` is thrown
 * VERBATIM (plan-review finding M10) — no SQLSTATE-to-canned-message remapping, which would
 * silently drop the D-9 "promote a second admin/owner" remediation text or the D-7 client-version
 * remediation text. Every documented D-5 failure is a business-rule denial, so both this
 * function's failure branches audit `result: 'denied'`.
 */
export async function reviewSubmission(params: {
  client: MinimalSupabaseClient
  teamId: string
  skillId: string
  version: string
  decision: 'approved' | 'rejected'
  note?: string
  /** JWT `sub` of the caller — recorded on the audit row, never trusted for authorization
   *  (the RPC evaluates its own `auth.uid()` from the token itself). */
  actorUserId: string | null
}): Promise<RegistryReviewDecision> {
  const { client, teamId, skillId, version, decision, note, actorUserId } = params
  const operation: 'approve' | 'reject' = decision === 'approved' ? 'approve' : 'reject'
  const resp = await client.rpc<PrivateRegistryReviewRow[]>('review_private_registry_submission', {
    p_team_id: teamId,
    p_skill_id: skillId,
    p_version: version,
    p_decision: decision,
    p_note: note ?? null,
  })
  const auditBase = {
    operation,
    teamId,
    skillId,
    version,
    authPath: 'user_jwt' as const,
    // 'member', not 'admin': this call used getMemberUserClient() (the RPC's own admin-membership
    // check, D-5 step 3, is the actual gate — see registry-tools.review-action.ts for why the tool
    // layer deliberately does not pre-empt it with an admin-only client-getter error).
    authRole: 'member' as const,
    actorUserId,
  }
  if (resp.error) {
    await recordRegistryAudit({
      ...auditBase,
      result: 'denied',
      detail: resp.error.code ?? 'rpc_error',
    })
    throw new Error(resp.error.message ?? `Failed to ${operation} submission.`)
  }
  const row = (resp.data ?? [])[0]
  if (!row) {
    await recordRegistryAudit({ ...auditBase, result: 'error', detail: 'empty_rpc_response' })
    throw new Error(
      `${operation === 'approve' ? 'Approval' : 'Rejection'} of ${skillId}@${version} reported ` +
        'success but returned no row — this should not happen; retry or check with a team admin.'
    )
  }
  await recordRegistryAudit({ ...auditBase, result: 'success' })
  return mapReviewRow(row)
}
