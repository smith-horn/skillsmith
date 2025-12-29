/**
 * Skillsmith VS Code Extension
 * Provides skill discovery, installation, and SKILL.md intellisense directly in VS Code
 *
 * @module extension
 */
import * as vscode from 'vscode'
import { SkillTreeDataProvider } from './sidebar/SkillTreeDataProvider.js'
import { SkillSearchProvider } from './providers/SkillSearchProvider.js'
import { registerSearchCommand } from './commands/searchSkills.js'
import { registerQuickInstallCommand } from './commands/installCommand.js'
import { SkillDetailPanel } from './views/SkillDetailPanel.js'
import {
  getMcpClient,
  initializeMcpClient,
  disposeMcpClient,
  type McpClientConfig,
} from './mcp/McpClient.js'
import { McpStatusBar, registerMcpCommands, connectWithProgress } from './mcp/McpStatusBar.js'
import {
  SkillCompletionProvider,
  SkillHoverProvider,
  SkillDiagnosticsProvider,
  getSkillMdSelector,
} from './intellisense/index.js'

// Extension state
let skillTreeDataProvider: SkillTreeDataProvider
let skillSearchProvider: SkillSearchProvider
let mcpStatusBar: McpStatusBar | undefined
let skillDiagnosticsProvider: SkillDiagnosticsProvider

/**
 * Activates the Skillsmith extension
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('[Skillsmith] Extension is now active')

  // Initialize MCP client with configuration from settings
  initializeMcpClientFromSettings()

  // Initialize providers
  skillTreeDataProvider = new SkillTreeDataProvider()
  skillSearchProvider = new SkillSearchProvider()

  // Initialize intellisense providers
  const skillCompletionProvider = new SkillCompletionProvider()
  const skillHoverProvider = new SkillHoverProvider()
  skillDiagnosticsProvider = new SkillDiagnosticsProvider()

  // Initialize MCP status bar
  mcpStatusBar = new McpStatusBar()
  mcpStatusBar.initialize()
  context.subscriptions.push(mcpStatusBar)

  // Register MCP commands
  registerMcpCommands(context)

  // Register tree views
  const skillsView = vscode.window.createTreeView('skillsmith.skillsView', {
    treeDataProvider: skillTreeDataProvider,
    showCollapseAll: true,
  })

  const searchView = vscode.window.createTreeView('skillsmith.searchView', {
    treeDataProvider: skillSearchProvider,
    showCollapseAll: true,
  })

  context.subscriptions.push(skillsView, searchView)

  // Register intellisense providers
  const skillMdSelector = getSkillMdSelector()

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      skillMdSelector,
      skillCompletionProvider,
      ':', // Trigger on colon for frontmatter
      '#' // Trigger on hash for section headers
    )
  )

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(skillMdSelector, skillHoverProvider)
  )

  context.subscriptions.push(skillDiagnosticsProvider)

  // Set up document change listeners for diagnostics
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) => {
      skillDiagnosticsProvider.validateDocument(document)
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
      skillDiagnosticsProvider.validateDocument(event.document)
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
      skillDiagnosticsProvider.clearDiagnostics(document)
    })
  )

  // Validate all open SKILL.md documents
  for (const document of vscode.workspace.textDocuments) {
    skillDiagnosticsProvider.validateDocument(document)
  }

  // Register commands
  registerSearchCommand(context, skillSearchProvider)
  registerQuickInstallCommand(context)

  // Register refresh command
  const refreshCommand = vscode.commands.registerCommand('skillsmith.refreshSkills', () => {
    skillTreeDataProvider.refresh()
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
      const client = getMcpClient()
      void client.connect().catch((error) => {
        console.log('[Skillsmith] Auto-connect failed:', error)
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

/**
 * Deactivates the Skillsmith extension
 */
export function deactivate(): void {
  console.log('[Skillsmith] Extension deactivated')

  // Clean up MCP client
  disposeMcpClient()

  // Clean up status bar
  if (mcpStatusBar) {
    mcpStatusBar.dispose()
    mcpStatusBar = undefined
  }

  // Clean up diagnostics
  if (skillDiagnosticsProvider) {
    skillDiagnosticsProvider.dispose()
  }
}

// Export providers for testing
export { skillTreeDataProvider, skillSearchProvider }
