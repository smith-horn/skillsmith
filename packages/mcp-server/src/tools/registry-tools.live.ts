/**
 * @fileoverview Live Supabase-backed PrivateRegistryService (ADR-129)
 * @module @skillsmith/mcp-server/tools/registry-tools.live
 * @see SMI-5816: Private skill registry — real implementation
 * @see ADR-129: Postgres-native (JSONB) storage, real team-auth (migration 071)
 * @see ADR-116: MCP service-role client + explicit tenant filter
 *
 * Backs `private_registry_publish` / `private_registry_manage` with the real
 * `private_registry_skills` table (migration 20260724000000).
 *
 * TWO CREDENTIALS, THREE PATHS (SMI-5822 fix, SMI-5882 Wave 3; third path added SMI-5905 Wave 3):
 *
 * - **Member-level reads and publishes** (`list`, `get`, `publish`, `getNamespace`) use the
 *   Supabase service-role client. Service-role bypasses RLS, so **tenant isolation is enforced
 *   here**, in-query, via an explicit `team_id = <resolved>` filter on every request (ADR-116).
 *   `teamId` always comes from `resolve_team_from_license` — never from tool input — so a caller
 *   can only ever touch their own team's rows. This is correct for these operations: the team's
 *   license key genuinely authorizes team-scoped reads and publishes, which RLS also grants to any
 *   member (`_member_read` / `_member_insert`).
 *
 * - **Admin-level writes** (`deprecate`, `undeprecate`) do NOT. They run through the signed-in
 *   user's own Supabase JWT (`skillsmith login`, SMI-4402), so PostgREST evaluates
 *   `private_registry_skills_admin_update` with a real `auth.uid()` and the database — not this
 *   file — decides whether the caller is a team admin.
 *
 *   Why the change: a team's license key is shared, and `resolve_team_from_license` is
 *   `(p_license_key TEXT) RETURNS TEXT` — it resolves a *team*, never a *person*. Running these
 *   two operations as service-role therefore made the shared key an effective admin credential:
 *   SMI-5882's staging run proved the asymmetry directly (a team *member* reaches 0 rows over the
 *   authenticated path, while the identical UPDATE as service-role deprecated 2 rows). Re-checking
 *   the role in application code was rejected as the fix — it would duplicate a policy that
 *   already exists and can silently drift from it. Letting the existing, proven policy do the work
 *   cannot drift.
 *
 *   Cost, stated plainly: deprecate/undeprecate now require `skillsmith login` in addition to
 *   SKILLSMITH_LICENSE_KEY, and surface an actionable error when no user credential is present.
 *
 * - **Content reads** (`getContent`, SMI-5905 Wave 3) are a third path: the signed-in user's own
 *   JWT (so `_member_read` decides visibility against a real `auth.uid()`), but MEMBER-level, not
 *   admin. `getAdminUserClient()` / `getMemberUserClient()` (`registry-tools.live.auth.ts`) are two
 *   explicitly-named getters for exactly this reason — the choice cannot be defaulted or omitted at
 *   a call site. What decides whether a content read is *entitled* is in
 *   `registry-tools.live.content.ts`, and is scoped to the row's own team, not the caller's tier.
 *
 * Single-phase write: metadata + content land in one INSERT (ADR-129) — no two-phase
 * Supabase+S3 write/rollback. Published (team_id, skill_id, version) triples are
 * immutable; a re-publish raises a unique violation surfaced as a clear error.
 */

import { sha256Hex } from '@skillsmith/core'
import { getSupabaseAdminClient } from '../supabase-client.js'
import { recordRegistryAudit } from './registry-tools.live.audit.js'
import { getAdminUserClient, getMemberUserClient } from './registry-tools.live.auth.js'
import {
  REGISTRY_METADATA_COLUMNS,
  REGISTRY_TABLE,
  type RegistrySkillContent,
} from './registry-tools.content.types.js'
import { getSkillContent } from './registry-tools.live.content.js'
import type { PrivateRegistryService, RegistrySkill, SkillContent } from './registry-tools.js'

/** 2 MB raw-content cap (ADR-129 Risks). Primary user-facing guard; the migration's
 *  pg_column_size CHECK is a stored-size backstop. */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024

