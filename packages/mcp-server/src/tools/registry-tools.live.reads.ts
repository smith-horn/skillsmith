/**
 * @fileoverview `list()`/`get()` read predicates for the live private registry
 * @module @skillsmith/mcp-server/tools/registry-tools.live.reads
 * @see SMI-5949 Wave 3: `deprecated` read-filter closure
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * Split out of `registry-tools.live.ts` (499/500 lines before this wave) — the established
 * `.live.auth.ts`/`.live.audit.ts`/`.live.content.ts`/`.live.submissions.ts` companion-module
 * convention. Holds `listSkills()`/`getSkill()`, the two read paths that must carry an explicit,
 * mandatory in-query predicate for every column RLS does not enforce on the credential they run
 * as (ADR-116's "tenant isolation is enforced here" invariant, which SMI-5949 Wave 2 already
 * extended once to `approval_status = 'approved'`, D-4 surfaces 3/4). At the time this comment was
 * first written, that credential was service-role; as of SMI-6109 it's the caller's own member
 * JWT, bound by `registry-tools.live.member-reads.ts`'s `auditedList()`/`auditedGet()` wrappers
 * (the actual callers — `registry-tools.live.ts` no longer calls into this file directly). The
 * in-query predicate requirement itself is unchanged by that credential switch: RLS alone still
 * isn't enough here, because a caller can belong to multiple teams and RLS does not scope
 * `deprecated` at all (see below) — this module's mandatory filters are what actually enforce
 * both, regardless of which client executes the query.
 *
 * **What Wave 3 adds**: `deprecated = FALSE`. Unlike `approval_status`, `deprecated` was NEVER
 * enforced anywhere on read — not even on the RLS-protected surfaces (`getSkillContent()`, the
 * Edge Function), because RLS's `private_registry_skills_member_read` policy only ever scoped
 * `team_id` (and, since Wave 2, `approval_status`) — never `deprecated`. The plan doc's Context
 * section names this precisely: `deprecated` was documented ("hidden from search") and messaged
 * (`private_registry_manage(action:'deprecate')`'s response text) as hiding a skill, while no read
 * path actually filtered on it. This module closes that gap for `list`/`get`;
 * `registry-tools.live.content.ts` and the Edge Function close it for their own two surfaces
 * separately, since neither imports from here.
 *
 * `listSkills()` gains an explicit `includeDeprecated` opt-in — so a team admin can still see what
 * they deprecated — deliberately NOT extended to `getSkill()`. See `getSkill()`'s own doc comment
 * for why the asymmetry is intentional, not an inconsistency.
 *
 * Imports from `registry-tools.live.ts` are TYPE-ONLY, mirroring `registry-tools.live.content.ts`'s
 * own convention: `registry-tools.live.member-reads.ts` imports `listSkills`/`getSkill` from here
 * at runtime, so a value import back to `.live.ts` would be a real cycle.
 */

import { REGISTRY_METADATA_COLUMNS, REGISTRY_TABLE } from './registry-tools.content.types.js'
import type { RegistrySkill } from './registry-tools.js'
import type { MinimalSupabaseClient, PrivateRegistrySkillRow } from './registry-tools.live.js'

const TABLE = REGISTRY_TABLE
const METADATA_COLUMNS = REGISTRY_METADATA_COLUMNS

/**
 * PostgREST's code for "no rows" (or >1 row) via `.single()` — a real absence, not a failure.
 * Duplicated from `registry-tools.live.ts`'s own copy (used there by `setDeprecated()`'s probe)
 * rather than imported, to avoid the value-import cycle this file's header explains; three lines,
 * same convention, both call sites keep it private to their own module.
 */
function isNoRowsError(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST116'
}

function mapRow(teamId: string, row: PrivateRegistrySkillRow): RegistrySkill {
  return {
    skillId: row.skill_id,
    version: row.version,
    description: row.description,
    deprecated: row.deprecated,
    publishedAt: row.published_at,
    publishedBy: row.published_by ?? 'unknown',
    registryUrl: `https://registry.skillsmith.app/private/${teamId}/${row.skill_id}@${row.version}`,
    approvalStatus: row.approval_status,
    approvalMode: row.approval_mode,
  }
}

