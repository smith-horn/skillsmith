/**
 * @fileoverview skill_pack_audit MCP tool — detect version drift in a skill pack
 * @module @skillsmith/mcp-server/tools/skill-pack-audit
 * @see SMI-2905: Skill registry version drift detection
 *
 * Scans a skill pack directory (pack_path/skills/{name}/SKILL.md), reads each
 * skill's bundled version: frontmatter, and compares it against the latest
 * semver recorded in the local skill_versions registry cache.
 *
 * Status values:
 *  - current          — bundled version matches registry
 *  - outdated         — registry has a newer version
 *  - ahead            — bundled version is newer than registry cache
 *  - no_registry_data — skill not found in local skill_versions cache
 *  - missing_version  — SKILL.md has no valid version: field
 *
 * Tier gate: Individual (version_tracking feature flag).
 * Community users see a graceful license error response, never a hard throw.
 */

import { z } from 'zod'
import { promises as fs } from 'fs'
import { basename, join, resolve, sep } from 'path'
import { SkillsmithError, ErrorCodes, GENERIC_TRIGGERS } from '@skillsmith/core'
import { parseYamlFrontmatter, hasPathTraversal } from './validate.helpers.js'
import {
  detectGenericTriggerWords,
  detectGenericNamespace,
  derivePackDomain,
} from './skill-pack-audit.helpers.js'
import type {
  GenericWordFlag,
  NamespaceFlag,
  TriggerQuality,
  TriggerQualityEntry,
} from './skill-pack-audit.types.js'
import type { ToolContext } from '../context.js'

// ============================================================================
// Input / Output types
// ============================================================================

/**
 * Input schema for skill_pack_audit tool
 */
export const skillPackAuditInputSchema = z.object({
  pack_path: z
    .string()
    .min(1)
    .describe(
      'Absolute path to the skill pack root directory. ' +
        'Must contain a skills/ subdirectory with skill folders each containing SKILL.md.'
    ),
  check_trigger_quality: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'When true (default), also flag generic trigger words in skill name/description ' +
        'and generic pack namespaces with rename suggestions. Set false for ' +
        'version-drift-only audits (legacy response shape). SMI-4124.'
    ),
})

export type SkillPackAuditInput = z.input<typeof skillPackAuditInputSchema>

/**
 * Drift status for a single skill in the pack
 */
export type PackSkillStatus =
  | 'current'
  | 'outdated'
  | 'ahead'
  | 'no_registry_data'
  | 'missing_version'

/**
 * Per-skill audit result
 */
export interface PackSkillEntry {
  /** Skill name from SKILL.md frontmatter (falls back to directory name) */
  name: string
  /** Version string from the pack's SKILL.md frontmatter, or null if absent */
  bundledVersion: string | null
  /** Latest semver from the local skill_versions registry cache, or null */
  registryVersion: string | null
  /** Registry skill identifier (e.g. "author/skill-name") or null if not found */
  skillId: string | null
  /** Drift status */
  status: PackSkillStatus
}

/**
 * Full response from skill_pack_audit tool
 */
export interface SkillPackAuditResponse {
  /** Resolved absolute path to the pack */
  packPath: string
  /** Total number of skills found in the pack */
  skillCount: number
  /** Number of skills where bundled version differs from registry (outdated + ahead) */
  driftCount: number
  /** Number of skills not found in the local registry cache */
  noRegistryDataCount: number
  /** Per-skill audit results, sorted alphabetically by name */
  skills: PackSkillEntry[]
  /**
   * SMI-4124: Trigger-quality analysis across the pack (generic trigger words
   * in skill names/descriptions). Present when `check_trigger_quality` is `true`
   * (default). Omitted when the caller explicitly opts out.
   */
  triggerQuality?: TriggerQuality
  /**
   * SMI-4124: Namespace-quality flag on the pack itself. Present (possibly
   * `null`) when `check_trigger_quality` is `true`. `null` = clean pack name.
   * Omitted when the caller opts out.
   */
  namespaceQuality?: NamespaceFlag | null
}

// ============================================================================
// Tool schema (MCP tool definition)
// ============================================================================

/**
 * MCP tool definition for skill_pack_audit
 */