export interface PrivateRegistrySkillRow {
  id: string
  team_id: string
  skill_id: string
  version: string
  description: string | null
  content_hash: string
  deprecated: boolean
  published_by: string | null
  published_at: string
}

export interface SupabaseError {
  code?: string
  message?: string
  details?: string
}

export interface SupabaseQueryResult<T> {
  data: T | null
  error: SupabaseError | null
}

export interface SupabaseTableQuery<T> {
  select: (columns?: string) => SupabaseTableQuery<T>
  eq: (column: string, value: unknown) => SupabaseTableQuery<T>
  single: () => Promise<SupabaseQueryResult<T>>
  insert: (row: Record<string, unknown>) => SupabaseTableQuery<T>
  update: (row: Record<string, unknown>) => SupabaseTableQuery<T>
  then: <R>(onFulfilled: (value: SupabaseQueryResult<T[]>) => R) => Promise<R>
}

export interface MinimalSupabaseClient {
  from: <T>(table: string) => SupabaseTableQuery<T>
}

// Table name + metadata column list live in registry-tools.content.types.ts so the content module
// shares them without a runtime import cycle back into this file. Aliased to the names this file
// has always used. METADATA_COLUMNS excludes `content` — see that file for why that matters.
const TABLE = REGISTRY_TABLE
const METADATA_COLUMNS = REGISTRY_METADATA_COLUMNS

/** PostgREST's code for "no rows" (or >1 row) via .single() — a real absence, not a
 *  failure. Any other error code/message is a genuine failure and must not be
 *  silently mapped to null, or an outage would look identical to "not found". */
function isNoRowsError(error: SupabaseError | null): boolean {
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
  }
}

/** Postgres unique_violation (immutability breach) — code 23505, or a duplicate-key message. */
function isUniqueViolation(error: SupabaseError | null): boolean {
  if (!error) return false
  if (error.code === '23505') return true
  const haystack = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase()
  return haystack.includes('duplicate key') || haystack.includes('unique constraint')
}

/**
 * Get the Supabase service-role client. Throws a typed error if
 * SUPABASE_SERVICE_ROLE_KEY is not configured on the MCP host — handlers surface
 * this to the caller instead of leaking a 42501.
 */
async function getClient(): Promise<MinimalSupabaseClient> {
  try {
    return (await getSupabaseAdminClient()) as MinimalSupabaseClient
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    throw new Error(
      `Private registry operations require SUPABASE_SERVICE_ROLE_KEY on the MCP host: ${message}`
    )
  }
}

/**
 * Flip `deprecated` for every version of a skill within one team, over the authenticated user
 * path so `private_registry_skills_admin_update` is the authorization check (SMI-5822).
 *
 * RLS denials on UPDATE do not raise — a row failing the policy's USING clause is simply invisible
 * to the statement, which then affects zero rows. "0 rows" is therefore ambiguous between "no such
 * skill" and "you are not an admin", and reporting the wrong one would be actively misleading. The
 * probe below disambiguates: `_member_read` lets ANY team member SELECT the rows, while
 * `_admin_update` restricts the write, so rows-visible-but-not-writable means exactly "not an
 * admin".
 */
