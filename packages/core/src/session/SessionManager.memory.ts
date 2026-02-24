/**
 * @fileoverview Session Manager Memory and Hook Operations
 * @module @skillsmith/core/session/SessionManager.memory
 * @see SMI-641: Session ID Storage in Claude-Flow Memory
 * @see SMI-1518: V3 API Migration
 * @see SMI-2741: Split from SessionManager.ts to meet 500-line standard
 *
 * Standalone functions for claude-flow memory storage, retrieval, deletion,
 * and hook invocation. Extracted to keep SessionManager.ts within the
 * 500-line limit while preserving all V3/spawn fallback logic.
 */

import type { CommandExecutor, MemoryResult } from './SessionManager.types.js'
import {
  getClaudeFlowMemory,
  getClaudeFlowMcp,
  MEMORY_KEYS,
  USE_V3_API,
  MEMORY_NAMESPACE,
  validateMemoryKey,
} from './SessionManager.helpers.js'

/**
 * Store data in claude-flow memory
 *
 * SMI-674: Uses spawn() with argument array to prevent command injection
 * SMI-1518: V3 API Migration - Use direct storeEntry() when available
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

  // SMI-1518, SMI-1609: Try V3 direct API first if enabled
  if (USE_V3_API) {
    try {
      const memoryModule = await getClaudeFlowMemory()
      if (memoryModule?.storeEntry) {
        const result = await memoryModule.storeEntry({
          key,
          value,
          namespace: MEMORY_NAMESPACE,
        })
        if (result.success) {
          return { success: true }
        }
        console.warn(`V3 storeEntry failed: ${result.error}, falling back to spawn`)
      }
    } catch (error) {
      console.warn(`V3 storeEntry exception: ${error}, falling back to spawn`)
    }
  }

  try {
    const args = ['claude-flow', 'memory', 'store', '--key', key, '--value', value]

    if (executor.spawn) {
      await executor.spawn('npx', args)
    } else {
      const escapedValue = value.replace(/'/g, "'\\''")
      const command = `npx claude-flow memory store --key "${key}" --value '${escapedValue}'`
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
 * Retrieve data from claude-flow memory
 *
 * SMI-674: Uses spawn() with argument array to prevent command injection
 * SMI-1518: V3 API Migration - Use direct getEntry() when available
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

  // SMI-1518, SMI-1609: Try V3 direct API first if enabled
  if (USE_V3_API) {
    try {
      const memoryModule = await getClaudeFlowMemory()
      if (memoryModule?.getEntry) {
        const result = await memoryModule.getEntry({
          key,
          namespace: MEMORY_NAMESPACE,
        })
        if (result.success && result.found && result.entry) {
          return { success: true, data: result.entry.content }
        }
        if (result.success && !result.found) {
          return { success: false, error: 'Key not found' }
        }
        console.warn(`V3 getEntry failed: ${result.error}, falling back to spawn`)
      }
    } catch (error) {
      console.warn(`V3 getEntry exception: ${error}, falling back to spawn`)
    }
  }

  try {
    const args = ['claude-flow', 'memory', 'get', '--key', key]

    let stdout: string
    if (executor.spawn) {
      const result = await executor.spawn('npx', args)
      stdout = result.stdout
    } else {
      const command = `npx claude-flow memory get --key "${key}"`
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
 * Delete data from claude-flow memory
 *
 * SMI-674: Uses spawn() with argument array to prevent command injection
 * SMI-1518: V3 API Migration - Use callMCPTool('memory/delete') when available
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

  // SMI-1518, SMI-1609: Try V3 MCP API first if enabled
  if (USE_V3_API) {
    try {
      const mcpModule = await getClaudeFlowMcp()
      if (mcpModule?.callMCPTool) {
        const result = (await mcpModule.callMCPTool('memory/delete', { key })) as {
          success: boolean
          deleted: boolean
        }
        if (result.success) {
          return { success: true }
        }
        console.warn(`V3 memory/delete failed, falling back to spawn`)
      }
    } catch (error) {
      const mcpModule = await getClaudeFlowMcp()
      const MCPClientError = mcpModule?.MCPClientError
      if (!MCPClientError || !(error instanceof MCPClientError)) {
        console.warn(`V3 memory/delete exception: ${error}, falling back to spawn`)
      }
    }
  }

  try {
    const args = ['claude-flow', 'memory', 'delete', '--key', key]

    if (executor.spawn) {
      await executor.spawn('npx', args)
    } else {
      const command = `npx claude-flow memory delete --key "${key}"`
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
 * SMI-1518: V3 API Migration - Use callMCPTool('hooks/pre-task') when available
 *
 * @param description - Task description
 * @param executor - Command executor for spawn/execute fallback
 */
export async function runPreTaskHook(
  description: string,
  executor: CommandExecutor
): Promise<void> {
  // SMI-1518, SMI-1609: Try V3 MCP API first if enabled
  if (USE_V3_API) {
    try {
      const mcpModule = await getClaudeFlowMcp()
      if (mcpModule?.callMCPTool) {
        await mcpModule.callMCPTool('hooks/pre-task', {
          description,
          memoryKey: MEMORY_KEYS.CURRENT,
        })
        return
      }
    } catch {
      // V3 API not available or failed, fall back to spawn
    }
  }

  try {
    const args = [
      'claude-flow',
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
      const command = `npx claude-flow hooks pre-task --description '${escapedDesc}' --memory-key "session/current"`
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
 * SMI-1518: V3 API Migration - Use callMCPTool('hooks/post-task') when available
 *
 * @param taskId - Task ID to pass to the hook
 * @param executor - Command executor for spawn/execute fallback
 */
export async function runPostTaskHook(taskId: string, executor: CommandExecutor): Promise<void> {
  // SMI-1518, SMI-1609: Try V3 MCP API first if enabled
  if (USE_V3_API) {
    try {
      const mcpModule = await getClaudeFlowMcp()
      if (mcpModule?.callMCPTool) {
        await mcpModule.callMCPTool('hooks/post-task', {
          taskId,
        })
        return
      }
    } catch {
      // V3 API not available or failed, fall back to spawn
    }
  }

  try {
    const args = ['claude-flow', 'hooks', 'post-task', '--task-id', taskId]

    if (executor.spawn) {
      await executor.spawn('npx', args)
    } else {
      const command = `npx claude-flow hooks post-task --task-id "${taskId}"`
      await executor.execute(command)
    }
  } catch {
    // Hooks are optional, don't fail if they don't work
  }
}