/**
 * D-4 surface 3 + SMI-5949 Wave 3: list every approved version for a team, excluding deprecated
 * ones unless `includeDeprecated` is true.
 *
 * `includeDeprecated` is the Wave 3 admin opt-in named in the plan's What Changes §4 ("an explicit
 * `includeDeprecated` opt-in ... so an admin can still see what they deprecated"). It is deliberately
 * unauthenticated at this layer: `list()`'s whole transport is the service-role/license-key path
 * (`getClient()`, `registry-tools.live.ts`) which carries no caller identity at all — the same
 * license key every team member shares — so there is no `auth.uid()` here to check a role against.
 * The plan's own wording never says the flag itself is access-controlled, only that it exists so an
 * admin CAN use it; restricting it further would be a new authorization surface this Wave does not
 * scope.
 */
export async function listSkills(
  client: MinimalSupabaseClient,
  teamId: string,
  version?: string,
  includeDeprecated?: boolean
): Promise<RegistrySkill[]> {
  let query = client
    .from<PrivateRegistrySkillRow>(TABLE)
    .select(METADATA_COLUMNS)
    .eq('team_id', teamId)
    // D-4 surface 3: service-role bypasses the RLS policy that would otherwise hide non-approved
    // rows, so this predicate is the explicit, mandatory in-query equivalent — same invariant as
    // the team_id filter above (ADR-116).
    .eq('approval_status', 'approved')
  if (!includeDeprecated) {
    // SMI-5949 Wave 3: closes the read-filter gap the plan's "precedent warning" names —
    // `deprecated` was documented as hiding a skill but no read path enforced it. Skipped only on
    // this one explicit, per-call opt-in.
    query = query.eq('deprecated', false)
  }
  if (version) query = query.eq('version', version)
  const resp = await query
  if (resp.error) {
    throw new Error(`Failed to list registry skills: ${resp.error.message ?? 'unknown error'}`)
  }
  return (resp.data ?? []).map((row) => mapRow(teamId, row))
}

/**
 * D-4 surface 4 + SMI-5949 Wave 3: get one (pinned-version branch) or the latest (no-version
 * branch) approved, non-deprecated version.
 *
 * Deliberately carries **no** `includeDeprecated` opt-in, unlike `listSkills()` above — the plan's
 * Wave 3 section states the opt-in only on `list`, singular ("Includes the includeDeprecated
 * opt-in on list"), and does not extend it to `get`. This is not an oversight or a "should be
 * symmetric" gap: `get`/`install` back the real install path (`getContent()` mirrors this same
 * version-selection logic and also carries no opt-in, `registry-tools.live.content.ts`), where a
 * caller resolving a specific `skillId`/version must never have that resolution silently include a
 * deprecated row just because it asked for it by exact key — that would make deprecation
 * inconsistently reversible per read surface, which is exactly the kind of half-enforced status
 * flag this Wave exists to eliminate. An admin who wants to SEE a deprecated version uses
 * `list({includeDeprecated:true})`; there is no deprecated-aware `get`.
 */
export async function getSkill(
  client: MinimalSupabaseClient,
  teamId: string,
  skillId: string,
  version?: string
): Promise<RegistrySkill | null> {
  if (version) {
    const resp = await client
      .from<PrivateRegistrySkillRow>(TABLE)
      .select(METADATA_COLUMNS)
      .eq('team_id', teamId)
      .eq('skill_id', skillId)
      .eq('version', version)
      // D-4 surface 4 (pinned-version branch) — see listSkills()'s comment above.
      .eq('approval_status', 'approved')
      // SMI-5949 Wave 3 — no includeDeprecated opt-in on get(), see this function's doc comment.
      .eq('deprecated', false)
      .single()
    if (resp.error) {
      if (isNoRowsError(resp.error)) return null
      throw new Error(`Failed to get registry skill: ${resp.error.message ?? 'unknown error'}`)
    }
    if (!resp.data) return null
    return mapRow(teamId, resp.data)
  }
  // No version specified — return the most recently published APPROVED, non-deprecated version. A
  // pending, rejected, or deprecated version must never resolve here even when it is the most
  // recent by published_at — D-4 surface 4 (latest-version branch) + SMI-5949 Wave 3.
  const resp = await client
    .from<PrivateRegistrySkillRow>(TABLE)
    .select(METADATA_COLUMNS)
    .eq('team_id', teamId)
    .eq('skill_id', skillId)
    .eq('approval_status', 'approved')
    .eq('deprecated', false)
  if (resp.error) {
    throw new Error(`Failed to get registry skill: ${resp.error.message ?? 'unknown error'}`)
  }
  if (!resp.data || resp.data.length === 0) return null
  const latest = resp.data.reduce((a, b) => (a.published_at >= b.published_at ? a : b))
  return mapRow(teamId, latest)
}
