/**
 * @fileoverview In-memory stub for the private registry MCP tools
 * @module @skillsmith/mcp-server/tools/registry-tools.stub
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 *
 * Local-dev / test fallback used when Supabase is NOT configured. The real,
 * Postgres-backed implementation lives in registry-tools.live.ts and is selected
 * automatically once SUPABASE_URL + SUPABASE_ANON_KEY are present.
 *
 * NOTE: this stub does not persist file bytes and does NOT enforce version
 * immutability — those are guarantees of the real table (UNIQUE(team_id, skill_id,
 * version)) surfaced by the live service. Entries are keyed by (teamId, skillId) so
 * the stub is at least tenant-scoped (list/get/deprecate never cross a team boundary).
 */

import type { PrivateRegistryService, RegistrySkill, SkillContent } from './registry-tools.js'

/** @internal Exported for testing */
export function createStubRegistryService(): PrivateRegistryService {
  // Keyed by `${teamId}::${skillId}` so the stub never leaks across teams.
  const registry = new Map<string, RegistrySkill>()
  const key = (teamId: string, skillId: string): string => `${teamId}::${skillId}`

  return {
    async publish(teamId, skillId, version, _content: SkillContent, description) {
      const skill: RegistrySkill = {
        skillId,
        version,
        description: description ?? null,
        deprecated: false,
        publishedAt: new Date().toISOString(),
        publishedBy: 'current-user',
        registryUrl: `https://registry.skillsmith.app/private/${teamId}/${skillId}@${version}`,
      }
      registry.set(key(teamId, skillId), skill)
      return skill
    },

    async list(teamId, version) {
      const all = [...registry.entries()]
        .filter(([k]) => k.startsWith(`${teamId}::`))
        .map(([, v]) => v)
      if (version) return all.filter((s) => s.version === version)
      return all
    },

    async get(teamId, skillId, version) {
      const skill = registry.get(key(teamId, skillId))
      if (!skill) return null
      if (version && skill.version !== version) return null
      return skill
    },

    async deprecate(teamId, skillId) {
      const skill = registry.get(key(teamId, skillId))
      if (!skill) return false
      skill.deprecated = true
      return true
    },

    async undeprecate(teamId, skillId) {
      const skill = registry.get(key(teamId, skillId))
      if (!skill) return false
      skill.deprecated = false
      return true
    },
  }
}
