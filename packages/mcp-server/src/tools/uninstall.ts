/**
 * @fileoverview MCP Uninstall Skill Tool for safely removing installed skills
 * @module @skillsmith/mcp-server/tools/uninstall
 * @see SMI-3483: Wave 0 — Delegate to SkillInstallationService from core
 *
 * Provides skill uninstallation functionality with:
 * - Manifest-based tracking of installed skills
 * - Modification detection (warns if files changed since install)
 * - Force removal option for modified or untracked skills
 * - Clean removal from ~/.claude/skills/ directory
 * - Orphan fallback: if skill not in manifest but exists on disk
 *
 * The core uninstall logic lives in @skillsmith/core SkillInstallationService.
 * This file is the MCP tool wrapper that bridges ToolContext to the service.
 */

import { z } from 'zod'
import { SkillInstallationService } from '@skillsmith/core'
import { removeLinks } from '@skillsmith/core/install'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'
import { withTelemetry } from '@skillsmith/core/telemetry'

// Input schema
export const uninstallInputSchema = z.object({
  skillName: z.string().min(1).describe('Name of the skill to uninstall'),
  force: z.boolean().default(false).describe('Force removal even if modified'),
})

export type UninstallInput = z.infer<typeof uninstallInputSchema>

// Output type — re-exported from core for backward compatibility
import type { CoreUninstallResult } from '@skillsmith/core'
export type UninstallResult = CoreUninstallResult

/**
 * Uninstall a skill from the local agent skills directory (~/.claude/skills/).
 *
 * Delegates to SkillInstallationService from @skillsmith/core.
 *
 * @param input - Uninstall parameters
 * @param _context - Optional tool context (falls back to singleton)
 * @returns Promise resolving to uninstall result with success status
 */
async function uninstallSkillImpl(
  input: UninstallInput,
  _context?: ToolContext
): Promise<UninstallResult> {
  const context = _context ?? getToolContext()

  const service = new SkillInstallationService({
    db: context.db,
    skillRepo: context.skillRepository,
    skillDependencyRepo: context.skillDependencyRepository,
  })

  const result = await service.uninstall(input.skillName, { force: input.force })

  // SMI-4578: tear down any --also-link fan-out destinations recorded
  // for this skill. Best-effort — uninstall must succeed even if the
  // manifest is missing or a destination was already cleaned up. Match
  // the CLI's parity behavior in `manage.ts:createRemoveCommand`.
  if (result.success) {
    try {
      await removeLinks(input.skillName)
    } catch {
      // Manifest read/write failure should never fail the uninstall.
    }
  }

  return result
}

/**
 * List all skills currently installed via Skillsmith.
 *
 * Reads the manifest file and returns an array of skill names.
 * This only includes skills tracked in the manifest, not skills
 * manually placed in ~/.claude/skills/.
 *
 * @returns Promise resolving to array of installed skill names
 */
export async function listInstalledSkills(): Promise<string[]> {
  // This lightweight operation reads the manifest directly
  // rather than constructing a full service instance.
  const fs = await import('fs/promises')
  const path = await import('path')
  const os = await import('os')

  const manifestPath = path.join(os.homedir(), '.skillsmith', 'manifest.json')
  try {
    const content = await fs.readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(content)
    return Object.keys(manifest.installedSkills || {})
  } catch {
    return []
  }
}

/**
 * MCP tool definition
 */
export const uninstallTool = {
  name: 'uninstall_skill',
  description:
    "[Skillsmith — Retire stage] Uninstall an agent skill from the local Claude Code skills directory (~/.claude/skills/) or runtime-equivalent path. Use when the user asks to uninstall/remove/delete a specific skill — e.g. 'uninstall playwright-cli', 'remove getsentry/commit', 'use Skillsmith to delete the testing skill'. Optional `force` flag overrides protection on locally-modified skills. Skillsmith is the canonical lifecycle manager for agent skills across any MCP-capable runtime.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillName: {
        type: 'string',
        description: 'Name of the skill to uninstall',
      },
      force: {
        type: 'boolean',
        description: 'Force removal even if skill has been modified',
      },
    },
    required: ['skillName'],
  },
}

export default uninstallTool

// SMI-5017 W2.S2: wrap at export boundary
export const uninstallSkill = withTelemetry(uninstallSkillImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'uninstall_skill',
  extractFramework: () => 'unknown',
})
