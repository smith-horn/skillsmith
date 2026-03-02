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
import { join, resolve } from 'path'
import { SkillsmithError, ErrorCodes } from '@skillsmith/core'
import { parseYamlFrontmatter, hasPathTraversal } from './validate.helpers.js'
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
})

export type SkillPackAuditInput = z.infer<typeof skillPackAuditInputSchema>

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
    'Audit a skill pack directory for version drift by comparing each bundled SKILL.md ' +
    'version against the Skillsmith registry cache. Reports which skills are current, ' +
    'outdated, ahead, or missing from the registry. ' +
    'Requires Individual tier or higher.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      pack_path: {
        type: 'string',
        description:
          'Absolute path to the skill pack root directory (must contain a skills/ subdirectory).',
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

  // Discover subdirectories in skills/
  let skillDirNames: string[]
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    skillDirNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    throw new SkillsmithError(
      ErrorCodes.SKILL_NOT_FOUND,
      `No skills/ directory found at ${skillsDir}`
    )
  }

  const skills: PackSkillEntry[] = []

  for (const dirName of skillDirNames) {
    const skillMdPath = join(skillsDir, dirName, 'SKILL.md')

    let content: string
    try {
      content = await fs.readFile(skillMdPath, 'utf-8')
    } catch {
      // No SKILL.md in this subdirectory — skip silently
      continue
    }

    const metadata = parseYamlFrontmatter(content)
    const name = typeof metadata?.name === 'string' && metadata.name ? metadata.name : dirName
    const rawVersion = typeof metadata?.version === 'string' ? metadata.version : null
    const bundledVersion = rawVersion && SEMVER_RE.test(rawVersion) ? rawVersion : null

    // Look up the most recently recorded registry version for this skill name.
    // skill_id format is "author/skill-name"; we match by name suffix.
    const row = context.db
      .prepare(
        `SELECT skill_id, semver
           FROM skill_versions
          WHERE skill_id LIKE '%/' || ?
          ORDER BY recorded_at DESC
          LIMIT 1`
      )
      .get(name) as { skill_id: string; semver: string | null } | undefined

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
  }

  const driftCount = skills.filter((s) => s.status === 'outdated' || s.status === 'ahead').length
  const noRegistryDataCount = skills.filter((s) => s.status === 'no_registry_data').length

  return {
    packPath,
    skillCount: skills.length,
    driftCount,
    noRegistryDataCount,
    skills,
  }
}