export const skillPackAuditToolSchema = {
  name: 'skill_pack_audit' as const,
  description:
    'Audit a skill pack directory for (a) version drift — bundled SKILL.md versions vs. ' +
    'the Skillsmith registry cache — and (b) trigger-quality issues — generic trigger ' +
    'words in skill names/descriptions and generic pack namespaces that misfire ' +
    "Claude's skill-trigger heuristic (SMI-4124). Response is additive: new " +
    'triggerQuality and namespaceQuality fields appear when check_trigger_quality is ' +
    'true (default); existing fields (skills, driftCount, etc.) are unchanged. ' +
    'Requires Individual tier or higher.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      pack_path: {
        type: 'string',
        description:
          'Absolute path to the skill pack root directory (must contain a skills/ subdirectory).',
      },
      check_trigger_quality: {
        type: 'boolean',
        default: true,
        description:
          'When true (default), also flag generic trigger words and generic pack ' +
          'namespaces with rename suggestions. Set false for version-drift-only audits ' +
          '(legacy response shape — triggerQuality and namespaceQuality fields omitted).',
      },
    },
    required: ['pack_path'],
  },
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Compare two semver strings.
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 * Both inputs must be valid "X.Y.Z" semver strings.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1
  }
  return 0
}

/** Semver validation regex — matches only X.Y.Z (no pre-release) */
const SEMVER_RE = /^\d+\.\d+\.\d+$/

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute the skill_pack_audit tool.
 *
 * Scans pack_path/skills/{name}/SKILL.md, parses each skill's name and version
 * from frontmatter, and compares the bundled version against the most recently
 * recorded semver in the local skill_versions table (matched by skill name suffix).
 *
 * @param input   Validated tool input
 * @param context Tool context with database connection
 * @returns SkillPackAuditResponse with per-skill drift status
 */