async function setDeprecated(teamId: string, skillId: string, value: boolean): Promise<boolean> {
  const operation = value ? 'deprecate' : 'undeprecate'
  // ADMIN getter — never getMemberUserClient(). `authRole` on every audit row below is read back
  // off this binding rather than hard-coded, so a swapped call site would show up in the audit
  // trail rather than only in a test that could itself be edited to match.
  const { client, actorUserId, role } = await getAdminUserClient(operation)
  // .select() is REQUIRED here: PostgREST only returns affected-row data (the
  // `Prefer: return=representation` the JS client sets via .select()) when asked; without it,
  // `resp.data` is null on every call — including a successful update — and this method would
  // always report "not found" in production.
  const resp = await client
    .from<PrivateRegistrySkillRow>(TABLE)
    .update({ deprecated: value })
    .eq('team_id', teamId)
    .eq('skill_id', skillId)
    .select(METADATA_COLUMNS)
  if (resp.error) {
    await recordRegistryAudit({
      operation,
      teamId,
      skillId,
      result: 'error',
      authPath: 'user_jwt',
      authRole: role,
      actorUserId,
      detail: resp.error.code ?? 'query_error',
    })
    throw new Error(`Failed to ${operation} skill: ${resp.error.message ?? 'unknown error'}`)
  }
  if (Array.isArray(resp.data) && resp.data.length > 0) {
    await recordRegistryAudit({
      operation,
      teamId,
      skillId,
      result: 'success',
      authPath: 'user_jwt',
      authRole: role,
      actorUserId,
    })
    return true
  }

  const probe = await client
    .from<{ id: string }>(TABLE)
    .select('id')
    .eq('team_id', teamId)
    .eq('skill_id', skillId)
  // A failed probe is NOT evidence of absence. Only a confirmed no-rows result is (the
  // `isNoRowsError` convention this file uses everywhere else) — mapping an expired token, a
  // network fault or a permission problem to "not found" would make a real outage
  // indistinguishable from a skill that does not exist, and would silently return `false` to a
  // caller who asked us to change something.
  if (probe.error && !isNoRowsError(probe.error)) {
    await recordRegistryAudit({
      operation,
      teamId,
      skillId,
      result: 'error',
      authPath: 'user_jwt',
      authRole: role,
      actorUserId,
      detail: probe.error.code ?? 'probe_error',
    })
    throw new Error(
      `Failed to ${operation} skill: the update matched no rows and the follow-up check for ` +
        `"${skillId}" also failed, so we cannot tell whether it is missing or you lack admin ` +
        `rights: ${probe.error.message ?? 'unknown error'}`
    )
  }
  if (Array.isArray(probe.data) && probe.data.length > 0) {
    await recordRegistryAudit({
      operation,
      teamId,
      skillId,
      result: 'denied',
      authPath: 'user_jwt',
      authRole: role,
      actorUserId,
      detail: 'not_team_admin',
    })
    throw new Error(
      `Only team admins can ${operation} "${skillId}". Your account is a member of this team but ` +
        'not an admin — ask a team admin to run this, or have them promote you.'
    )
  }
  await recordRegistryAudit({
    operation,
    teamId,
    skillId,
    result: 'not_found',
    authPath: 'user_jwt',
    actorUserId,
  })
  return false
}

/**
 * Validate + size-check the content map and compute its content_hash.
 * content_hash = sha256 hex of SKILL.md, matching skills.content_hash /
 * device_skills.content_hash (inventory-collector) so cross-source drift logic
 * (ADR-130 Wave 2) needs no per-source branching.
 */
function prepareContent(content: SkillContent): { contentHash: string } {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('Publish requires a "content" file map (e.g. { "SKILL.md": "..." }).')
  }
  const skillMd = content['SKILL.md']
  if (typeof skillMd !== 'string' || skillMd.length === 0) {
    throw new Error('Publish content must include a non-empty "SKILL.md" entry.')
  }
  const bytes = Buffer.byteLength(JSON.stringify(content), 'utf8')
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(
      `Skill content is ${bytes} bytes, over the ${MAX_CONTENT_BYTES}-byte (2 MB) private-registry limit. Split large assets out of the skill package.`
    )
  }
  return { contentHash: sha256Hex(skillMd) }
}

/**
 * Create a live Supabase-backed PrivateRegistryService.
 *
 * Every DB call explicitly filters by `team_id = <resolved teamId>`. Service-role
 * bypasses RLS — tenant isolation lives here, not in the database (ADR-116).
 */
