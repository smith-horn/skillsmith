/**
 * @fileoverview Session Manager Memory and Hook Operations
 * @module @skillsmith/core/session/SessionManager.memory
 * @see SMI-641: Session ID Storage in Claude-Flow Memory
 * @see SMI-2741: Split from SessionManager.ts to meet 500-line standard
 * @see SMI-3600: Remove dead V3 dynamic imports (claude-flow → ruflo rename)
 * @see SMI-3601: Migrate npx claude-flow CLI calls to npx ruflo
 *
 * Standalone functions for ruflo memory storage, retrieval, deletion,
 * and hook invocation. Extracted to keep SessionManager.ts within the
 * 500-line limit.
 */

import type { CommandExecutor, MemoryResult } from './SessionManager.types.js'
import { validateMemoryKey } from './SessionManager.helpers.js'

/**
 * Store data in ruflo memory
 *
 * SMI-674: Uses spawn() with argument array to prevent command injection
 * SMI-3601: Migrated from claude-flow to ruflo
 *
 * @param key - Memory key
 * @param value - Value to store
 * @param executor - Command executor for spawn/execute fallback
 * @returns Memory operation result
 */
export async function storeMemoryEntry(
  key: string,
  value: string,
  executor: CommandExecutor
): Promise<MemoryResult> {
  if (!validateMemoryKey(key)) {
    return { success: false, error: 'Invalid memory key' }
  }

  try {
    const args = ['ruflo', 'memory', 'store', '--key', key, '--value', value]

    if (executor.spawn) {
      await executor.spawn('npx', args)
    } else {
      const escapedValue = value.replace(/'/g, "'\\''")
      const command = `npx ruflo memory store --key "${key}" --value '${escapedValue}'`
      await executor.execute(command)
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Retrieve data from ruflo memory
 *
 * SMI-674: Uses spawn() with argument array to prevent command injection
 * SMI-3601: Migrated from claude-flow to ruflo
 *
 * @param key - Memory key
 * @param executor - Command executor for spawn/execute fallback
 * @returns Memory operation result with data
 */
export async function retrieveMemoryEntry(
  key: string,
  executor: CommandExecutor
): Promise<MemoryResult> {
  if (!validateMemoryKey(key)) {
    return { success: false, error: 'Invalid memory key' }
  }

  try {
    const args = ['ruflo', 'memory', 'get', '--key', key]

    let stdout: string
    if (executor.spawn) {
      const result = await executor.spawn('npx', args)
      stdout = result.stdout
    } else {
      const command = `npx ruflo memory get --key "${key}"`
      const result = await executor.execute(command)
      stdout = result.stdout
    }
    return { success: true, data: stdout.trim() }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Delete data from ruflo memory
 *
 * SMI-674: Uses spawn() with argument array to prevent command injection
 * SMI-3601: Migrated from claude-flow to ruflo
 *
 * @param key - Memory key to delete
 * @param executor - Command executor for spawn/execute fallback
 * @returns Memory operation result
 */
export async function deleteMemoryEntry(
  key: string,
  executor: CommandExecutor
): Promise<MemoryResult> {
  if (!validateMemoryKey(key)) {
    return { success: false, error: 'Invalid memory key' }
  }

  try {
    const args = ['ruflo', 'memory', 'delete', '--key', key]

    if (executor.spawn) {
      await executor.spawn('npx', args)
    } else {
      const command = `npx ruflo memory delete --key "${key}"`
      await executor.execute(command)
    }
    return { success: true }
  } catch {
    // Ignore delete errors (key may not exist)
    return { success: true }
  }
}

/**
 * Run pre-task hook
 *
 * SMI-674: Uses spawn() with argument array to prevent command injection
 * SMI-3601: Migrated from claude-flow to ruflo
 *
 * @param description - Task description
 * @param executor - Command executor for spawn/execute fallback
 */
export async function runPreTaskHook(
  description: string,
  executor: CommandExecutor
): Promise<void> {
  try {
    const args = [
      'ruflo',
      'hooks',
      'pre-task',
      '--description',
      description,
      '--memory-key',
      'session/current',
    ]

    if (executor.spawn) {
      await executor.spawn('npx', args)
    } else {
      const escapedDesc = description.replace(/'/g, "'\\''")
      const command = `npx ruflo hooks pre-task --description '${escapedDesc}' --memory-key "session/current"`
      await executor.execute(command)
    }
  } catch {
    // Hooks are optional, don't fail if they don't work
  }
}

/**
 * Run post-task hook
 *
 * SMI-674: Uses spawn() with argument array to prevent command injection
 * SMI-3601: Migrated from claude-flow to ruflo
 *
 * @param taskId - Task ID to pass to the hook
 * @param executor - Command executor for spawn/execute fallback
 */
export async function runPostTaskHook(taskId: string, executor: CommandExecutor): Promise<void> {
  try {
    const args = ['ruflo', 'hooks', 'post-task', '--task-id', taskId]

    if (executor.spawn) {
      await executor.spawn('npx', args)
    } else {
      const command = `npx ruflo hooks post-task --task-id "${taskId}"`
      await executor.execute(command)
    }
  } catch {
    // Hooks are optional, don't fail if they don't work
  }
}
