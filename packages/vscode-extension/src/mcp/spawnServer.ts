/**
 * MCP server spawn helper (SMI-5398).
 *
 * Extracted from McpClient.spawnServer to keep McpClient.ts under the 500-line
 * audit:standards gate. Resolves the configured command against an augmented
 * PATH (login-shell + node-manager dirs), injects the resolved env so a
 * GUI-launched VS Code can find node/npx, and routes the spawn timeline + server
 * stderr through the "Skillsmith MCP" OutputChannel.
 */
import type { ChildProcess } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { validateSpawnArgs } from '../utils/security.js'
import { resolveServerCommand, ServerCommandUnresolvedError } from './resolveServerCommand.js'
import { logMcp } from './mcpLog.js'

/** Wiring the McpClient supplies so the spawned process stays owned by the client. */
export interface SpawnServerHooks {
  serverCommand: string
  serverArgs: string[]
  connectionTimeout: number
  onData: (chunk: string) => void
  onDisconnect: () => void
}

/**
 * Resolve + spawn the MCP server process. Resolves with the live ChildProcess
 * once it has a pid. Throws {@link ServerCommandUnresolvedError} (carrying the
 * self-heal suggestion) when the configured command cannot be resolved.
 */
export async function spawnMcpServer(hooks: SpawnServerHooks): Promise<ChildProcess> {
  const resolved = await resolveServerCommand(hooks.serverCommand, hooks.serverArgs)
  if (resolved.kind === 'unresolved') {
    throw new ServerCommandUnresolvedError(resolved.command, resolved.selfHeal)
  }

  validateSpawnArgs(resolved.command, resolved.args)
  logMcp(`spawning ${resolved.command} (PATH +${String(resolved.pathDirsAdded.length)} dirs)`)

  return new Promise<ChildProcess>((resolve, reject) => {
    // Tracks a startup-time close so the pid check below rejects instead of
    // resolving with a process that already exited (mirrors the original
    // `this.process` nulling on disconnect).
    let disconnected = false

    const timeout = setTimeout(() => {
      reject(new Error('MCP server connection timeout'))
    }, hooks.connectionTimeout)

    const child = crossSpawn(resolved.command, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: resolved.env,
    })

    child.stdout?.on('data', (data: Buffer) => hooks.onData(data.toString()))

    child.stderr?.on('data', (data: Buffer) => {
      logMcp(`[server stderr] ${data.toString().trimEnd()}`)
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      disconnected = true
      logMcp(`spawn error: ${error.message}`)
      hooks.onDisconnect()
      reject(error)
    })

    child.on('close', (code) => {
      disconnected = true
      logMcp(`server process exited with code ${String(code)}`)
      hooks.onDisconnect()
    })

    // Wait a bit for the process to start.
    setTimeout(() => {
      clearTimeout(timeout)
      if (!disconnected && child.pid) {
        logMcp(`spawned pid=${String(child.pid)}`)
        resolve(child)
      } else {
        reject(new Error('Failed to start MCP server process'))
      }
    }, 500)
  })
}
