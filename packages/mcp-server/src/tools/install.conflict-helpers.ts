/**
 * @fileoverview Conflict Resolution Helper Functions for Skill Updates
 * @module @skillsmith/mcp-server/tools/install.conflict-helpers
 * @see SMI-1865
 *
 * Split from install.helpers.ts per governance code review (file size > 500 lines)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'

// ============================================================================
// Conflict Resolution Helpers (SMI-1865)
// ============================================================================

/**
 * SMI-1865: Compute SHA-256 hash of content for modification detection
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * SMI-1865: Result of modification detection
 */
export interface ModificationResult {
  /** Whether the file has been modified since installation */
  modified: boolean
  /** SHA-256 hash of the current content */
  currentHash: string
  /** SHA-256 hash of the original content at install time */
  originalHash: string
}

/**
 * SMI-1865: Detect if a skill has been modified since installation
 * @param installPath - Path to the installed skill directory
 * @param originalHash - SHA-256 hash of the original SKILL.md at install time
 * @returns ModificationResult indicating if the skill has been modified
 */
export async function detectModifications(
  installPath: string,
  originalHash: string
): Promise<ModificationResult> {
  const skillMdPath = path.join(installPath, 'SKILL.md')

  try {
    const currentContent = await fs.readFile(skillMdPath, 'utf-8')
    const currentHash = hashContent(currentContent)

    return {
      modified: currentHash !== originalHash,
      currentHash,
      originalHash,
    }
  } catch (error) {
    // If file doesn't exist, consider it modified (deleted)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        modified: true,
        currentHash: '',
        originalHash,
      }
    }
    throw error
  }
}

/**
 * SMI-1865: Base directory for skill backups
 */
const BACKUPS_DIR = path.join(os.homedir(), '.claude', 'skills', '.backups')

/**
 * SMI-1865: Create a timestamped backup of a skill before update
 * @param skillName - Name of the skill (used for directory naming)
 * @param installPath - Current install path of the skill
 * @param reason - Reason for creating the backup (e.g., 'pre-update', 'conflict')
 * @returns Path to the created backup directory
 */
export async function createSkillBackup(
  skillName: string,
  installPath: string,
  reason: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(BACKUPS_DIR, skillName, `${timestamp}_${reason}`)

  // Create backup directory
  await fs.mkdir(backupDir, { recursive: true })

  // Copy all files from install path to backup
  const entries = await fs.readdir(installPath, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(installPath, entry.name)
    const destPath = path.join(backupDir, entry.name)

    if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath)
    } else if (entry.isDirectory()) {
      // Recursively copy directories
      await copyDirectory(srcPath, destPath)
    }
  }

  return backupDir
}

/**
 * SMI-1865: Recursively copy a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath)
    } else if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath)
    }
  }
}

/**
 * SMI-1865: Store the original content of a skill at install time
 * Used for three-way merge during conflict resolution
 * @param skillName - Name of the skill
 * @param content - Original SKILL.md content
 * @param metadata - Additional metadata to store (version, source, etc.)
 */
export async function storeOriginal(
  skillName: string,
  content: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const originalDir = path.join(BACKUPS_DIR, skillName, '.original')

  // Create directory
  await fs.mkdir(originalDir, { recursive: true })

  // Store SKILL.md content
  await fs.writeFile(path.join(originalDir, 'SKILL.md'), content, 'utf-8')

  // Store metadata
  await fs.writeFile(path.join(originalDir, 'metadata.json'), JSON.stringify(metadata, null, 2))
}

/**
 * SMI-1865: Load the original SKILL.md content stored at install time
 * @param skillName - Name of the skill
 * @returns Original content, or null if not found
 */
export async function loadOriginal(skillName: string): Promise<string | null> {
  const originalPath = path.join(BACKUPS_DIR, skillName, '.original', 'SKILL.md')

  try {
    return await fs.readFile(originalPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * SMI-1865: Clean up old backups, keeping only the most recent ones
 * Never deletes the .original directory
 * @param skillName - Name of the skill
 * @param keepCount - Number of most recent backups to keep (default: 3)
 */
export async function cleanupOldBackups(skillName: string, keepCount: number = 3): Promise<void> {
  const skillBackupDir = path.join(BACKUPS_DIR, skillName)

  try {
    const entries = await fs.readdir(skillBackupDir, { withFileTypes: true })

    // Filter to only timestamped directories (not .original)
    const backupDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name !== '.original')
      .map((entry) => entry.name)
      .sort()
      .reverse() // Most recent first (ISO timestamps sort correctly)

    // Remove old backups beyond keepCount
    const toDelete = backupDirs.slice(keepCount)

    for (const dirName of toDelete) {
      const dirPath = path.join(skillBackupDir, dirName)
      await fs.rm(dirPath, { recursive: true, force: true })
    }
  } catch (error) {
    // If directory doesn't exist, nothing to clean up
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
}