export function createLiveRegistryService(): PrivateRegistryService {
  return {
    async publish(teamId, skillId, version, content, description): Promise<RegistrySkill> {
      const { contentHash } = prepareContent(content)
      const client = await getClient()
      const resp = await client
        .from<PrivateRegistrySkillRow>(TABLE)
        .insert({
          team_id: teamId,
          skill_id: skillId,
          version,
          description: description ?? null,
          content,
          // Still sent, but no longer authoritative: trg_prs_content_hash (migration
          // 20260729000000) recomputes content_hash from content->>'SKILL.md' and discards client
          // input. The two agree by construction — prepareContent() uses the same sha256 over the
          // same UTF-8 bytes — so this value is now a consistency check rather than the source of
          // truth. `published_by` is deliberately NOT sent: it defaults to auth.uid(), which is
          // NULL on this service-role path. See registry-tools.live.audit.ts for why that NULL is
          // preferred over a guess, and what is recorded instead.
          content_hash: contentHash,
        })
        .select()
        .single()
      if (resp.error || !resp.data) {
        await recordRegistryAudit({
          operation: 'publish',
          teamId,
          skillId,
          version,
          result: 'error',
          authPath: 'license_key',
          detail: isUniqueViolation(resp.error)
            ? 'version_immutable'
            : (resp.error?.code ?? 'insert_error'),
        })
        if (isUniqueViolation(resp.error)) {
          throw new Error(
            `Version ${version} of "${skillId}" already exists in this team's private registry. ` +
              'Published versions are immutable — bump the version and publish a new one.'
          )
        }
        throw new Error(`Failed to publish skill: ${resp.error?.message ?? 'unknown error'}`)
      }
      await recordRegistryAudit({
        operation: 'publish',
        teamId,
        skillId,
        version,
        result: 'success',
        authPath: 'license_key',
      })
      return mapRow(teamId, resp.data)
    },

    async list(teamId, version): Promise<RegistrySkill[]> {
      const client = await getClient()
      let query = client
        .from<PrivateRegistrySkillRow>(TABLE)
        .select(METADATA_COLUMNS)
        .eq('team_id', teamId)
      if (version) query = query.eq('version', version)
      const resp = await query
      if (resp.error) {
        throw new Error(`Failed to list registry skills: ${resp.error.message ?? 'unknown error'}`)
      }
      return (resp.data ?? []).map((row) => mapRow(teamId, row))
    },

    async get(teamId, skillId, version): Promise<RegistrySkill | null> {
      const client = await getClient()
      if (version) {
        const resp = await client
          .from<PrivateRegistrySkillRow>(TABLE)
          .select(METADATA_COLUMNS)
          .eq('team_id', teamId)
          .eq('skill_id', skillId)
          .eq('version', version)
          .single()
        if (resp.error) {
          if (isNoRowsError(resp.error)) return null
          throw new Error(`Failed to get registry skill: ${resp.error.message ?? 'unknown error'}`)
        }
        if (!resp.data) return null
        return mapRow(teamId, resp.data)
      }
      // No version specified — return the most recently published version.
      const resp = await client
        .from<PrivateRegistrySkillRow>(TABLE)
        .select(METADATA_COLUMNS)
        .eq('team_id', teamId)
        .eq('skill_id', skillId)
      if (resp.error) {
        throw new Error(`Failed to get registry skill: ${resp.error.message ?? 'unknown error'}`)
      }
      if (!resp.data || resp.data.length === 0) return null
      const latest = resp.data.reduce((a, b) => (a.published_at >= b.published_at ? a : b))
      return mapRow(teamId, latest)
    },

    // SMI-5905 Wave 3. MEMBER getter — never getAdminUserClient(): reading a skill you may
    // install is not an admin action, and claiming it is would lock every non-admin member out of
    // their own team's registry. The entitlement check that DOES gate this lives in
    // registry-tools.live.content.ts and is scoped to the row's own team, not the caller's tier.
    async getContent(teamId, skillId, version): Promise<RegistrySkillContent | null> {
      const binding = await getMemberUserClient('install')
      return getSkillContent({ binding, teamId, skillId, version })
    },

    // Deprecates every version of the skill within this team (hidden from search, remains
    // installable). Admin-gated: runs as the signed-in user so RLS authorizes it (SMI-5822).
    // The team_id filter is still load-bearing — never cross-team — and is now backed by
    // `_admin_update`'s own USING clause rather than standing alone.
    async deprecate(teamId, skillId): Promise<boolean> {
      return setDeprecated(teamId, skillId, true)
    },

    async getNamespace(teamId): Promise<string | null> {
      const client = await getClient()
      const resp = await client
        .from<{ skill_namespace: string }>('teams')
        .select('skill_namespace')
        .eq('id', teamId)
        .single()
      if (resp.error || !resp.data) return null
      return resp.data.skill_namespace ?? null
    },

    // Admin-gated — see deprecate()'s comment above.
    async undeprecate(teamId, skillId): Promise<boolean> {
      return setDeprecated(teamId, skillId, false)
    },
  }
}
