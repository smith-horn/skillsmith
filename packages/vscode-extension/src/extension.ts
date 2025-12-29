/**
 * Skillsmith VS Code Extension
 * Provides skill discovery and installation directly in VS Code
 */
import * as vscode from 'vscode'
import { SkillTreeProvider } from './providers/SkillTreeProvider.js'
import { SkillSearchProvider } from './providers/SkillSearchProvider.js'
import { registerSearchCommand } from './commands/searchSkills.js'
import { registerInstallCommand } from './commands/installSkill.js'
import { SkillDetailPanel } from './views/SkillDetailPanel.js'
import {
  getMcpClient,
  initializeMcpClient,
  disposeMcpClient,
  type McpClientConfig,
} from './mcp/McpClient.js'
import { McpStatusBar, registerMcpCommands, connectWithProgress } from './mcp/McpStatusBar.js'

let skillTreeProvider: SkillTreeProvider
let skillSearchProvider: SkillSearchProvider
let mcpStatusBar: McpStatusBar | undefined

export function activate(context: vscode.ExtensionContext) {
  console.log('Skillsmith extension is now active')

  // Initialize MCP client with configuration from settings
  initializeMcpClientFromSettings()

  // Initialize providers
  skillTreeProvider = new SkillTreeProvider()
  skillSearchProvider = new SkillSearchProvider()

  // Initialize MCP status bar
  mcpStatusBar = new McpStatusBar()
  mcpStatusBar.initialize()
  context.subscriptions.push(mcpStatusBar)

  // Register MCP commands
  registerMcpCommands(context)

  // Register tree views
  const skillsView = vscode.window.createTreeView('skillsmith.skillsView', {
    treeDataProvider: skillTreeProvider,
    showCollapseAll: true,
  })

  const searchView = vscode.window.createTreeView('skillsmith.searchView', {
    treeDataProvider: skillSearchProvider,
    showCollapseAll: true,
  })

  context.subscriptions.push(skillsView, searchView)

  // Register commands
  registerSearchCommand(context, skillSearchProvider)
  registerInstallCommand(context, skillSearchProvider)

  // Register refresh command
  const refreshCommand = vscode.commands.registerCommand('skillsmith.refreshSkills', () => {
    skillTreeProvider.refresh()
    vscode.window.showInformationMessage('Skills refreshed')
  })

  // Register view details command
  const viewDetailsCommand = vscode.commands.registerCommand(
    'skillsmith.viewSkillDetails',
    (skillId: string) => {
      SkillDetailPanel.createOrShow(context.extensionUri, skillId)
    }
  )

  context.subscriptions.push(refreshCommand, viewDetailsCommand)

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('skillsmith.mcp')) {
        initializeMcpClientFromSettings()
        // Reconnect with new settings
        void connectWithProgress()
      }
    })
  )

  // Show welcome message on first activation
  const hasShownWelcome = context.globalState.get('skillsmith.welcomeShown')
  if (!hasShownWelcome) {
    vscode.window
      .showInformationMessage(
        'Welcome to Skillsmith! Search for Claude Code skills using Cmd+Shift+P.',
        'Search Skills',
        'Connect to MCP'
      )
      .then((selection: string | undefined) => {
        if (selection === 'Search Skills') {
          vscode.commands.executeCommand('skillsmith.searchSkills')
        } else if (selection === 'Connect to MCP') {
          void connectWithProgress()
        }
      })
    context.globalState.update('skillsmith.welcomeShown', true)
  } else {
    // Try to connect to MCP server if autoConnect is enabled
    const config = vscode.workspace.getConfiguration('skillsmith')
    const autoConnect = config.get<boolean>('mcp.autoConnect', true)
    if (autoConnect) {
      // Connect in background (don't show progress on startup)
      const client = getMcpClient()
      void client.connect().catch((error) => {
        console.log('[Skillsmith] Auto-connect failed:', error)
        // Silent failure on startup - user can manually connect
      })
    }
  }
}

/**
 * Initialize MCP client from VS Code settings
 */
function initializeMcpClientFromSettings(): void {
  const config = vscode.workspace.getConfiguration('skillsmith')

  const mcpConfig: Partial<McpClientConfig> = {}

  const serverCommand = config.get<string>('mcp.serverCommand')
  if (serverCommand) {
    mcpConfig.serverCommand = serverCommand
  }

  const serverArgs = config.get<string[]>('mcp.serverArgs')
  if (serverArgs && serverArgs.length > 0) {
    mcpConfig.serverArgs = serverArgs
  }

  const connectionTimeout = config.get<number>('mcp.connectionTimeout')
  if (connectionTimeout) {
    mcpConfig.connectionTimeout = connectionTimeout
  }

  const autoReconnect = config.get<boolean>('mcp.autoReconnect')
  if (autoReconnect !== undefined) {
    mcpConfig.autoReconnect = autoReconnect
  }

  initializeMcpClient(mcpConfig)
}

export function deactivate() {
  console.log('Skillsmith extension deactivated')

  // Clean up MCP client
  disposeMcpClient()

  // Clean up status bar
  if (mcpStatusBar) {
    mcpStatusBar.dispose()
    mcpStatusBar = undefined
  }
}

// Export providers for testing
export { skillTreeProvider, skillSearchProvider }