export async function executeSkillPackAudit(
  input: SkillPackAuditInput,
  context: ToolContext
): Promise<SkillPackAuditResponse> {
  // Security: reject path traversal in the pack_path itself
  if (hasPathTraversal(input.pack_path)) {
    throw new SkillsmithError(
      ErrorCodes.VALIDATION_INVALID_TYPE,
      'pack_path contains a path traversal pattern'
    )
  }

  const packPath = resolve(input.pack_path)
  const skillsDir = join(packPath, 'skills')
  const packName = basename(packPath)
  const checkTriggerQuality = input.check_trigger_quality !== false

  // Discover subdirectories in skills/
  let skillDirNames: string[]
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    skillDirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    throw new SkillsmithError(
      ErrorCodes.SKILL_NOT_FOUND,
      `No skills/ directory found at ${skillsDir}`
    )
  }

  if (skillDirNames.length > 500) {
    throw new SkillsmithError(
      ErrorCodes.VALIDATION_INVALID_TYPE,
      `Pack contains ${skillDirNames.length} skill directories; maximum is 500`
    )
  }

  const skills: PackSkillEntry[] = []
  // SMI-4124: parallel accumulators for trigger-quality analysis.
  // We keep these outside PackSkillEntry to preserve the legacy response shape
  // for callers who opt out of trigger-quality via check_trigger_quality: false.
  const skillMeta: Array<{ name: string; description: unknown; tags?: unknown }> = []

  for (const dirName of skillDirNames) {
    const skillMdPath = join(skillsDir, dirName, 'SKILL.md')

    let resolvedMdPath: string
    try {
      resolvedMdPath = await fs.realpath(skillMdPath)
    } catch {
      continue
    }
    if (!resolvedMdPath.startsWith(packPath + sep)) continue

    let content: string
    try {
      content = await fs.readFile(resolvedMdPath, 'utf-8')
    } catch {
      continue
    }

    const metadata = parseYamlFrontmatter(content)
    const name = typeof metadata?.name === 'string' && metadata.name ? metadata.name : dirName
    const rawVersion = typeof metadata?.version === 'string' ? metadata.version : null
    const bundledVersion = rawVersion && SEMVER_RE.test(rawVersion) ? rawVersion : null

    // Look up the most recently recorded registry version for this skill name.
    // skill_id format is "author/skill-name"; we match by name suffix.
    // Escape LIKE special characters in name to prevent injection.
    // Backslash must be escaped first (before adding backslash-prefixed escapes for % and _).
    const escapedName = name.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    const row = context.db
      .prepare(
        `SELECT skill_id, semver
           FROM skill_versions
          WHERE skill_id LIKE '%/' || ? ESCAPE '\\'
          ORDER BY recorded_at DESC
          LIMIT 1`
      )
      .get(escapedName) as { skill_id: string; semver: string | null } | undefined

    let status: PackSkillStatus
    let registryVersion: string | null = null
    let skillId: string | null = null

    if (!bundledVersion) {
      status = 'missing_version'
    } else if (!row || !row.semver || !SEMVER_RE.test(row.semver)) {
      status = 'no_registry_data'
    } else {
      registryVersion = row.semver
      skillId = row.skill_id
      const cmp = compareSemver(bundledVersion, registryVersion)
      if (cmp === 0) status = 'current'
      else if (cmp < 0) status = 'outdated'
      else status = 'ahead'
    }

    skills.push({ name, bundledVersion, registryVersion, skillId, status })
    // Capture description/tags for SMI-4124 trigger-quality analysis. We read
    // these out of metadata (already parsed) regardless of the flag, since the
    // cost is trivial; the analysis itself is gated below.
    skillMeta.push({
      name,
      description: metadata?.description,
      tags: metadata?.tags,
    })
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))

  const driftCount = skills.filter((s) => s.status === 'outdated' || s.status === 'ahead').length
  const noRegistryDataCount = skills.filter((s) => s.status === 'no_registry_data').length

  // SMI-4124: Trigger-quality + namespace analysis (additive response growth).
  // When the caller opts out, we omit both fields so the response shape matches
  // the pre-extension contract byte-for-byte.
  if (!checkTriggerQuality) {
    return {
      packPath,
      skillCount: skills.length,
      driftCount,
      noRegistryDataCount,
      skills,
    }
  }

  const stoplist = GENERIC_TRIGGERS
  const packDomain = derivePackDomain(packName, skillMeta, stoplist)

  // Per-skill flags (sorted alphabetically by skill name to match `skills`).
  const sortedMeta = [...skillMeta].sort((a, b) => a.name.localeCompare(b.name))
  const triggerEntries: TriggerQualityEntry[] = []
  const nameFlagsByToken = new Map<string, GenericWordFlag[]>()

  for (const meta of sortedMeta) {
    const flags = detectGenericTriggerWords(meta.description, meta.name, packDomain, stoplist)
    if (flags.length > 0) {
      triggerEntries.push({ id: meta.name, flags })
      // Track name-level flags so we can dedup against a namespace hit below.
      for (const flag of flags) {
        if (flag.location === 'name') {
          const list = nameFlagsByToken.get(flag.token) ?? []
          list.push(flag)
          nameFlagsByToken.set(flag.token, list)
        }
      }
    }
  }

  // Namespace flag + dedup: if the pack name is generic AND a skill-name flag
  // exists for the same root token, drop the duplicate skill-name error and
  // fold its reason into the namespace warning's reason.
  let namespaceFlag = detectGenericNamespace(packName, skillMeta, stoplist)
  if (namespaceFlag) {
    const packToken = packName.toLowerCase()
    // Check if any skill-name flag shares a token with the pack name. Typical
    // case: pack "skills" and a skill named "skills" — not common — but also
    // covers partial-token overlap like pack "tools" and skill "build-tools"
    // (namespace covers the generic concern; skill-name flag is redundant).
    const overlappingTokens: string[] = []
    for (const [token] of nameFlagsByToken) {
      if (packToken === token || packToken.includes(token) || token.includes(packToken)) {
        overlappingTokens.push(token)
      }
    }
    if (overlappingTokens.length > 0) {
      // Remove the overlapping name flags from triggerEntries.
      for (let i = triggerEntries.length - 1; i >= 0; i--) {
        const entry = triggerEntries[i]!
        entry.flags = entry.flags.filter(
          (f) => !(f.location === 'name' && overlappingTokens.includes(f.token))
        )
        if (entry.flags.length === 0) {
          triggerEntries.splice(i, 1)
        }
      }
      // Merge the removed-flag reasoning into the namespace reason.
      namespaceFlag = {
        ...namespaceFlag,
        reason:
          namespaceFlag.reason +
          ` Also applies to skill(s) whose name contains the same generic token(s): ` +
          overlappingTokens.map((t) => `"${t}"`).join(', ') +
          ` — resolved by renaming the pack namespace.`,
      }
    }
  }

  let totalFlags = 0
  let errorCount = 0
  let warningCount = 0
  for (const entry of triggerEntries) {
    for (const flag of entry.flags) {
      totalFlags++
      if (flag.severity === 'error') errorCount++
      else warningCount++
    }
  }

  const triggerQuality: TriggerQuality = {
    skills: triggerEntries,
    summary: { totalFlags, errorCount, warningCount },
  }

  return {
    packPath,
    skillCount: skills.length,
    driftCount,
    noRegistryDataCount,
    skills,
    triggerQuality,
    namespaceQuality: namespaceFlag,
  }
}
