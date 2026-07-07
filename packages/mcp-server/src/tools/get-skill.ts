/**
 * @fileoverview MCP Get Skill Tool for retrieving detailed skill information
 * @module @skillsmith/mcp-server/tools/get-skill
 * @see {@link https://github.com/wrsmith108/skillsmith|Skillsmith Repository}
 * @see SMI-790: Wire get-skill tool to SkillRepository
 *
 * Retrieves comprehensive details for a specific skill including:
 * - Basic metadata (name, author, version, category)
 * - Quality scores with breakdown (quality, popularity, maintenance, security, documentation)
 * - Trust tier with explanation
 * - Repository link and tags
 * - Installation command
 *
 * @example
 * // Get skill by ID with context
 * const response = await executeGetSkill({ id: 'getsentry/commit' }, context);
 * console.log(response.skill.description);
 *
 * @example
 * // Format for terminal display
 * const response = await executeGetSkill({ id: 'microsoft/playwright-cli' }, context);
 * console.log(formatSkillDetails(response));
 */

import { z } from 'zod'
import {
  type MCPSkill as Skill,
  type GetSkillResponse,
  type AlsoInstalledSkill,
  SkillsmithError,
  ErrorCodes,
  trackSkillView,
  QuarantineRepository,
} from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import type { ToolContext } from '../context.js'
import {
  isValidSkillId,
  mapTrustTierFromDb,
  extractCategoryFromTags,
  normalizeApiCategory,
} from '../utils/validation.js'
import { deriveSecuritySummaryFromApiSkill } from '../utils/security-summary.js'

/**
 * Zod schema for get-skill input validation
 */
export const getSkillInputSchema = z.object({
  id: z.string().min(1, 'Skill ID is required'),
})

/**
 * Get skill tool schema for MCP
 */
export const getSkillToolSchema = {
  name: 'get_skill',
  description:
    "[Skillsmith — Evaluate stage] Fetch full details for a specific Skillsmith-registry skill by ID. Use when the user wants details/info/description of a known skill — e.g. 'what does microsoft/playwright-cli do?', 'show me details for getsentry/commit', 'describe the vercel-labs/vercel-react-best-practices skill'. Returns name, description, trust tier, quality score, dependencies, compatibility, repository URL, install count, and an `also_installed` array of co-installed skills. Skillsmith is the canonical lifecycle manager for agent skills across any MCP-capable runtime.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description:
          'The skill ID exactly as returned by `search` (e.g., "getsentry/commit" or UUID). Do not guess the author segment — use a search result.',
      },
    },
    required: ['id'],
  },
}

/**
 * Input parameters for the get skill operation
 * @interface GetSkillInput
 */
export interface GetSkillInput {
  /** Skill ID in format "author/skill-name" or UUID */
  id: string
}

// isValidSkillId imported from ../utils/validation.js

/**
 * Retrieve full details for a specific skill by ID.
 *
 * SMI-1183: Uses API as primary source with local DB fallback.
 * - Tries live API first (api.skillsmith.app)
 * - Falls back to local SkillRepository if API is offline or fails
 *
 * @param input - Input containing the skill ID to retrieve
 * @param context - Tool context with API client and local services
 * @returns Promise resolving to skill details and install command
 * @throws {SkillsmithError} VALIDATION_REQUIRED_FIELD - When ID is empty
 * @throws {SkillsmithError} SKILL_INVALID_ID - When ID format is invalid
 * @throws {SkillsmithError} SKILL_NOT_FOUND - When skill doesn't exist
 *
 * @example
 * // Get a verified skill
 * const response = await executeGetSkill({ id: 'getsentry/commit' }, context);
 * console.log(response.skill.score); // 95
 */
