/**
 * MCP Client for VS Code Extension
 * Manages communication with the Skillsmith MCP server
 */
import * as vscode from 'vscode'
import { spawn, type ChildProcess } from 'child_process'
import {
  type McpConnectionStatus,
  type McpClientConfig,
  type McpSearchResponse,
  type McpGetSkillResponse,
  type McpInstallResponse,
  type McpUninstallResponse,
  DEFAULT_MCP_CONFIG,
} from './types.js'

// Re-export McpClientConfig from types for external use
export type { McpClientConfig } from './types.js'

/** JSON-RPC request ID counter */
let requestId = 0

/**
 * JSON-RPC request structure
 */
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown> | undefined
}

/**
 * JSON-RPC response structure
 */
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

/**
 * MCP Client for communicating with the Skillsmith MCP server
 */
export class McpClient {
  private process: ChildProcess | null = null
  private status: McpConnectionStatus = 'disconnected'
  private config: McpClientConfig
  private pendingRequests: Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }
  > = new Map()
  private buffer = ''
  private reconnectAttempts = 0
  private statusChangeListeners: ((status: McpConnectionStatus) => void)[] = []

  constructor(config: Partial<McpClientConfig> = {}) {
    this.config = { ...DEFAULT_MCP_CONFIG, ...config }
  }

  /**
   * Get current connection status
   */
  getStatus(): McpConnectionStatus {
    return this.status
  }

  /**
   * Register a status change listener
   */
  onStatusChange(listener: (status: McpConnectionStatus) => void): vscode.Disposable {
    this.statusChangeListeners.push(listener)
    return new vscode.Disposable(() => {
      const index = this.statusChangeListeners.indexOf(listener)
      if (index !== -1) {
        this.statusChangeListeners.splice(index, 1)
      }
    })
  }

  /**
   * Update status and notify listeners
   */
  private setStatus(status: McpConnectionStatus): void {
    this.status = status
    this.statusChangeListeners.forEach((listener) => listener(status))
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return
    }

    this.setStatus('connecting')

    try {
      await this.spawnServer()
      await this.initialize()
      this.setStatus('connected')
      this.reconnectAttempts = 0
    } catch (error) {
      this.setStatus('error')
      throw error
    }
  }

  /**
   * Spawn the MCP server process
   */
  private async spawnServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MCP server connection timeout'))
      }, this.config.connectionTimeout)

      this.process = spawn(this.config.serverCommand, this.config.serverArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      })

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString())
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error('[MCP Server]', data.toString())
      })

      this.process.on('error', (error) => {
        clearTimeout(timeout)
        this.handleDisconnect()
        reject(error)
      })

      this.process.on('close', (code) => {
        console.log(`[MCP Server] Process exited with code ${code}`)
        this.handleDisconnect()
      })

      // Wait a bit for the process to start
      setTimeout(() => {
        clearTimeout(timeout)
        if (this.process?.pid) {
          resolve()
        } else {
          reject(new Error('Failed to start MCP server process'))
        }
      }, 500)
    })
  }

  /**
   * Initialize the MCP connection
   */
  private async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'skillsmith-vscode',
        version: '0.1.0',
      },
    })

    if (!result) {
      throw new Error('MCP server initialization failed')
    }

    // Send initialized notification
    this.sendNotification('notifications/initialized', {})
  }

  /**
   * Handle incoming data from the server
   */
  private handleData(data: string): void {
    this.buffer += data

    // Process complete JSON-RPC messages
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const response = JSON.parse(line) as JsonRpcResponse
        this.handleResponse(response)
      } catch {
        // Not valid JSON, may be partial message
        console.warn('[MCP Client] Failed to parse response:', line)
      }
    }
  }

  /**
   * Handle a JSON-RPC response
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      console.warn('[MCP Client] Received response for unknown request:', response.id)
      return
    }

    this.pendingRequests.delete(response.id)

    if (response.error) {
      pending.reject(new Error(response.error.message))
    } else {
      pending.resolve(response.result)
    }
  }

  /**
   * Handle server disconnect
   */
  private handleDisconnect(): void {
    this.process = null
    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error('MCP server disconnected'))
    })
    this.pendingRequests.clear()

    if (this.status === 'connected' && this.config.autoReconnect) {
      this.setStatus('disconnected')
      if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
        this.reconnectAttempts++
        console.log(
          `[MCP Client] Attempting reconnect (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`
        )
        setTimeout(() => void this.connect(), 1000 * this.reconnectAttempts)
      } else {
        this.setStatus('error')
      }
    } else {
      this.setStatus('disconnected')
    }
  }

  /**
   * Send a JSON-RPC request
   */
  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('MCP server not connected'))
        return
      }

      const id = ++requestId
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      this.pendingRequests.set(id, { resolve, reject })
      this.process.stdin.write(JSON.stringify(request) + '\n')

      // Timeout for individual requests
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`Request timeout: ${method}`))
        }
      }, 30000)
    })
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      return
    }

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    }

    this.process.stdin.write(JSON.stringify(notification) + '\n')
  }

  /**
   * Call an MCP tool
   */
  private async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (this.status !== 'connected') {
      throw new Error('MCP client not connected')
    }

    const result = (await this.sendRequest('tools/call', {
      name,
      arguments: args,
    })) as { content: { type: string; text: string }[]; isError?: boolean }

    if (result.isError) {
      const errorText = result.content[0]?.text || 'Unknown error'
      throw new Error(errorText)
    }

    const text = result.content[0]?.text
    if (!text) {
      throw new Error('Empty response from MCP server')
    }

    return JSON.parse(text) as T
  }

  /**
   * Search for skills
   */
  async search(
    query: string,
    options?: {
      category?: string
      trustTier?: string
      minScore?: number
    }
  ): Promise<McpSearchResponse> {
    return this.callTool<McpSearchResponse>('search', {
      query,
      ...options,
    })
  }

  /**
   * Get skill details
   */
  async getSkill(id: string): Promise<McpGetSkillResponse> {
    return this.callTool<McpGetSkillResponse>('get_skill', { id })
  }

  /**
   * Install a skill
   */
  async installSkill(
    skillId: string,
    options?: {
      force?: boolean
      skipScan?: boolean
    }
  ): Promise<McpInstallResponse> {
    return this.callTool<McpInstallResponse>('install_skill', {
      skillId,
      ...options,
    })
  }

  /**
   * Uninstall a skill
   */
  async uninstallSkill(skillId: string): Promise<McpUninstallResponse> {
    return this.callTool<McpUninstallResponse>('uninstall_skill', { skillId })
  }

  /**
   * Disconnect from the MCP server
   */
  disconnect(): void {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this.setStatus('disconnected')
    this.pendingRequests.clear()
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.status === 'connected'
  }
}

/**
 * Singleton MCP client instance
 */
let mcpClientInstance: McpClient | null = null

/**
 * Get the singleton MCP client instance
 */
export function getMcpClient(): McpClient {
  if (!mcpClientInstance) {
    mcpClientInstance = new McpClient()
  }
  return mcpClientInstance
}

/**
 * Initialize the MCP client with custom configuration
 */
export function initializeMcpClient(config?: Partial<McpClientConfig>): McpClient {
  if (mcpClientInstance) {
    mcpClientInstance.disconnect()
  }
  mcpClientInstance = new McpClient(config)
  return mcpClientInstance
}

/**
 * Dispose the MCP client
 */
export function disposeMcpClient(): void {
  if (mcpClientInstance) {
    mcpClientInstance.disconnect()
    mcpClientInstance = null
  }
}
