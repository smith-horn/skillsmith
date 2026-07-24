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
 * Uses the Supabase service-role client for all CRUD. Migration 071/129 RLS gates
 * tenant access on the `authenticated` role + `auth.uid()`, which the MCP subprocess
 * does not carry (no user JWT). Service-role bypasses RLS; **tenant isolation is
 * enforced here**, in-query, via an explicit `team_id = <resolved>` filter on every
 * request (ADR-116). `teamId` always comes from `resolve_team_from_license` — never
 * from tool input — so a caller can only ever touch their own team's rows.
 *
 * Because service-role bypasses RLS, the admin-only-deprecation RLS policy is NOT
 * re-enforced on this path (the license key resolves to a team, not a per-user role)
 * — mirroring team-workspace.live.ts, where createWorkspace is admin-gated in RLS but
 * not re-checked here. Admin gating applies to the authenticated user-JWT path (e.g.
 * the website dashboard). See registry-tools.live.test.ts / private-registry-rls test.
 *
 * Single-phase write: metadata + content land in one INSERT (ADR-129) — no two-phase
 * Supabase+S3 write/rollback. Published (team_id, skill_id, version) triples are
 * immutable; a re-publish raises a unique violation surfaced as a clear error.
 */

import { createHash } from 'node:crypto'
import { getSupabaseAdminClient } from '../supabase-client.js'
import type { PrivateRegistryService, RegistrySkill, SkillContent } from './registry-tools.js'

/** 2 MB raw-content cap (ADR-129 Risks). Primary user-facing guard; the migration's
 *  pg_column_size CHECK is a stored-size backstop. */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024

interface PrivateRegistrySkillRow {
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

interface SupabaseError {
  code?: string
  message?: string
  details?: string
}

interface SupabaseQueryResult<T> {
  data: T | null
  error: SupabaseError | null
}

interface SupabaseTableQuery<T> {
  select: (columns?: string) => SupabaseTableQuery<T>
  eq: (column: string, value: unknown) => SupabaseTableQuery<T>
  single: () => Promise<SupabaseQueryResult<T>>
  insert: (row: Record<string, unknown>) => SupabaseTableQuery<T>
  update: (row: Record<string, unknown>) => SupabaseTableQuery<T>
  then: <R>(onFulfilled: (value: SupabaseQueryResult<T[]>) => R) => Promise<R>
}

interface MinimalSupabaseClient {
  from: <T>(table: string) => SupabaseTableQuery<T>
}

const TABLE = 'private_registry_skills'

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
  return { contentHash: createHash('sha256').update(skillMd, 'utf8').digest('hex') }
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
          content_hash: contentHash,
        })
        .select()
        .single()
      if (resp.error || !resp.data) {
        if (isUniqueViolation(resp.error)) {
          throw new Error(
            `Version ${version} of "${skillId}" already exists in this team's private registry. ` +
              'Published versions are immutable — bump the version and publish a new one.'
          )
        }
        throw new Error(`Failed to publish skill: ${resp.error?.message ?? 'unknown error'}`)
      }
      return mapRow(teamId, resp.data)
    },

    async list(teamId, version): Promise<RegistrySkill[]> {
      const client = await getClient()
      let query = client.from<PrivateRegistrySkillRow>(TABLE).select().eq('team_id', teamId)
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
          .select()
          .eq('team_id', teamId)
          .eq('skill_id', skillId)
          .eq('version', version)
          .single()
        if (resp.error || !resp.data) return null
        return mapRow(teamId, resp.data)
      }
      // No version specified — return the most recently published version.
      const resp = await client
        .from<PrivateRegistrySkillRow>(TABLE)
        .select()
        .eq('team_id', teamId)
        .eq('skill_id', skillId)
      if (resp.error || !resp.data || resp.data.length === 0) return null
      const latest = resp.data.reduce((a, b) => (a.published_at >= b.published_at ? a : b))
      return mapRow(teamId, latest)
    },

    async deprecate(teamId, skillId): Promise<boolean> {
      const client = await getClient()
      // Deprecates every version of the skill within this team (hidden from search,
      // remains installable). team_id filter is load-bearing — never cross-team.
      const resp = await client
        .from<PrivateRegistrySkillRow>(TABLE)
        .update({ deprecated: true })
        .eq('team_id', teamId)
        .eq('skill_id', skillId)
      if (resp.error) {
        throw new Error(`Failed to deprecate skill: ${resp.error.message ?? 'unknown error'}`)
      }
      return Array.isArray(resp.data) ? resp.data.length > 0 : false
    },

    async undeprecate(teamId, skillId): Promise<boolean> {
      const client = await getClient()
      const resp = await client
        .from<PrivateRegistrySkillRow>(TABLE)
        .update({ deprecated: false })
        .eq('team_id', teamId)
        .eq('skill_id', skillId)
      if (resp.error) {
        throw new Error(`Failed to undeprecate skill: ${resp.error.message ?? 'unknown error'}`)
      }
      return Array.isArray(resp.data) ? resp.data.length > 0 : false
    },
  }
}
