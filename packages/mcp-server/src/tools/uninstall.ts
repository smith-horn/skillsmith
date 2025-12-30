/**
 * @fileoverview MCP Uninstall Skill Tool for safely removing installed skills
 * @module @skillsmith/mcp-server/tools/uninstall
 * @see {@link https://github.com/wrsmith108/skillsmith|Skillsmith Repository}
 *
 * Provides skill uninstallation functionality with:
 * - Manifest-based tracking of installed skills
 * - Modification detection (warns if files changed since install)
 * - Force removal option for modified or untracked skills
 * - Clean removal from ~/.claude/skills/ directory
 *
 * @example
 * // Uninstall a skill
 * const result = await uninstallSkill({ skillName: 'commit' });
 * if (result.success) {
 *   console.log(result.message);
 * }
 *
 * @example
 * // Force uninstall modified skill
 * const result = await uninstallSkill({
 *   skillName: 'my-custom-skill',
 *   force: true
 * });
 */

import { z } from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { ToolContext } from '../context.js'

// Input schema
export const uninstallInputSchema = z.object({
  skillName: z.string().min(1).describe('Name of the skill to uninstall'),
  force: z.boolean().default(false).describe('Force removal even if modified'),
})

export type UninstallInput = z.infer<typeof uninstallInputSchema>

// Output type
export interface UninstallResult {
  success: boolean
  skillName: string
  message: string
  removedPath?: string
  warning?: string
}

// Paths
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')
const SKILLSMITH_DIR = path.join(os.homedir(), '.skillsmith')
const MANIFEST_PATH = path.join(SKILLSMITH_DIR, 'manifest.json')

interface SkillManifest {
  version: string
  installedSkills: Record<
    string,
    {
      id: string
      name: string
      version: string
      source: string
      installPath: string
      installedAt: string
      lastUpdated: string
    }
  >
}

/**
 * Load manifest
 */
async function loadManifest(): Promise<SkillManifest> {
  try {
    const content = await fs.readFile(MANIFEST_PATH, 'utf-8')
    return JSON.parse(content)
  } catch {
    return {
      version: '1.0.0',
      installedSkills: {},
    }
  }
}

/**
 * Save manifest
 */
async function saveManifest(manifest: SkillManifest): Promise<void> {
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true })
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

/**
 * Check if skill directory has been modified since installation
 */
async function checkForModifications(skillPath: string, installedAt: string): Promise<boolean> {
  try {
    const installDate = new Date(installedAt)

    // Get all files in skill directory
    const files = await fs.readdir(skillPath, { withFileTypes: true })

    for (const file of files) {
      if (file.isFile()) {
        const filePath = path.join(skillPath, file.name)
        const stats = await fs.stat(filePath)

        // Check if modified after installation
        if (stats.mtime > installDate) {
          return true
        }
      }
    }

    return false
  } catch {
    return false
  }
}

/**
 * Recursively remove directory
 */
async function removeDirectory(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true })
}

/**
 * Uninstall a skill from the local Claude Code skills directory.
 *
 * This function:
 * 1. Loads the manifest to find the skill
 * 2. Checks for local modifications (warns unless force=true)
 * 3. Removes the skill directory from ~/.claude/skills/
 * 4. Updates the manifest to remove the skill entry
 *
 * If the skill exists on disk but not in manifest, force=true is required.
 *
 * @param input - Uninstall parameters
 * @param input.skillName - Name of the skill to uninstall
 * @param input.force - Force removal even if modified (default: false)
 * @returns Promise resolving to uninstall result with success status
 *
 * @example
 * // Standard uninstall
 * const result = await uninstallSkill({ skillName: 'jest-helper' });
 * if (result.success) {
 *   console.log(`Removed from ${result.removedPath}`);
 * }
 *
 * @example
 * // Handle modified skill
 * const result = await uninstallSkill({ skillName: 'custom-skill' });
 * if (!result.success && result.warning) {
 *   console.log(result.warning); // 'Local modifications will be lost...'
 *   // Ask user confirmation, then:
 *   await uninstallSkill({ skillName: 'custom-skill', force: true });
 * }
 *
 * @example
 * // Check if skill is installed first
 * const installed = await listInstalledSkills();
 * if (installed.includes('my-skill')) {
 *   await uninstallSkill({ skillName: 'my-skill' });
 * }
 */
export async function uninstallSkill(
  input: UninstallInput,
  _context?: ToolContext
): Promise<UninstallResult> {
  const { skillName, force } = input

  try {
    // Load manifest
    const manifest = await loadManifest()
    const skillEntry = manifest.installedSkills[skillName]

    // Check if skill exists in manifest
    if (!skillEntry) {
      // Still try to check the filesystem
      const potentialPath = path.join(CLAUDE_SKILLS_DIR, skillName)

      try {
        await fs.access(potentialPath)

        // Skill exists on disk but not in manifest
        if (!force) {
          return {
            success: false,
            skillName,
            message: `Skill "${skillName}" not in manifest but exists on disk. Use force=true to remove.`,
            warning: 'This skill was not installed via Skillsmith.',
          }
        }

        // Force remove
        await removeDirectory(potentialPath)
        return {
          success: true,
          skillName,
          message: `Skill "${skillName}" removed from disk (was not in manifest).`,
          removedPath: potentialPath,
        }
      } catch {
        return {
          success: false,
          skillName,
          message: `Skill "${skillName}" is not installed.`,
        }
      }
    }

    // Get install path
    const installPath = skillEntry.installPath

    // Check for modifications
    if (!force) {
      const modified = await checkForModifications(installPath, skillEntry.installedAt)

      if (modified) {
        return {
          success: false,
          skillName,
          message: `Skill "${skillName}" has been modified since installation. Use force=true to remove anyway.`,
          warning: 'Local modifications will be lost if you force uninstall.',
        }
      }
    }

    // Remove skill directory
    try {
      await removeDirectory(installPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      // Already removed, continue to update manifest
    }

    // Update manifest
    delete manifest.installedSkills[skillName]
    await saveManifest(manifest)

    return {
      success: true,
      skillName,
      message: `Skill "${skillName}" has been uninstalled successfully.`,
      removedPath: installPath,
    }
  } catch (error) {
    return {
      success: false,
      skillName,
      message: error instanceof Error ? error.message : 'Unknown error during uninstall',
    }
  }
}

/**
 * List all skills currently installed via Skillsmith.
 *
 * Reads the manifest file and returns an array of skill names.
 * This only includes skills tracked in the manifest, not skills
 * manually placed in ~/.claude/skills/.
 *
 * @returns Promise resolving to array of installed skill names
 *
 * @example
 * const skills = await listInstalledSkills();
 * console.log(`${skills.length} skills installed:`);
 * skills.forEach(s => console.log(`  - ${s}`));
 */
export async function listInstalledSkills(): Promise<string[]> {
  const manifest = await loadManifest()
  return Object.keys(manifest.installedSkills)
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
