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
 * `getSkillContent` from here at runtime, so a value import back would be a real cycle. The two
 * shared constants live in `registry-tools.content.types.ts` for that reason.
 *
 * ============================================================================
 * TEAM-SCOPED ENTITLEMENT (Sol plan-review finding #1, critical, confirmed; SMI-6111)
 * ============================================================================
 * `profiles.tier` is `MAX(tier_rank)` over the user's own subscription AND every team they belong
 * to (`20260524000002_team_member_tier_sync.sql`, `recompute_user_tier`). A user who is Enterprise
 * via Team A and also a member of a since-downgraded Team B still reads `tier = 'enterprise'`
 * globally — so a `profiles.tier` check does not prove the team that owns the requested row is
 * entitled. `profiles` is therefore never read on this path.
 *
 * Neither is the outer `private_registry_manage` handler's license-derived `teamId` treated as
 * proof of entitlement on its own. That id, plus RLS, establishes *membership*: `resolve_team_from
 * _license` resolves a team from a shared key, and `private_registry_skills_member_read` filters
 * rows to teams the caller belongs to. Membership is not a live subscription tier — a team that
 * downgrades from Enterprise without removing its members would keep indefinite content access if
 * membership were the only gate (the exact scenario ADR-129's Enterprise gate exists to prevent).
 *
 * So: the metadata read is RLS-scoped AND explicitly `team_id`-filtered (the ADR-116 invariant
 * every method on this service honors), and the entitlement check is then resolved against
 * `row.team_id` — the value read back off the row — via the `check_registry_team_entitlement`
 * SECURITY DEFINER RPC. Reading it back off the row rather than reusing the parameter keeps this
 * function's logic identical to the Edge Function's, where RLS is the only tenant scope; the two
 * transports cannot drift into disagreeing about which team is being checked.
 *
 * SMI-6111: this used to require the SERVICE-ROLE client, because `subscriptions`' only read
 * policy is "Users can view own subscriptions" (`011_users_subscriptions.sql`, `user_id =
 * auth.uid()`), so a team member who is not the subscription's purchaser sees zero rows through
 * their own JWT and every non-owner would be spuriously denied. That's now handled server-side by
 * `check_registry_team_entitlement(p_team_id)` (`20260824000000_check_registry_team_entitlement
 * .sql`), a narrowly-scoped `SECURITY DEFINER` function callable by `authenticated` — it answers
 * only "is team X's own subscription Enterprise-entitled," with no personal-subscription
 * fallback. It is deliberately NOT built on `resolve_effective_entitlement(p_user_id, p_team_id)`
 * (`20260819000001_resolve_effective_entitlement.sql`): that function's personal-subscription
 * UNION leg has no team correlation and ranks ahead of team-correlated candidates by tier, so a
 * caller with their own personal Enterprise subscription who is merely a member of some other,
 * non-Enterprise team would resolve to entitled=true for that team via their personal leg —
 * reintroducing the exact cross-team leak `profiles.tier` was excluded above to prevent. See
 * `docs/internal/implementation/smi-6111-registry-content-install-entitlement-rpc.md` for the
 * full design rationale. The member-authenticated client is used for the RPC call, same as the
 * metadata and content reads — no service-role client exists anywhere in this file anymore.
 *
 * ORDER IS LOAD-BEARING: metadata (no `content` column) → entitlement → content. A denied read
 * therefore never transfers a byte of content, and a not-found never reads one.
 */

import { recordRegistryAudit } from './registry-tools.live.audit.js'
import {
  REGISTRY_METADATA_COLUMNS,
  REGISTRY_TABLE,
  type RegistrySkillContent,
} from './registry-tools.content.types.js'
import type { SkillContent } from './registry-tools.js'
import type { MinimalSupabaseClient, PrivateRegistrySkillRow } from './registry-tools.live.js'
import type { UserClientBinding } from './registry-tools.live.auth.js'

/** Audit `operation` for this path. Matches the Edge Function's `action: 'content_read'`. */
const OPERATION = 'content_read' as const

/** Shape of `check_registry_team_entitlement`'s JSONB return value. */
interface RegistryTeamEntitlement {
  entitled: boolean
  detail: string
}

/**
 * Is THIS team currently entitled to Enterprise? See the header — resolved server-side, from the
 * team that owns the row, never from the caller's denormalized `profiles.tier`.
 *
 * A lookup failure throws rather than returning `{entitled: false}`: an unreachable
 * `check_registry_team_entitlement` call is an outage, and reporting it as "not entitled" would
 * tell a paying customer their subscription had lapsed. Fail loud, not fail-wrong.
 *
 * @param teamId - the row's own `team_id`, already RLS-authorized for this caller.
 * @param client - the caller's own member-authenticated client (from `UserClientBinding`); no
 *   service-role client exists in this file (SMI-6111).
 */
export async function isTeamEnterpriseEntitled(
  teamId: string,
  client: MinimalSupabaseClient
): Promise<RegistryTeamEntitlement> {
  const resp = await client.rpc<RegistryTeamEntitlement>('check_registry_team_entitlement', {
    p_team_id: teamId,
  })
  if (resp.error) {
    throw new Error(`Entitlement lookup failed: ${resp.error.message ?? 'unknown error'}`)
  }
  if (!resp.data) {
    throw new Error('Entitlement lookup failed: check_registry_team_entitlement returned no data')
  }
  return resp.data
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
function auditBase(
  params: GetSkillContentParams
): Parameters<typeof recordRegistryAudit>[0] & { result: 'error' } {
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
 * team is no longer entitled, or on a real query failure: an outage must never be reported as
 * "not found".
 *
 * Version selection mirrors `registry-tools.live.ts`'s `get(teamId, skillId, version)` exactly —
 * an explicit `version` pins it, otherwise the MOST RECENTLY PUBLISHED version wins (not the
 * highest semver), chosen with the same `published_at` reduce — so `get` and `install` can never
 * disagree about what "no version specified" means.
 */
export async function getSkillContent(
  params: GetSkillContentParams
): Promise<RegistrySkillContent | null> {
  const { binding, teamId, skillId, version } = params
  const audit = auditBase(params)

  // (1) Metadata only — `content` is deliberately not selected here, so neither a not-found nor a
  //     denied outcome pulls up to 2 MB over the wire.
  let query = binding.client
    .from<PrivateRegistrySkillRow>(REGISTRY_TABLE)
    .select(REGISTRY_METADATA_COLUMNS)
    .eq('team_id', teamId)
    .eq('skill_id', skillId)
    // SMI-5949 Wave 3 (deprecated read-filter closure): unlike approval_status, `deprecated` is
    // NOT enforced by RLS (private_registry_skills_member_read only ever scoped team_id and, since
    // Wave 2, approval_status), so this predicate must be explicit here too, even though this
    // query already runs over the caller's own JWT. No opt-in — install must never resolve a
    // deprecated version, including by an exact version pin; see registry-tools.live.reads.ts's
    // getSkill() for the identical no-opt-in rule on the MCP metadata read.
    .eq('deprecated', false)
  if (version) query = query.eq('version', version)
  const metadata = await query

  if (metadata.error) {
    await recordRegistryAudit({ ...audit, detail: metadata.error.code ?? 'metadata_query_error' })
    throw new Error(
      `Failed to read registry skill content: ${metadata.error.message ?? 'unknown error'}`
    )
  }
  const rows = metadata.data ?? []
  if (rows.length === 0) {
    await recordRegistryAudit({ ...audit, result: 'not_found', detail: 'no_visible_row' })
    return null
  }
  // Same reduce (and same first-wins tie-break) as `get()`'s no-version branch.
  const row = rows.reduce((a, b) => (a.published_at >= b.published_at ? a : b))

  // (2) Entitlement, scoped to the ROW's team — not the caller's global tier.
  let entitlement: { entitled: boolean; detail: string }
  try {
    entitlement = await isTeamEnterpriseEntitled(row.team_id, binding.client)
  } catch (err) {
    // An outage in the entitlement lookup is an `error` outcome, not a denial — audited as such
    // (Sol review #8 wants all four outcomes covered) and rethrown unchanged.
    await recordRegistryAudit({
      ...audit,
      version: row.version,
      detail: 'entitlement_lookup_failed',
    })
    throw err
  }
  if (!entitlement.entitled) {
    await recordRegistryAudit({
      ...audit,
      result: 'denied',
      version: row.version,
      detail: entitlement.detail,
    })
    throw new Error(
      `Installing "${skillId}" from the private registry requires an active Enterprise ` +
        "subscription on the team that owns it, and that team's subscription is not currently " +
        'Enterprise-entitled. Contact a team admin or billing owner.'
    )
  }

  // (3) Content, still as the caller. Reached only after both gates pass.
  const contentResp = await binding.client
    .from<{ content: SkillContent }>(REGISTRY_TABLE)
    .select('content')
    .eq('id', row.id)
  if (contentResp.error) {
    await recordRegistryAudit({
      ...audit,
      version: row.version,
      detail: contentResp.error.code ?? 'content_query_error',
    })
    throw new Error(
      `Failed to read registry skill content: ${contentResp.error.message ?? 'unknown error'}`
    )
  }
  const content = contentResp.data?.[0]?.content
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    // The row was visible a moment ago; a vanished or misshapen payload is a not-found, never an
    // empty install.
    await recordRegistryAudit({
      ...audit,
      result: 'not_found',
      version: row.version,
      detail: 'content_missing_or_malformed',
    })
    return null
  }

  await recordRegistryAudit({
    ...audit,
    result: 'success',
    version: row.version,
    fileCount: Object.keys(content).length,
    contentHash: row.content_hash,
  })

  return {
    skillId: row.skill_id,
    version: row.version,
    teamId: row.team_id,
    content,
    contentHash: row.content_hash,
    deprecated: row.deprecated,
    publishedAt: row.published_at,
  }
}