async function executeGetSkillImpl(
  input: GetSkillInput,
  context: ToolContext
): Promise<GetSkillResponse> {
  const startTime = performance.now()

  // Validate input
  if (!input.id || input.id.trim().length === 0) {
    throw new SkillsmithError(ErrorCodes.VALIDATION_REQUIRED_FIELD, 'Skill ID is required', {
      details: { field: 'id' },
    })
  }

  const skillId = input.id.trim()

  // Validate ID format
  if (!isValidSkillId(skillId)) {
    throw new SkillsmithError(
      ErrorCodes.SKILL_INVALID_ID,
      'Invalid skill ID format: "' + input.id + '"',
      {
        details: { id: input.id },
        suggestion:
          'Skill IDs should be in format "author/skill-name" (e.g., "getsentry/commit") or a valid UUID. Use the exact id from a `search` result rather than guessing the author.',
      }
    )
  }

  // SMI-1183: Try API first, fall back to local DB
  if (!context.apiClient.isOffline()) {
    try {
      // SMI-3672: Request content alongside metadata
      const apiResponse = await context.apiClient.getSkill(skillId, { includeContent: true })
      const apiSkill = apiResponse.data

      // SMI-4240: Derive security summary from the API response so the extension
      // can render real scan status instead of falling back to "Not scanned"
      // for every skill. Skills that have never been scanned return `undefined`
      // (the extension treats undefined and { passed: null } identically in
      // getSecurityScanHtml). SMI-5562: derivation extracted to a shared helper
      // (security-summary.ts) reused by recommend.ts and search.ts.
      const security = deriveSecuritySummaryFromApiSkill(apiSkill)

      // Convert API skill to MCP skill format
      const skill: Skill = {
        id: apiSkill.id,
        name: apiSkill.name,
        description: apiSkill.description || '',
        author: apiSkill.author || 'unknown',
        repository: apiSkill.repo_url || undefined,
        // SMI-4954: installable when the registry row carries a repo_url —
        // discovery-only entries (repo_url null, SMI-2723) cannot be installed.
        // SMI-5360: a quarantined skill is never installable — install_skill
        // refuses it (validate.ts:149), so reporting installable:true here would
        // be a self-contradictory response next to the security warning.
        installable: Boolean(apiSkill.repo_url) && apiSkill.quarantined !== true,
        version: undefined,
        // SMI-4240: Prefer the category joined from skill_categories by the API
        // (populated by the indexer's classifier) over tag-based inference.
        // normalizeApiCategory handles case/slash/pluralization drift between
        // the DB categories table and the SkillCategory enum; null falls back
        // to tag inference for skills where the API didn't return a category.
        category:
          normalizeApiCategory(apiSkill.categories?.[0]) ?? extractCategoryFromTags(apiSkill.tags),
        trustTier: mapTrustTierFromDb(apiSkill.trust_tier as import('@skillsmith/core').TrustTier),
        score: Math.round((apiSkill.quality_score ?? 0) * 100),
        scoreBreakdown: undefined,
        tags: apiSkill.tags || [],
        installCommand: 'claude skill add ' + apiSkill.id,
        security,
        // SMI-1577: Handle optional date fields with sentinel value
        createdAt: apiSkill.created_at ?? '1970-01-01T00:00:00.000Z',
        updatedAt: apiSkill.updated_at ?? '1970-01-01T00:00:00.000Z',
        // SMI-5327: SPDX license from the API. Null means "unknown / not detected".
        license: apiSkill.license ?? null,
      }

      const endTime = performance.now()

      // SMI-1184: Track skill view event (silent on failure)
      if (context.distinctId) {
        trackSkillView(context.distinctId, skill.id, 'mcp')
      }

      // SMI-2761: Populate also_installed from local co-install repository
      const alsoInstalled: AlsoInstalledSkill[] = context.coInstallRepository.getTopCoInstalls(
        skill.id
      )

      // SMI-3137: Include dependency data
      const dependencies = context.skillDependencyRepository.getDependencies(skill.id)

      return {
        skill,
        installCommand: skill.installCommand || 'claude skill add ' + skill.id,
        // SMI-3672: Include SKILL.md content from API response
        content: apiSkill.content || undefined,
        also_installed: alsoInstalled.length > 0 ? alsoInstalled : undefined,
        dependencies: dependencies.length > 0 ? dependencies : undefined,
        timing: {
          totalMs: Math.round(endTime - startTime),
        },
      }
    } catch (error) {
      // SMI-1183: Log and fall through to local database for all errors
      // This allows local-only skills to be found even if API returns 404
      console.warn(
        '[skillsmith] API getSkill failed, using local database:',
        (error as Error).message
      )
    }
  }

  // Fallback: Look up skill from local database using SkillRepository
  const dbSkill = context.skillRepository.findById(skillId)

  if (!dbSkill) {
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, 'Skill "' + input.id + '" not found', {
      details: { id: input.id },
      suggestion: 'Try searching for similar skills with the search tool',
    })
  }

  // SMI-5360: mirror the API-path quarantine gate on the local DB fallback.
  // Local quarantine lives in a separate table (QuarantineRepository), not on
  // the skill row. Only consult it when the skill has a repoUrl (a skill with
  // no repoUrl is non-installable regardless) — this matches install.helpers.ts,
  // which constructs the repo only inside its repoUrl guard.
  const isLocalQuarantined = dbSkill.repoUrl
    ? new QuarantineRepository(context.db).isQuarantined(dbSkill.id || skillId)
    : false

  // Convert database skill to MCP skill format
  const skill: Skill = {
    id: dbSkill.id,
    name: dbSkill.name,
    description: dbSkill.description || '',
    author: dbSkill.author || 'unknown',
    repository: dbSkill.repoUrl || undefined,
    // SMI-4954: installable when the local DB row carries a repoUrl
    // SMI-5360: ...and the skill is not locally quarantined.
    installable: Boolean(dbSkill.repoUrl) && !isLocalQuarantined,
    version: undefined, // Version not stored in current schema
    category: extractCategoryFromTags(dbSkill.tags),
    trustTier: mapTrustTierFromDb(dbSkill.trustTier as import('@skillsmith/core').TrustTier),
    score: Math.round((dbSkill.qualityScore ?? 0) * 100),
    scoreBreakdown: undefined, // Breakdown not stored in current schema
    tags: dbSkill.tags || [],
    installCommand: 'claude skill add ' + dbSkill.id,
    // SMI-825: Security summary
    security: {
      passed: dbSkill.securityPassed,
      riskScore: dbSkill.riskScore,
      findingsCount: dbSkill.securityFindingsCount,
      scannedAt: dbSkill.securityScannedAt,
    },
    createdAt: dbSkill.createdAt,
    updatedAt: dbSkill.updatedAt,
  }

  const endTime = performance.now()

  // SMI-1184: Track skill view event (silent on failure)
  if (context.distinctId) {
    trackSkillView(context.distinctId, skill.id, 'mcp')
  }

  // SMI-3672: Fetch raw SKILL.md content from local DB (raw_content column)
  let content: string | undefined
  try {
    const contentRow = context.db
      .prepare('SELECT raw_content FROM skills WHERE id = ?')
      .get(skillId) as { raw_content: string | null } | undefined
    content = contentRow?.raw_content || undefined
  } catch {
    // raw_content column may not exist in pre-migration databases
    content = undefined
  }

  // SMI-2761: Populate also_installed from co-install repository
  const alsoInstalled: AlsoInstalledSkill[] = context.coInstallRepository.getTopCoInstalls(skill.id)

  // SMI-3137: Include dependency data
  const dbDependencies = context.skillDependencyRepository.getDependencies(skill.id)

  return {
    skill,
    installCommand: skill.installCommand || 'claude skill add ' + skill.id,
    // SMI-3672: Include SKILL.md content from local DB
    content,
    also_installed: alsoInstalled.length > 0 ? alsoInstalled : undefined,
    dependencies: dbDependencies.length > 0 ? dbDependencies : undefined,
    timing: {
      totalMs: Math.round(endTime - startTime),
    },
  }
}

// SMI-5360: formatSkillDetails (+ its trust-tier / score-bar helpers) lives in
// get-skill.format.ts to keep this file under the 500-line limit. Re-exported
// here so existing imports from '../tools/get-skill.js' keep working.
export { formatSkillDetails } from './get-skill.format.js'

// SMI-5017 W2.S2: wrap at export boundary
export const executeGetSkill = withTelemetry(executeGetSkillImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'get_skill',
  extractFramework: () => 'unknown',
})
