/**
 * SMI-588: uninstall_skill MCP Tool
 * Safely removes installed skills
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Input schema
export const uninstallInputSchema = z.object({
  skillName: z.string().min(1).describe('Name of the skill to uninstall'),
  force: z.boolean().default(false).describe('Force removal even if modified'),
});

export type UninstallInput = z.infer<typeof uninstallInputSchema>;

// Output type
export interface UninstallResult {
  success: boolean;
  skillName: string;
  message: string;
  removedPath?: string;
  warning?: string;
}

// Paths
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const SKILLSMITH_DIR = path.join(os.homedir(), '.skillsmith');
const MANIFEST_PATH = path.join(SKILLSMITH_DIR, 'manifest.json');

interface SkillManifest {
  version: string;
  installedSkills: Record<string, {
    id: string;
    name: string;
    version: string;
    source: string;
    installPath: string;
    installedAt: string;
    lastUpdated: string;
  }>;
}

/**
 * Load manifest
 */
async function loadManifest(): Promise<SkillManifest> {
  try {
    const content = await fs.readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      version: '1.0.0',
      installedSkills: {},
    };
  }
}

/**
 * Save manifest
 */
async function saveManifest(manifest: SkillManifest): Promise<void> {
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

/**
 * Check if skill directory has been modified since installation
 */
async function checkForModifications(
  skillPath: string,
  installedAt: string
): Promise<boolean> {
  try {
    const installDate = new Date(installedAt);
    
    // Get all files in skill directory
    const files = await fs.readdir(skillPath, { withFileTypes: true });
    
    for (const file of files) {
      if (file.isFile()) {
        const filePath = path.join(skillPath, file.name);
        const stats = await fs.stat(filePath);
        
        // Check if modified after installation
        if (stats.mtime > installDate) {
          return true;
        }
      }
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Recursively remove directory
 */
async function removeDirectory(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
}

/**
 * Uninstall a skill
 */
export async function uninstallSkill(input: UninstallInput): Promise<UninstallResult> {
  const { skillName, force } = input;
  
  try {
    // Load manifest
    const manifest = await loadManifest();
    const skillEntry = manifest.installedSkills[skillName];
    
    // Check if skill exists in manifest
    if (!skillEntry) {
      // Still try to check the filesystem
      const potentialPath = path.join(CLAUDE_SKILLS_DIR, skillName);
      
      try {
        await fs.access(potentialPath);
        
        // Skill exists on disk but not in manifest
        if (!force) {
          return {
            success: false,
            skillName,
            message: `Skill "${skillName}" not in manifest but exists on disk. Use force=true to remove.`,
            warning: 'This skill was not installed via Skillsmith.',
          };
        }
        
        // Force remove
        await removeDirectory(potentialPath);
        return {
          success: true,
          skillName,
          message: `Skill "${skillName}" removed from disk (was not in manifest).`,
          removedPath: potentialPath,
        };
      } catch {
        return {
          success: false,
          skillName,
          message: `Skill "${skillName}" is not installed.`,
        };
      }
    }
    
    // Get install path
    const installPath = skillEntry.installPath;
    
    // Check for modifications
    if (!force) {
      const modified = await checkForModifications(installPath, skillEntry.installedAt);
      
      if (modified) {
        return {
          success: false,
          skillName,
          message: `Skill "${skillName}" has been modified since installation. Use force=true to remove anyway.`,
          warning: 'Local modifications will be lost if you force uninstall.',
        };
      }
    }
    
    // Remove skill directory
    try {
      await removeDirectory(installPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // Already removed, continue to update manifest
    }
    
    // Update manifest
    delete manifest.installedSkills[skillName];
    await saveManifest(manifest);
    
    return {
      success: true,
      skillName,
      message: `Skill "${skillName}" has been uninstalled successfully.`,
      removedPath: installPath,
    };
  } catch (error) {
    return {
      success: false,
      skillName,
      message: error instanceof Error ? error.message : 'Unknown error during uninstall',
    };
  }
}

/**
 * List all installed skills
 */
export async function listInstalledSkills(): Promise<string[]> {
  const manifest = await loadManifest();
  return Object.keys(manifest.installedSkills);
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
};

export default uninstallTool;
