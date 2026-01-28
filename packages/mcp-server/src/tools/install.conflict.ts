/**
 * @fileoverview Conflict Resolution Logic for Skill Installation
 * @module @skillsmith/mcp-server/tools/install.conflict
 * @see SMI-1867
 *
 * Extracted from install.ts per governance code review (file size > 500 lines)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { SkillManifest } from './install.types.js'
import type { ConflictInfo, ConflictAction, InstallResult, SkillManifestEntry } from './install.types.js'
import {
  detectModifications,
  createSkillBackup,
  cleanupOldBackups,
  loadOriginal,
  storeOriginal,
  hashContent,
} from './install.helpers.js'
import { threeWayMerge } from './merge.js'
import { updateManifestSafely } from './install.helpers.js'

/**
 * Result of conflict detection check
 */
export interface ConflictCheckResult {
  /** Whether to proceed with installation */
  shouldProceed: boolean
  /** Path to backup if created */
  backupPath?: string
  /** Early return result if installation should stop */
  earlyReturn?: InstallResult
}

/**
 * Check for conflicts when reinstalling a skill with modifications
 *
 * @param skillName - Name of the skill being installed
 * @param installPath - Path where skill is/will be installed
 * @param manifest - Current skill manifest
 * @param conflictAction - User's chosen action (or undefined)
 * @param skillId - Skill ID for result
 * @returns ConflictCheckResult indicating how to proceed
 */
export async function checkForConflicts(
  skillName: string,
  installPath: string,
  manifest: SkillManifest,
  conflictAction: ConflictAction | undefined,
  skillId: string
): Promise<ConflictCheckResult> {
  const existingEntry = manifest.installedSkills[skillName] as SkillManifestEntry | undefined

  if (!existingEntry?.originalContentHash) {
    return { shouldProceed: true }
  }

  const modResult = await detectModifications(installPath, existingEntry.originalContentHash)

  if (!modResult.modified) {
    return { shouldProceed: true }
  }

  // Skill has local modifications - need conflictAction
  if (!conflictAction) {
    // Return conflict info, require user to choose action
    const conflictInfo: ConflictInfo = {
      hasLocalModifications: true,
      localHash: modResult.currentHash,
      upstreamHash: '', // Will be set after fetching upstream
      originalHash: modResult.originalHash,
      modifiedFiles: ['SKILL.md'],
    }

    return {
      shouldProceed: false,
      earlyReturn: {
        success: false,
        skillId,
        installPath,
        conflict: conflictInfo,
        requiresAction: ['overwrite', 'merge', 'cancel'] as ConflictAction[],
        tips: [
          'Skill "' + skillName + '" has local modifications.',
          'Choose an action:',
          '  - overwrite: Backup local changes, replace with new version',
          '  - merge: Attempt three-way merge preserving your changes',
          '  - cancel: Abort installation',
        ],
      },
    }
  }

  // Handle cancel action
  if (conflictAction === 'cancel') {
    return {
      shouldProceed: false,
      earlyReturn: {
        success: false,
        skillId,
        installPath,
        error: 'Installation cancelled by user',
      },
    }
  }

  // Handle overwrite action - create backup
  if (conflictAction === 'overwrite') {
    const backupPath = await createSkillBackup(skillName, installPath, 'pre-update')
    await cleanupOldBackups(skillName, 3)
    return { shouldProceed: true, backupPath }
  }

  // For merge, proceed - actual merge happens after fetching upstream
  return { shouldProceed: true }
}

/**
 * Result of merge operation
 */
export interface MergeOperationResult {
  /** Whether to proceed with normal installation */
  shouldProceed: boolean
  /** Modified content after merge (if successful clean merge) */
  mergedContent?: string
  /** Path to backup if created */
  backupPath?: string
  /** Early return result if installation should stop */
  earlyReturn?: InstallResult
}

/**
 * Handle merge action for conflict resolution
 *
 * @param skillName - Name of the skill
 * @param installPath - Installation path
 * @param upstreamContent - Content fetched from upstream
 * @param manifest - Current manifest
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param skillId - Skill ID for result
 * @returns MergeOperationResult indicating how to proceed
 */
export async function handleMergeAction(
  skillName: string,
  installPath: string,
  upstreamContent: string,
  manifest: SkillManifest,
  owner: string,
  repo: string,
  skillId: string
): Promise<MergeOperationResult> {
  const existingEntry = manifest.installedSkills[skillName] as SkillManifestEntry | undefined

  // Load original and current content
  const originalContent = await loadOriginal(skillName)
  let currentContent: string
  try {
    currentContent = await fs.readFile(path.join(installPath, 'SKILL.md'), 'utf-8')
  } catch {
    currentContent = '' // File deleted, treat as empty
  }

  if (!originalContent) {
    // No original content stored - fall back to overwrite behavior
    console.warn(
      '[install] No original content found for merge, falling back to overwrite for: ' + skillName
    )
    return { shouldProceed: true }
  }

  const mergeResult = threeWayMerge(originalContent, currentContent, upstreamContent)

  if (mergeResult.success) {
    // Clean merge - use merged content
    return {
      shouldProceed: true,
      mergedContent: mergeResult.merged!,
    }
  }

  // Merge has conflicts - write with conflict markers
  const backupPath = await createSkillBackup(skillName, installPath, 'pre-merge')
  await cleanupOldBackups(skillName, 3)

  // Write the file with conflict markers so user can resolve
  await fs.mkdir(installPath, { recursive: true })
  await fs.writeFile(path.join(installPath, 'SKILL.md'), mergeResult.merged!)

  // Store the new original for future conflict detection
  const upstreamHash = hashContent(upstreamContent)
  await storeOriginal(skillName, upstreamContent, {
    version: existingEntry?.version || '1.0.0',
    source: 'github:' + owner + '/' + repo,
    installedAt: existingEntry?.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  // Update manifest with new hash (based on upstream, not merged)
  await updateManifestSafely((currentManifest) => ({
    ...currentManifest,
    installedSkills: {
      ...currentManifest.installedSkills,
      [skillName]: {
        ...currentManifest.installedSkills[skillName],
        lastUpdated: new Date().toISOString(),
        originalContentHash: upstreamHash,
      },
    },
  }))

  return {
    shouldProceed: false,
    backupPath,
    earlyReturn: {
      success: true,
      skillId,
      installPath,
      mergeResult: mergeResult,
      tips: [
        'Skill merged with ' + (mergeResult.conflicts?.length || 0) + ' conflict(s).',
        'Open ' + path.join(installPath, 'SKILL.md') + ' to resolve conflicts manually.',
        'Look for <<<<<<< LOCAL and >>>>>>> UPSTREAM markers.',
        'Backup created at: ' + backupPath,
      ],
    },
  }
}
