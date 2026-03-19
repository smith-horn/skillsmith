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
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'

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
 * Uninstall a skill from the local Claude Code skills directory.
 *
 * Delegates to SkillInstallationService from @skillsmith/core.
 *
 * @param input - Uninstall parameters
 * @param _context - Optional tool context (falls back to singleton)
 * @returns Promise resolving to uninstall result with success status
 */
export async function uninstallSkill(
  input: UninstallInput,
  _context?: ToolContext
): Promise<UninstallResult> {
  const context = _context ?? getToolContext()

  const service = new SkillInstallationService({
    db: context.db,
    skillRepo: context.skillRepository,
    skillDependencyRepo: context.skillDependencyRepository,
  })

  return service.uninstall(input.skillName, { force: input.force })
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
  description: 'Uninstall a Claude Code skill from ~/.claude/skills/',
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
