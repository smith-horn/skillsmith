/**
 * @fileoverview Content read for the live private registry — the MCP twin of Wave 2's Edge Function
 * @module @skillsmith/mcp-server/tools/registry-tools.live.content
 * @see SMI-5905 Wave 3: MCP tool surface — `install` action + `getContent()`
 * @see supabase/functions/private-registry-get/access.ts — the CLI-transport twin of this logic
 * @see docs/internal/implementation/private-registry-skill-install.md
 *
 * Split out of `registry-tools.live.ts` (428/500 lines before this wave) for the same reason
 * Wave 2 split `access.ts` out of its `index.ts`: the file was already near the 500-line gate, and
 * everything that decides WHETHER a caller may read a team's packaged content belongs together.
 *
 * Imports from `registry-tools.live.ts` are TYPE-ONLY, deliberately: `live.ts` imports
 * `getSkillContent` from here at runtime, so a value import back would be a real cycle.
 *
 * ============================================================================
 * METADATA LOOKUP, ENTITLEMENT, AND CONTENT ARE NOW ONE RELEASE RPC (SMI-6651 / D14)
 * ============================================================================
 * Before SMI-6651 this function ran a metadata select, a `check_registry_team_entitlement` RPC,
 * and a separate `content` select — three client-side calls over the caller's own JWT.
 * `authenticated` no longer holds table-level SELECT on `private_registry_skills` at all
 * (`20260915000000_private_registry_content_release_rpc.sql`), so a client-side `content` read is
 * no longer merely unnecessary, it is impossible.
 *
 * All three steps are now one `release_private_registry_skill_content` SECURITY DEFINER RPC call,
 * over the same member-authenticated client `getMemberUserClient()` already produced. It resolves
 * entitlement against the ROW'S OWN team — never the caller's globally denormalized
 * `profiles.tier`, which would let a caller entitled via a different team bypass a downgraded
 * team's gate (see
 * docs/internal/implementation/smi-6111-registry-content-install-entitlement-rpc.md) — and writes
 * its own `audit_logs` row for every outcome it RETURNS (`not_found`/`denied`/`released`) -- not for
 * every call: a NULL `auth.uid()` or any input-validation failure raises before the first audit
 * insert, so those calls audit nothing. `recordRegistryAudit`
 * below is reached only for outcomes the RPC itself cannot audit: the RPC call failing or
 * returning no data, an unrecognized `status`, and a `released` response with malformed content.
 * See `supabase/migrations/20260915000000_private_registry_content_release_rpc.sql` for the RPC's
 * full contract -- with one caveat. That file's own `COMMENT ON` text is SUPERSEDED: it still says
 * the RPC "audits every call" and "writes exactly one audit_logs row per call", both of which
 * overclaim for the reasons above. `20260915000001_private_registry_release_rpc_comment_fix.sql`
 * corrected them, and the LIVE catalog carries the corrected text on staging and production.
 * Migrations are immutable, so the older file keeps its original wording as a historical record --
 * read it for the RPC's LOGIC, not for its comments.
 */

import { recordRegistryAudit, type RegistryReadAuditEvent } from './registry-tools.live.audit.js'
import type { RegistrySkillContent } from './registry-tools.content.types.js'
import type { SkillContent } from './registry-tools.js'
import type { UserClientBinding } from './registry-tools.live.auth.js'

/** Audit `operation` for this path. Matches the Edge Function's `action: 'content_read'`. */
const OPERATION = 'content_read' as const

/**
 * Shape of `release_private_registry_skill_content`'s JSONB return value (SMI-6651 / D14). See
 * `supabase/migrations/20260915000000_private_registry_content_release_rpc.sql` for the
 * authoritative contract — this is a client-side echo of it, not a second source of truth.
 */
interface ReleaseRpcResult {
  status: 'not_found' | 'denied' | 'released'
  detail?: string
  skill_id?: string
  team_id?: string
  version?: string
  description?: string | null
  content_hash?: string | null
  deprecated?: boolean
  published_at?: string
  content?: SkillContent
}

export interface GetSkillContentParams {
  /** MUST come from `getMemberUserClient()` — see `registry-tools.live.ts`. */
  binding: UserClientBinding
  /** License-derived team id, used as the ADR-116 in-query tenant filter (not as entitlement). */
  teamId: string
  skillId: string
  /** Omitted → the most recently published version, mirroring this service's `get()`. */
  version?: string
}

/** Shared audit fields for every outcome of one `getContent()` call. */
function auditBase(params: GetSkillContentParams): RegistryReadAuditEvent & { result: 'error' } {
  return {
    operation: OPERATION,
    teamId: params.teamId,
    skillId: params.skillId,
    version: params.version,
    result: 'error',
    authPath: 'user_jwt',
    authRole: params.binding.role,
    actorUserId: params.binding.actorUserId,
  }
}

