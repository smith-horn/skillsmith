/**
 * @fileoverview Shared API-first / local-fallback skill resolution.
 * @module @skillsmith/core/services/skill-resolution
 * @see SMI-1183: original API-first / local-fallback pattern, first written
 *   inline in the MCP `get_skill` tool.
 * @see SMI-5896 (Wave 3, discovery-tool consistency): extracted here so
 *   `skill_compare` can share the exact same resolution flow instead of only
 *   ever querying the local cache — which, per SMI-5427, is no longer kept in
 *   sync with the remote-first registry, so a real, searchable registry skill
 *   was often simply absent locally and compare would report "not found" for
 *   a skill `search`/`get_skill` could both resolve fine.
 *
 * This module owns exactly the "try API, fall back to local DB, normalize
 * not-found" flow — NOT the per-tool result-shape mapping (e.g. MCPSkill vs
 * the compare tool's ExtendedSkill), which stays with each calling tool since
 * those shapes genuinely differ and forcing one shared shape would just move
 * the duplication rather than remove it.
 *
 * Known non-consumer (intentional): `lookupSkillFromRegistry()` in
 * `@skillsmith/mcp-server/tools/install.helpers.ts` implements a similar
 * API-first/local-fallback shape but a materially different contract —
 * null-not-throw, no local fallback when the registry returns a skill with no
 * `repo_url`, and a per-branch `quarantined` derivation this resolver has no
 * concept of. See that function's docblock before attempting to unify them:
 * doing so naively would relax an install-time security gate.
 */

import { SkillsmithError, ErrorCodes } from '../errors.js'
// SMI-5896: `ApiSearchResult` MUST come from './client.js' (re-exported from
// client.types.ts), not from './types.js' — the latter is a *different*,
// OpenAPI-spec-aligned type of the same name (re-exported publicly as
// `OpenApiSearchResult` specifically to avoid this collision, see
// api/index.ts). `SkillsmithApiClient.getSkill()` returns the client.types
// shape, so importing the other one here is a real type mismatch, not a
// stylistic choice — confirmed by `tsc` (TS2322 on `repo_url`'s nullability).
import type { SkillsmithApiClient, ApiSearchResult } from '../api/client.js'
import type { SkillRepository } from '../repositories/SkillRepository.js'
import type { Skill } from '../types/skill.js'

/**
 * Result of {@link resolveSkillApiFirst} — a discriminated union over the two
 * possible sources so callers can branch on `source` and access the
 * source-specific (snake_case API vs camelCase local DB) shape directly
 * rather than a lossy, pre-merged shape.
 */
export type ResolvedSkill =
  | { source: 'api'; apiSkill: ApiSearchResult }
  | { source: 'local'; dbSkill: Skill }

export interface ResolveSkillOptions {
  /**
   * Request SKILL.md content alongside metadata on the API path. Only
   * `get_skill` needs this; `skill_compare` never sets it. Default `false`.
   */
  includeContent?: boolean
}

/**
 * Resolve a skill by ID, API first with local-DB fallback (SMI-1183).
 *
 * - Tries the live API first (unless `apiClient.isOffline()`).
 * - Falls back to the local `SkillRepository` on API-offline or API failure
 *   of any kind (network, 404, etc — all treated the same: fall through).
 * - Throws a normalized `SkillsmithError(SKILL_NOT_FOUND)` when neither
 *   source has the skill. Every caller shares this exact message/details
 *   shape, so `get_skill` and `skill_compare` report not-found identically
 *   instead of two independently-worded messages that can drift.
 *
 * @param skillId - Already-validated/trimmed skill ID (author/name or UUID).
 * @param apiClient - API client used for the primary lookup.
 * @param skillRepository - Local repository used for the fallback lookup.
 * @param options - Optional resolution behavior (e.g. `includeContent`).
 */
export async function resolveSkillApiFirst(
  skillId: string,
  apiClient: SkillsmithApiClient,
  skillRepository: SkillRepository,
  options: ResolveSkillOptions = {}
): Promise<ResolvedSkill> {
  if (!apiClient.isOffline()) {
    try {
      const apiResponse = await apiClient.getSkill(skillId, {
        includeContent: options.includeContent ?? false,
      })
      return { source: 'api', apiSkill: apiResponse.data }
    } catch (error) {
      // SMI-1183: log and fall through to the local database for all errors —
      // this allows local-only skills to resolve even when the API 404s.
      console.warn(
        '[skillsmith] API getSkill failed, using local database:',
        (error as Error).message
      )
    }
  }

  const dbSkill = skillRepository.findById(skillId)
  if (!dbSkill) {
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${skillId}" not found`, {
      details: { id: skillId },
      suggestion: 'Try searching for similar skills with the search tool',
    })
  }

  return { source: 'local', dbSkill }
}
