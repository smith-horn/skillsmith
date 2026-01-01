/**
 * @fileoverview Skill Activation Manager for one-click skill installation
 * @module @skillsmith/core/activation/ActivationManager
 * @see Phase 4: Trigger System Architecture - One-Click Activation
 *
 * Provides infrastructure for:
 * - Pre-validation before activation
 * - Background skill prefetching
 * - Hot-reload activation (no restart)
 * - Undo/rollback capability
 *
 * @example
 * const manager = new ActivationManager();
 * const result = await manager.activateSkill({
 *   skill_id: 'anthropic/commit',
 *   validate_first: true,
 *   hot_reload: true
 * });
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { homedir } from 'os'
import { createLogger } from '../utils/logger.js'

const log = createLogger('ActivationManager')

/**
 * Options for skill activation
 */
export interface ActivationOptions {
  /** Skill ID to activate */
  skill_id: string
  /** Validate skill before activating (default: true) */
  validate_first?: boolean
  /** Enable hot-reload without restart (default: true) */
  hot_reload?: boolean
  /** Auto-configure with defaults (default: false) */
  auto_configure?: boolean
  /** Force reinstall even if already installed */
  force?: boolean
}

/**
 * Result of skill activation
 */
export interface ActivationResult {
  /** Whether activation succeeded */
  success: boolean
  /** Skill ID that was activated */
  skill_id: string
  /** Time taken to activate (ms) */
  activation_time_ms: number
  /** Whether Claude restart is required */
  requires_restart: boolean
  /** Undo token for rollback (if successful) */
  undo_token?: string
  /** Error message (if failed) */
  error?: string
  /** Installation path */
  install_path?: string
}

/**
 * Undo snapshot for rollback
 */
interface UndoSnapshot {
  /** Unique undo token */
  token: string
  /** Skill ID */
  skill_id: string
  /** Installation path */
  install_path: string
  /** Timestamp of activation */
  activated_at: string
  /** Previous state (null if new installation) */
  previous_state: {
    existed: boolean
    backup_path?: string
  }
}

/**
 * Validation result
 */
interface ValidationResult {
  /** Whether skill is valid */
  valid: boolean
  /** Validation errors */
  errors: string[]
  /** Warnings (non-blocking) */
  warnings: string[]
}

/**
 * ActivationManager - Manages skill installation and activation
 *
 * Provides one-click skill activation with validation, prefetching,
 * hot-reload, and rollback capabilities.
 */
