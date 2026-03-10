/**
 * @fileoverview skill_outdated MCP tool — check installed skills for updates and dependency status
 * @module @skillsmith/mcp-server/tools/outdated
 * @see SMI-3138: Wave 5 — Dependency intelligence outdated tool
 *
 * Reads the local manifest (~/.skillsmith/manifest.json), hashes each installed
 * SKILL.md, and compares against the latest content hash in skill_versions.
 * Optionally includes dependency satisfaction status from skill_dependencies.
 *
 * Tier gate: Community (null feature flag — no license required).
 *
 * Hash display: truncated to 8 chars for human readability (full hash stored).
 */

import { z } from 'zod'
import { promises as fs } from 'fs'
import * as path from 'path'
import { SkillVersionRepository } from '@skillsmith/core'
import type { SkillDependencyRow } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { hashContent } from './install.conflict-helpers.js'
import { loadManifest } from './install.helpers.js'
import type { SkillManifestEntry } from './install.types.js'

// ============================================================================
// Input / Output types
// ============================================================================

/**
 * Input schema for skill_outdated tool
 */
export const outdatedInputSchema = z.object({
  /** Include dependency satisfaction status in results (default: true) */
  include_deps: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include dependency satisfaction status (default: true)'),
})

export type OutdatedInput = z.infer<typeof outdatedInputSchema>

/**
 * Dependency satisfaction details for a single skill
 */
export interface DependencyStatus {
  total: number
  satisfied: string[]
  missing: string[]
}

/**
 * Per-skill outdated information returned by the tool
 */
export interface OutdatedSkillInfo {
  /** Registry skill identifier (e.g. "author/skill-name") */
  id: string
  /** 8-char prefix of the locally-installed content hash */
  installed_hash: string
  /** 8-char prefix of the latest registry hash */
  latest_hash: string
  /** Status of the skill: current, outdated, or unknown (no registry data) */
  status: 'current' | 'outdated' | 'unknown'
  /** Semver from the latest version record, if available */
  semver: string | null
  /** Dependency satisfaction details (omitted when include_deps is false) */
  dependencies?: DependencyStatus
}

/**
 * Summary counts for the outdated check
 */
export interface OutdatedSummary {
  total_installed: number
  outdated: number
  up_to_date: number
  unknown: number
  missing_deps: number
}

/**
 * Response from skill_outdated tool
 */
export interface OutdatedResponse {
  skills: OutdatedSkillInfo[]
  summary: OutdatedSummary
}

// ============================================================================
// Tool schema (MCP tool definition)
// ============================================================================

/**
 * MCP tool definition for skill_outdated
 */
export const outdatedToolSchema = {
  name: 'skill_outdated' as const,
  description:
    'Check installed skills for available updates and dependency satisfaction status. ' +
    'Reads the local manifest, hashes each installed SKILL.md, and compares against the ' +
    'latest registry state. Community tier — no license required.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      include_deps: {
        type: 'boolean',
        description: 'Include dependency satisfaction status (default: true)',
      },
    },
    required: [],
  },
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read and hash the installed SKILL.md content.
 * Returns null if the file cannot be read.
 */
async function readInstalledHash(installPath: string): Promise<string | null> {
  const skillMdPath = path.join(installPath, 'SKILL.md')
  try {
    const content = await fs.readFile(skillMdPath, 'utf-8')
    return hashContent(content)
  } catch {
    return null
  }
}

/**
 * Check dependency satisfaction for a skill.
 * - skill_hard / skill_soft / skill_peer: satisfied if dep_target is in installedSkillIds
 * - mcp_server / model_minimum / other: marked satisfied (best-effort, can't verify)
 */
function checkDependencies(
  deps: SkillDependencyRow[],
  installedSkillIds: Set<string>
): DependencyStatus {
  const satisfied: string[] = []
  const missing: string[] = []

  for (const dep of deps) {
    const label = `${dep.dep_type}:${dep.dep_target}`

    if (
      dep.dep_type === 'skill_hard' ||
      dep.dep_type === 'skill_soft' ||
      dep.dep_type === 'skill_peer'
    ) {
      if (installedSkillIds.has(dep.dep_target)) {
        satisfied.push(label)
      } else {
        missing.push(label)
      }
    } else {
      // mcp_server, model_minimum, etc. — can't reliably verify, mark satisfied
      satisfied.push(label)
    }
  }

  return { total: deps.length, satisfied, missing }
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute the skill_outdated tool.
 *
 * 1. Reads the manifest. If missing/empty, returns an empty result.
 * 2. For each installed skill, hashes the local SKILL.md and compares
 *    against the latest entry in skill_versions.
 * 3. If include_deps is true, queries skill_dependencies for each skill
 *    and checks whether skill-type deps are installed.
 *
 * @param input   Validated tool input
 * @param context Tool context with database connection
 * @returns OutdatedResponse with per-skill status and summary
 */
export async function executeOutdated(
  input: OutdatedInput,
  context: ToolContext
): Promise<OutdatedResponse> {
  const manifest = await loadManifest()
  const entries = Object.values(manifest.installedSkills) as SkillManifestEntry[]

  if (entries.length === 0) {
    return {
      skills: [],
      summary: {
        total_installed: 0,
        outdated: 0,
        up_to_date: 0,
        unknown: 0,
        missing_deps: 0,
      },
    }
  }

  const versionRepo = new SkillVersionRepository(context.db)
  const depRepo = context.skillDependencyRepository

  // Build set of installed skill IDs for dependency checking
  const installedSkillIds = new Set<string>(entries.map((e) => e.id))

  const skills: OutdatedSkillInfo[] = []
  let outdatedCount = 0
  let upToDateCount = 0
  let unknownCount = 0
  let missingDepsCount = 0

  for (const entry of entries) {
    // Hash the currently installed SKILL.md
    const localHash = await readInstalledHash(entry.installPath)

    // Get latest version from registry cache
    const history = await versionRepo.getVersionHistory(entry.id, 1)

    let status: 'current' | 'outdated' | 'unknown'
    let latestHash: string
    let semver: string | null = null

    if (history.length === 0 || localHash === null) {
      status = 'unknown'
      latestHash = localHash?.slice(0, 8) ?? '--------'
      unknownCount++
    } else {
      const latest = history[0]
      semver = latest.semver
      latestHash = latest.content_hash.slice(0, 8)

      if (localHash === latest.content_hash) {
        status = 'current'
        upToDateCount++
      } else {
        status = 'outdated'
        outdatedCount++
      }
    }

    const skillInfo: OutdatedSkillInfo = {
      id: entry.id,
      installed_hash: localHash?.slice(0, 8) ?? '--------',
      latest_hash: latestHash,
      status,
      semver,
    }

    // Dependency satisfaction
    if (input.include_deps) {
      const deps = depRepo.getDependencies(entry.id)
      if (deps.length > 0) {
        const depStatus = checkDependencies(deps, installedSkillIds)
        skillInfo.dependencies = depStatus
        if (depStatus.missing.length > 0) {
          missingDepsCount++
        }
      } else {
        skillInfo.dependencies = { total: 0, satisfied: [], missing: [] }
      }
    }

    skills.push(skillInfo)
  }

  return {
    skills,
    summary: {
      total_installed: entries.length,
      outdated: outdatedCount,
      up_to_date: upToDateCount,
      unknown: unknownCount,
      missing_deps: missingDepsCount,
    },
  }
}
