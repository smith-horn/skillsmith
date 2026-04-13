/**
 * @fileoverview MCP Install Skill Tool for downloading and installing skills
 * @module @skillsmith/mcp-server/tools/install
 * @see SMI-2741: Split to meet 500-line standard
 * @see SMI-3137: Wave 4 — Dependency intelligence persistence
 * @see SMI-3483: Wave 0 — Delegate to SkillInstallationService from core
 *
 * Skills are installed to ~/.claude/skills/ and tracked in ~/.skillsmith/manifest.json
 *
 * The core install logic lives in @skillsmith/core SkillInstallationService.
 * This file is the MCP tool wrapper that:
 * - Bridges ToolContext to the service's constructor params
 * - Adds conflict resolution (three-way merge, backup) on top
 * - Wires onProgress to MCP protocol notifications
 */

import {
  SkillInstallationService,
  emitInstallEvent,
  type RegistryLookup,
  type RegistrySkillInfo,
} from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'
import { type InstallInput, type InstallResult } from './install.types.js'
import { loadManifest, lookupSkillFromRegistry } from './install.helpers.js'

// SMI-1867: Conflict resolution logic (extracted per governance review)
import { checkForConflicts } from './install.conflict.js'

// SMI-2741: MCP tool definition extracted to companion file
export { installTool } from './install.tool.js'
export { default } from './install.tool.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export { installInputSchema, type InstallInput, type InstallResult } from './install.types.js'

/**
 * Adapter that wraps ToolContext's registry lookup as a RegistryLookup.
 * Bridges the MCP-specific ToolContext to the core service abstraction.
 */
class McpRegistryLookup implements RegistryLookup {
  constructor(private context: ToolContext) {}

  async lookup(skillId: string): Promise<RegistrySkillInfo | null> {
    return lookupSkillFromRegistry(skillId, this.context)
  }
}

/**
 * Install a skill from GitHub to the local Claude Code skills directory.
 *
 * Delegates core logic to SkillInstallationService from @skillsmith/core.
 * Adds MCP-specific conflict resolution (three-way merge, backup).
 *
 * @param input - Installation parameters (skillId, force, skipScan)
 * @param _context - Optional tool context (falls back to singleton)
 * @returns Installation result with success status, security report, and dep intel
 */
export async function installSkill(
  input: InstallInput,
  _context?: ToolContext
): Promise<InstallResult> {
  const context = _context ?? getToolContext()

  // SMI-3483: Create core service instance with MCP context wiring
  // SMI-3873: aiDefenceFeedback omitted -- MCP server cannot call Ruflo tools.
  const service = new SkillInstallationService({
    db: context.db,
    skillRepo: context.skillRepository,
    skillDependencyRepo: context.skillDependencyRepository,
    registryLookup: new McpRegistryLookup(context),
    coInstallRecorder: context.coInstallRepository,
    sessionInstalledSkillIds: context.sessionInstalledSkillIds,
  })

  // SMI-1867: Pre-flight conflict check for reinstall with force
  // This is MCP-specific (three-way merge UI, backup, storeOriginal)
  if (input.force && input.conflictAction) {
    try {
      const manifest = await loadManifest()
      const skillName = extractSkillName(input.skillId)

      if (manifest.installedSkills[skillName]) {
        const installPath = manifest.installedSkills[skillName].installPath

        const conflictCheck = await checkForConflicts(
          skillName,
          installPath,
          manifest,
          input.conflictAction,
          input.skillId
        )

        if (!conflictCheck.shouldProceed) {
          return conflictCheck.earlyReturn!
        }
      }
    } catch {
      // Conflict check failed; proceed with normal install
    }
  }

  // Delegate to core service
  const installStart = Date.now()
  const result = await service.install(input.skillId, {
    force: input.force,
    skipScan: input.skipScan,
    skipOptimize: input.skipOptimize,
    conflictAction: input.conflictAction,
    confirmed: input.confirmed,
  })

  // SMI-4182: fire-and-forget install telemetry for usage report funnel
  void emitInstallEvent({
    skillId: input.skillId,
    source: 'mcp',
    success: result.success,
    durationMs: Date.now() - installStart,
  })

  return result
}

/**
 * Best-effort skill name extraction for conflict pre-check.
 * Does not need to be perfect -- just needs to match manifest keys.
 */
function extractSkillName(skillId: string): string {
  if (skillId.includes('/')) {
    const parts = skillId.split('/')
    return parts[parts.length - 1]
  }
  return skillId
}
