/**
 * Webview panel for displaying skill details
 */
import * as vscode from 'vscode'
import { generateCspNonce, getSkillDetailCsp } from '../utils/csp.js'
import { getSkillById } from '../data/mockSkills.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { type McpSkillDetails } from '../mcp/types.js'
import type { ExtendedSkillData, ScoreBreakdown, SkillPanelMessage } from './skill-panel-types.js'
import { getLoadingHtml, getSkillDetailHtml } from './skill-panel-html.js'

// Re-export types for backwards compatibility
export type { ExtendedSkillData, ScoreBreakdown } from './skill-panel-types.js'

export class SkillDetailPanel {
  public static currentPanel: SkillDetailPanel | undefined
  public static readonly viewType = 'skillsmith.skillDetail'

  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri
  private _skillId: string
  private _skillData: ExtendedSkillData | null = null
  private _disposables: vscode.Disposable[] = []

  public static createOrShow(extensionUri: vscode.Uri, skillId: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    // If we already have a panel, show it
    if (SkillDetailPanel.currentPanel) {
      SkillDetailPanel.currentPanel._panel.reveal(column)
      SkillDetailPanel.currentPanel._skillId = skillId
      SkillDetailPanel.currentPanel._skillData = null
      void SkillDetailPanel.currentPanel._loadAndUpdate()
      return
    }

    // Create a new panel
    const panel = vscode.window.createWebviewPanel(
      SkillDetailPanel.viewType,
      'Skill Details',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
      }
    )

    SkillDetailPanel.currentPanel = new SkillDetailPanel(panel, extensionUri, skillId)
  }

  public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, skillId: string) {
    SkillDetailPanel.currentPanel = new SkillDetailPanel(panel, extensionUri, skillId)
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, skillId: string) {
    this._panel = panel
    this._extensionUri = extensionUri
    this._skillId = skillId

    // Load skill data and set the webview's initial html content
    void this._loadAndUpdate()

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message: SkillPanelMessage) => {
        this._handleMessage(message)
      },
      null,
      this._disposables
    )
  }

  public dispose() {
    SkillDetailPanel.currentPanel = undefined

    // Clean up resources
    this._panel.dispose()

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  /**
   * Handle messages from the webview
   */
  private _handleMessage(message: SkillPanelMessage): void {
    switch (message.command) {
      case 'install':
        vscode.commands.executeCommand('skillsmith.installSkill')
        return
      case 'openRepository':
        if (message.url && this._isValidUrl(message.url)) {
          vscode.env.openExternal(vscode.Uri.parse(message.url))
        }
        return
    }
  }

  /**
   * Load skill data from MCP and update the panel
   */
  private async _loadAndUpdate(): Promise<void> {
    // Show loading state first
    this._panel.title = `Loading: ${this._skillId}`
    this._panel.webview.html = getLoadingHtml()

    // Try to fetch from MCP
    const client = getMcpClient()
    if (client.isConnected()) {
      try {
        const response = await client.getSkill(this._skillId)
        this._skillData = this._convertMcpSkill(response.skill, response.installCommand)
      } catch (error) {
        console.warn('[Skillsmith] MCP get_skill failed, falling back to mock data:', error)
        this._skillData = this._getMockSkillData()
      }
    } else {
      // Fall back to mock data
      this._skillData = this._getMockSkillData()
    }

    this._update()
  }

  /**
   * Get skill data from mock source
   */
  private _getMockSkillData(): ExtendedSkillData {
    const mockData = getSkillById(this._skillId)
    return {
      id: mockData.id,
      name: mockData.name,
      description: mockData.description,
      author: mockData.author,
      category: mockData.category,
      trustTier: mockData.trustTier,
      score: mockData.score,
      repository: mockData.repository,
      version: undefined,
      tags: undefined,
      installCommand: undefined,
      scoreBreakdown: undefined,
    }
  }

  /**
   * Convert MCP skill details to ExtendedSkillData
   */
  private _convertMcpSkill(skill: McpSkillDetails, installCommand: string): ExtendedSkillData {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      author: skill.author,
      category: skill.category,
      trustTier: skill.trustTier,
      score: skill.score,
      repository: skill.repository,
      version: skill.version,
      tags: skill.tags,
      installCommand: installCommand,
      scoreBreakdown: skill.scoreBreakdown as ScoreBreakdown | undefined,
    }
  }

  private _update() {
    if (!this._skillData) {
      return
    }
    this._panel.title = `Skill: ${this._skillData.name}`
    this._panel.webview.html = this._getHtmlForWebview()
  }

  /**
   * Validates that a URL is a safe HTTP/HTTPS URL
   */
  private _isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    } catch {
      return false
    }
  }

  /**
   * Gets a nonce for Content Security Policy
   */
  private _getNonce(): string {
    return generateCspNonce()
  }

  /**
   * Gets the resource URI for webview content
   */
  private _getResourceUri(resourcePath: string): vscode.Uri {
    return this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', resourcePath)
    )
  }

  private _getHtmlForWebview(): string {
    const skill = this._skillData || this._getMockSkillData()
    const nonce = this._getNonce()
    const csp = getSkillDetailCsp(nonce)

    // Ensure extensionUri is used (for future resource loading)
    void this._getResourceUri

    return getSkillDetailHtml(skill, nonce, csp)
  }
}
