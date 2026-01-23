/**
 * Session Manager Helper Functions and Classes
 * @module @skillsmith/core/session/SessionManager.helpers
 */

import { spawn } from 'node:child_process'
import type {
  ClaudeFlowMemoryModule,
  ClaudeFlowMcpModule,
  CommandExecutor,
} from './SessionManager.types.js'

// ============================================================================
// Module Loading State
// ============================================================================

// Use symbol to distinguish "not yet attempted" from "attempted but failed (undefined)"
const NOT_LOADED = Symbol('not-loaded')
let claudeFlowMemory: ClaudeFlowMemoryModule | undefined | typeof NOT_LOADED = NOT_LOADED
let claudeFlowMcp: ClaudeFlowMcpModule | undefined | typeof NOT_LOADED = NOT_LOADED

// Module paths are constructed dynamically to prevent ESM static analysis
const CLAUDE_FLOW_BASE = 'claude-flow'
const MEMORY_MODULE_PATH = '/v3/@claude-flow/cli/dist/src/memory/memory-initializer.js'
const MCP_MODULE_PATH = '/v3/@claude-flow/cli/dist/src/mcp-client.js'

// ============================================================================
// Dynamic Module Loaders
// ============================================================================

/**
 * Lazily load claude-flow memory module
 * Returns undefined if claude-flow is not installed
 *
 * Uses string concatenation for the import path to prevent Node.js
 * ESM static analysis from resolving the module at parse time.
 */
export async function getClaudeFlowMemory(): Promise<ClaudeFlowMemoryModule | undefined> {
  if (claudeFlowMemory === NOT_LOADED) {
    try {
      // String concatenation prevents static analysis
      const modulePath = CLAUDE_FLOW_BASE + MEMORY_MODULE_PATH
      claudeFlowMemory = await import(/* webpackIgnore: true */ modulePath)
    } catch {
      claudeFlowMemory = undefined // Mark as attempted but failed
    }
  }
  return claudeFlowMemory === NOT_LOADED ? undefined : claudeFlowMemory
}

/**
 * Lazily load claude-flow MCP module
 * Returns undefined if claude-flow is not installed
 *
 * Uses string concatenation for the import path to prevent Node.js
 * ESM static analysis from resolving the module at parse time.
 */
export async function getClaudeFlowMcp(): Promise<ClaudeFlowMcpModule | undefined> {
  if (claudeFlowMcp === NOT_LOADED) {
    try {
      // String concatenation prevents static analysis
      const modulePath = CLAUDE_FLOW_BASE + MCP_MODULE_PATH
      claudeFlowMcp = await import(/* webpackIgnore: true */ modulePath)
    } catch {
      claudeFlowMcp = undefined // Mark as attempted but failed
    }
  }
  return claudeFlowMcp === NOT_LOADED ? undefined : claudeFlowMcp
}

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

/**
 * SMI-1518: Feature flag to enable V3 direct API
 * Set CLAUDE_FLOW_USE_V3_API=true to use direct API calls
 * Falls back to spawn-based CLI if not set or if V3 API fails
 */
export const USE_V3_API = process.env.CLAUDE_FLOW_USE_V3_API === 'true'

/**
 * Default namespace for session memory entries
 */
export const MEMORY_NAMESPACE = 'skillsmith-sessions'

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
