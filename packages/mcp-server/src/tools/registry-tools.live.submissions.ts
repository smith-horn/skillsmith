/**
 * @fileoverview Metadata-only read-back of `pending` private-registry rows via the
 * `get_private_registry_submissions` RPC (ADR-129, SMI-5949 D-5)
 * @module @skillsmith/mcp-server/tools/registry-tools.live.submissions
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * Split out of `registry-tools.live.ts` to keep that file under CLAUDE.md's <500-line guidance
 * (the established `.live.auth.ts`/`.live.audit.ts`/`.live.content.ts` companion-module
 * convention) — used today only by `publish()`'s D-4(c) read-back, and structured so Wave 2 Step
 * 4's `submissions` action (a thin wrapper over the same RPC, no filtering) can share the row type
 * and the RPC name without duplicating either.
 *
 * WHY THIS RPC EXISTS AT ALL (D-4(a)/(c)).
 *
 * The D-4 RLS policy hides a `pending`/`rejected` row from every plain SELECT — including from its
 * own submitter — so `publish()` cannot use `INSERT … RETURNING` to confirm what it just wrote
 * (empirically confirmed against staging: an `authenticated` INSERT without `.select()` succeeds
 * and the row lands; the identical insert WITH `.select().single()` instead raises `"new row
 * violates row-level security policy"` and the whole write rolls back). `get_private_registry_
 * submissions(p_team_id, p_status)` is a `SECURITY DEFINER` function whose `RETURNS TABLE` column
 * list has **no `content` column at all** — pending content is unreachable by construction, not by
 * an omitted predicate (D-4(c)) — and it authorizes a caller to see a non-approved row only when
 * `published_by = auth.uid()` or the caller is a team admin, which is exactly what `publish()`'s
 * own submitter satisfies.
 */

import type { RegistrySkill } from './registry-tools.js'
import type { MinimalSupabaseClient } from './registry-tools.live.js'

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