export class ActivationManager {
  private readonly skillsDir: string
  private readonly undoSnapshots: Map<string, UndoSnapshot> = new Map()
  private readonly prefetchCache: Map<string, boolean> = new Map()

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || path.join(homedir(), '.claude', 'skills')
    log.info('ActivationManager initialized', { skillsDir: this.skillsDir })
  }

  /**
   * Activate a skill with optional validation and hot-reload
   *
   * @param options - Activation options
   * @returns Activation result
   */
  async activateSkill(options: ActivationOptions): Promise<ActivationResult> {
    const startTime = performance.now()
    const { skill_id, validate_first = true, hot_reload = true, force = false } = options

    log.info('Activating skill', { skill_id, validate_first, hot_reload, force })

    try {
      // 1. Pre-validation
      if (validate_first) {
        const validation = await this.validateSkill(skill_id)
        if (!validation.valid) {
          return {
            success: false,
            skill_id,
            activation_time_ms: 0,
            requires_restart: false,
            error: `Validation failed: ${validation.errors.join(', ')}`,
          }
        }

        if (validation.warnings.length > 0) {
          log.warn('Skill validation warnings', { skill_id, warnings: validation.warnings })
        }
      }

      // 2. Check if already installed
      const installPath = this.getInstallPath(skill_id)
      const alreadyInstalled = await this.isInstalled(skill_id)

      if (alreadyInstalled && !force) {
        return {
          success: true,
          skill_id,
          activation_time_ms: Math.round(performance.now() - startTime),
          requires_restart: false,
          install_path: installPath,
        }
      }

      // 3. Create backup if reinstalling
      if (alreadyInstalled && force) {
        await this.createBackup(skill_id, installPath)
      }

      // 4. Prefetch skill (if not cached)
      await this.prefetchSkill(skill_id)

      // 5. Install skill
      await this.installSkill(skill_id, installPath)

      // 6. Hot-reload (if supported)
      let requiresRestart = true
      if (hot_reload) {
        const reloaded = await this.hotReload(installPath)
        requiresRestart = !reloaded
      }

      // 7. Create undo snapshot
      const undoToken = await this.createUndoSnapshot(skill_id, installPath, alreadyInstalled)

      const endTime = performance.now()

      return {
        success: true,
        skill_id,
        activation_time_ms: Math.round(endTime - startTime),
        requires_restart: requiresRestart,
        undo_token: undoToken,
        install_path: installPath,
      }
    } catch (error) {
      log.error('Skill activation failed', error instanceof Error ? error : undefined, { skill_id })

      return {
        success: false,
        skill_id,
        activation_time_ms: Math.round(performance.now() - startTime),
        requires_restart: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Undo a previous activation using undo token
   *
   * @param undoToken - Undo token from activation
   * @returns Whether undo succeeded
   */
  async undo(undoToken: string): Promise<boolean> {
    const snapshot = this.undoSnapshots.get(undoToken)

    if (!snapshot) {
      log.warn('Undo snapshot not found', { undoToken })
      return false
    }

    try {
      if (snapshot.previous_state.existed && snapshot.previous_state.backup_path) {
        // Restore from backup
        await fs.rm(snapshot.install_path, { recursive: true, force: true })
        await fs.rename(snapshot.previous_state.backup_path, snapshot.install_path)
        log.info('Restored skill from backup', { skill_id: snapshot.skill_id })
      } else {
        // Remove installation
        await fs.rm(snapshot.install_path, { recursive: true, force: true })
        log.info('Removed skill installation', { skill_id: snapshot.skill_id })
      }

      this.undoSnapshots.delete(undoToken)
      return true
    } catch (error) {
      log.error('Undo failed', error instanceof Error ? error : undefined, { undoToken })
      return false
    }
  }

  /**
   * Check if a skill is already installed
   */
  private async isInstalled(skillId: string): Promise<boolean> {
    const installPath = this.getInstallPath(skillId)
    try {
      await fs.access(installPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Get installation path for a skill
   */
  private getInstallPath(skillId: string): string {
    // Convert skill ID to directory name (e.g., anthropic/commit -> anthropic-commit)
    const dirName = skillId.replace('/', '-')
    return path.join(this.skillsDir, dirName)
  }

  /**
   * Validate skill before activation
   */
  private async validateSkill(skillId: string): Promise<ValidationResult> {
    const errors: string[] = []
    const warnings: string[] = []

    // Basic ID validation
    if (!skillId || skillId.trim().length === 0) {
      errors.push('Skill ID cannot be empty')
    }

    if (!skillId.includes('/')) {
      errors.push('Skill ID must be in format "author/name"')
    }

    // Check for valid characters
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(skillId)) {
      errors.push('Skill ID contains invalid characters')
    }

    // In production, would fetch and validate skill manifest
    // For now, just check basic structure
    const valid = errors.length === 0

    return { valid, errors, warnings }
  }

  /**
   * Prefetch skill metadata and files
   */
  private async prefetchSkill(skillId: string): Promise<void> {
    if (this.prefetchCache.has(skillId)) {
      log.debug('Skill already prefetched', { skillId })
      return
    }

    // In production, this would download skill files in background
    // For now, just mark as prefetched
    this.prefetchCache.set(skillId, true)
    log.debug('Skill prefetched', { skillId })
  }

  /**
   * Install skill to filesystem
   */
  private async installSkill(skillId: string, installPath: string): Promise<void> {
    // Ensure skills directory exists
    await fs.mkdir(this.skillsDir, { recursive: true })

    // Ensure install directory exists
    await fs.mkdir(installPath, { recursive: true })

    // In production, this would copy skill files from registry/download
    // For now, create a placeholder SKILL.md
    const skillMdPath = path.join(installPath, 'SKILL.md')
    const placeholder = `# ${skillId}\n\nSkill installed via one-click activation.\n`

    await fs.writeFile(skillMdPath, placeholder, 'utf-8')

    log.info('Skill installed', { skillId, installPath })
  }

  /**
   * Create backup of existing installation
   */
  private async createBackup(skillId: string, installPath: string): Promise<string> {
    const backupPath = `${installPath}.backup-${Date.now()}`
    await fs.rename(installPath, backupPath)
    log.info('Created backup', { skillId, backupPath })
    return backupPath
  }

  /**
   * Hot-reload skill without restarting Claude
   *
   * @returns Whether hot-reload succeeded
   */
  private async hotReload(installPath: string): Promise<boolean> {
    // In production, this would:
    // 1. Notify Claude to reload skills
    // 2. Re-parse SKILL.md
    // 3. Update skill registry
    //
    // For now, just check if path exists
    try {
      await fs.access(installPath)
      log.info('Hot-reload simulated', { installPath })
      return true
    } catch {
      log.warn('Hot-reload failed', { installPath })
      return false
    }
  }

  /**
   * Create undo snapshot for rollback
   */
  private async createUndoSnapshot(
    skillId: string,
    installPath: string,
    previouslyInstalled: boolean
  ): Promise<string> {
    const token = `undo-${skillId}-${Date.now()}`

    const snapshot: UndoSnapshot = {
      token,
      skill_id: skillId,
      install_path: installPath,
      activated_at: new Date().toISOString(),
      previous_state: {
        existed: previouslyInstalled,
      },
    }

    this.undoSnapshots.set(token, snapshot)
    log.debug('Created undo snapshot', { token, skillId })

    return token
  }

  /**
   * Get all undo snapshots
   */
  getUndoHistory(): UndoSnapshot[] {
    return Array.from(this.undoSnapshots.values())
  }

  /**
   * Clear undo history (e.g., on session end)
   */
  clearUndoHistory(): void {
    this.undoSnapshots.clear()
    log.debug('Cleared undo history')
  }
}

export default ActivationManager