/**
 * Fetch one private-registry skill version's packaged content for install.
 *
 * Returns `null` when nothing visible matches (a genuine absence, or a cross-team `skillId` that
 * RLS + the tenant filter removed — the two are deliberately indistinguishable to the caller, so
 * this is never an existence oracle for another team's registry). Throws when the caller's own
 * team is no longer entitled, or on a real RPC failure: an outage must never be reported as
 * "not found".
 *
 * Version selection (an explicit `version` pins it, otherwise the MOST RECENTLY PUBLISHED version
 * wins, not the highest semver) is now entirely the RPC's own concern — see
 * `release_private_registry_skill_content`'s SQL for the exact `ORDER BY published_at DESC, id`
 * tie-break, matched to `registry-tools.live.ts`'s `get(teamId, skillId, version)` reduce so `get`
 * and `install` can never disagree about what "no version specified" means.
 */
export async function getSkillContent(
  params: GetSkillContentParams
): Promise<RegistrySkillContent | null> {
  const { binding, teamId, skillId, version } = params
  const audit = auditBase(params)

  // SMI-6651 (plan D14): metadata lookup, entitlement, and content read — all one release RPC,
  // over the caller's own member-authenticated client. `p_team_id` is the ADR-116 in-query
  // tenant filter this service has always applied — not a substitute for the RPC's own
  // membership/entitlement checks.
  const resp = await binding.client.rpc<ReleaseRpcResult>(
    'release_private_registry_skill_content',
    {
      p_skill_id: skillId,
      p_version: version ?? null,
      p_team_id: teamId,
      p_transport: 'mcp_server',
      p_request_id: null,
    }
  )

  if (resp.error) {
    // The only outcome this function still audits itself: the RPC call failing outright is a
    // transport/outage error, never a business outcome the RPC could have recorded.
    await recordRegistryAudit({ ...audit, detail: 'release_rpc_failed' })
    throw new Error(
      `Failed to read registry skill content: ${resp.error.message ?? 'unknown error'}`
    )
  }

  const result = resp.data
  if (!result) {
    // The RPC always returns jsonb; null data with no error means something broke server-side
    // (a transport/driver anomaly), never a legitimate "nothing to see here" — an outage must
    // never be reported as not-found.
    await recordRegistryAudit({ ...audit, detail: 'release_rpc_no_data' })
    throw new Error('Failed to read registry skill content: release_rpc_no_data')
  }

  if (result.status === 'not_found') {
    // No app-side audit: the RPC already wrote the `not_found` row.
    return null
  }

  if (result.status === 'denied') {
    // No app-side audit: the RPC already wrote the `denied` row.
    throw new Error(
      `Installing "${skillId}" from the private registry requires an active Enterprise ` +
        "subscription on the team that owns it, and that team's subscription is not currently " +
        'Enterprise-entitled. Contact a team admin or billing owner.'
    )
  }

  if (result.status !== 'released') {
    // Defensive: the RPC's own `status` values are a closed set. Anything else here is not a
    // business outcome the RPC could have audited, so this function must, with its own detail so
    // it can be told apart from a malformed `content` payload in `audit_logs`.
    await recordRegistryAudit({ ...audit, detail: 'release_rpc_unrecognized_status' })
    throw new Error('Failed to read registry skill content: release_rpc_unrecognized_status')
  }

  // `result.status === 'released'` from here. The RPC's own malformed-content guard withholds a
  // row unless `content` is a plain object whose every top-level value is a string, so a stored
  // `{"SKILL.md":"ok","x":123}` never arrives as `released`. (The WRITE side is weaker, and the
  // guard there is a TRIGGER, not a CHECK: `enforce_private_registry_content_hash()` requires an
  // object with a non-empty string `SKILL.md` and says nothing about other keys. The only CHECK
  // constraint on this column is a 2 MB size cap — verified against live prod — so looking for
  // "the CHECK" finds no `SKILL.md` guard at all. `authenticated` also keeps
  // `GRANT INSERT (... content)`, so such a row IS storable; the read side refuses it.)
  // `installFromContent()` expects every value to be text, so this repeats the shape check as
  // defense in depth against transport mangling or a future RPC change — never inventing an
  // empty install for it.
  const content = result.content
  if (
    !content ||
    typeof content !== 'object' ||
    Array.isArray(content) ||
    !Object.values(content).every((value) => typeof value === 'string')
  ) {
    await recordRegistryAudit({
      ...audit,
      version: result.version,
      detail: 'content_malformed_after_release',
    })
    throw new Error('Failed to read registry skill content: content_malformed_after_release')
  }

  return {
    skillId: result.skill_id as string,
    version: result.version as string,
    teamId: result.team_id as string,
    content,
    contentHash: result.content_hash ?? null,
    deprecated: Boolean(result.deprecated),
    publishedAt: result.published_at as string,
  }
}
