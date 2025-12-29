/**
 * Status bar indicator for MCP connection status
 */
import * as vscode from 'vscode'
import { type McpConnectionStatus } from './types.js'
import { getMcpClient } from './McpClient.js'

/**
 * Status bar item for showing MCP connection status
 */
export class McpStatusBar {
  private statusBarItem: vscode.StatusBarItem
  private disposables: vscode.Disposable[] = []

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.statusBarItem.command = 'skillsmith.mcpReconnect'
    this.updateStatus('disconnected')
  }

  /**
   * Initialize and show the status bar
   */
  initialize(): void {
    const client = getMcpClient()
    const subscription = client.onStatusChange((status) => {
      this.updateStatus(status)
    })
    this.disposables.push(subscription)

    // Show with initial status
    this.updateStatus(client.getStatus())
    this.statusBarItem.show()
  }

  /**
   * Update the status bar based on connection status
   */
  updateStatus(status: McpConnectionStatus): void {
    switch (status) {
      case 'connected':
        this.statusBarItem.text = '$(plug) Skillsmith'
        this.statusBarItem.tooltip = 'Connected to Skillsmith MCP server\nClick to reconnect'
        this.statusBarItem.backgroundColor = undefined
        break

      case 'connecting':
        this.statusBarItem.text = '$(sync~spin) Skillsmith'
        this.statusBarItem.tooltip = 'Connecting to Skillsmith MCP server...'
        this.statusBarItem.backgroundColor = undefined
        break

      case 'disconnected':
        this.statusBarItem.text = '$(plug) Skillsmith (Offline)'
        this.statusBarItem.tooltip = 'Disconnected from Skillsmith MCP server\nClick to connect'
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        )
        break

      case 'error':
        this.statusBarItem.text = '$(error) Skillsmith'
        this.statusBarItem.tooltip = 'Failed to connect to Skillsmith MCP server\nClick to retry'
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
        break
    }
  }

  /**
   * Dispose the status bar
   */
  dispose(): void {
    this.statusBarItem.dispose()
    this.disposables.forEach((d) => d.dispose())
  }
}

/**
 * Create and register the MCP reconnect command
 */
export function registerMcpCommands(context: vscode.ExtensionContext): void {
  const reconnectCommand = vscode.commands.registerCommand('skillsmith.mcpReconnect', async () => {
    const client = getMcpClient()

    if (client.isConnected()) {
      const action = await vscode.window.showInformationMessage(
        'Already connected to MCP server',
        'Reconnect',
        'Disconnect'
      )

      if (action === 'Reconnect') {
        client.disconnect()
        await connectWithProgress()
      } else if (action === 'Disconnect') {
        client.disconnect()
        vscode.window.showInformationMessage('Disconnected from MCP server')
      }
    } else {
      await connectWithProgress()
    }
  })

  context.subscriptions.push(reconnectCommand)
}

/**
 * Connect to MCP server with progress indicator
 */
export async function connectWithProgress(): Promise<boolean> {
  const client = getMcpClient()

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Connecting to Skillsmith MCP server...',
      cancellable: false,
    },
    async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
      progress.report({ increment: 0 })

      try {
        await client.connect()
        progress.report({ increment: 100 })
        vscode.window.showInformationMessage('Connected to Skillsmith MCP server')
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        vscode.window.showErrorMessage(`Failed to connect to MCP server: ${message}`)
        return false
      }
    }
  )
}
