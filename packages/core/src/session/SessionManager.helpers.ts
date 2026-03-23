/**
 * Session Manager Helper Functions and Classes
 * @module @skillsmith/core/session/SessionManager.helpers
 */

import { spawn } from 'node:child_process'
import type { CommandExecutor } from './SessionManager.types.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Memory key patterns for session storage
 */
export const MEMORY_KEYS = {
  CURRENT: 'session/current',
  SESSION_PREFIX: 'session/',
  CHECKPOINT_PREFIX: 'checkpoint/',
} as const

// ============================================================================
// Validation
// ============================================================================

/**
 * Pattern for safe memory keys
 * Only allows alphanumeric characters, hyphens, underscores, and forward slashes
 */
const SAFE_KEY_PATTERN = /^[a-zA-Z0-9/_-]+$/

/**
 * Validates a memory key to prevent injection attacks
 */
export function validateMemoryKey(key: string): boolean {
  return SAFE_KEY_PATTERN.test(key) && key.length <= 256
}

// ============================================================================
// Default Command Executor
// ============================================================================

/**
 * Default command executor using child_process.spawn
 * Uses argument arrays to prevent command injection
 */
export class DefaultCommandExecutor implements CommandExecutor {
  /**
   * @deprecated Legacy string-based execution - use spawn instead
   */
  async execute(command: string): Promise<{ stdout: string; stderr: string }> {
    // For backwards compatibility only - prefer spawn()
    return this.executeWithSpawn(command)
  }

  /**
   * Secure spawn-based execution with argument array
   */
  async spawn(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(executable, args, {
        shell: false,
        env: { ...process.env },
        timeout: 30000,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
        } else {
          reject(new Error(stderr || `Command failed with code ${code}`))
        }
      })

      proc.on('error', (err) => {
        reject(err)
      })
    })
  }

  /**
   * Parse legacy string command and execute via spawn
   */
  private async executeWithSpawn(command: string): Promise<{ stdout: string; stderr: string }> {
    // Parse the command safely
    const parts = command.split(' ')
    const executable = parts[0]
    const args = parts.slice(1)
    return this.spawn(executable, args)
  }
}
