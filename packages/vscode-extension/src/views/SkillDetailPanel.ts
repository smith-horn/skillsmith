/**
 * Webview panel for displaying skill details
 * Uses SkillService for centralized MCP-first + mock fallback.
 */
import * as vscode from 'vscode'
import { generateCspNonce, getSkillDetailCsp } from '../utils/csp.js'
import type { SkillService } from '../services/SkillService.js'
import type { ExtendedSkillData, SkillPanelMessage } from './skill-panel-types.js'
import {
  getLoadingHtml,
  getSkillDetailHtml,
  getErrorHtml,
  mapErrorToUserMessage,
} from './skill-panel-html.js'

// Re-export types for backwards compatibility
export type { ExtendedSkillData, ScoreBreakdown } from './skill-panel-types.js'

export class SkillDetailPanel {
  public static currentPanel: SkillDetailPanel | undefined
  public static readonly viewType = 'skillsmith.skillDetail'

  /** Trusted domains that open immediately without confirmation dialog */
  private static readonly TRUSTED_DOMAINS = ['github.com', 'gitlab.com', 'skillsmith.app']

  private static _skillService: SkillService

  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri
  private _skillId: string
  private _skillData: ExtendedSkillData | null = null
  private _showFullContent = false
  private _disposables: vscode.Disposable[] = []

  /** Set the shared SkillService instance (called once at activation) */
  public static setSkillService(service: SkillService): void {
    SkillDetailPanel._skillService = service
  }

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

    this._panel.dispose()

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  /** Handle messages from the webview */
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
      case 'openExternal':
        if (message.url && this._isValidUrl(message.url)) {
          void this._openExternalWithTrustCheck(message.url)
        }
        return
      case 'expandContent':
        this._showFullContent = true
        this._update()
        return
      case 'retry':
        void this._loadAndUpdate()
        return
    }
  }

  /** Open an external URL, showing a confirmation dialog for untrusted domains */
  private async _openExternalWithTrustCheck(url: string): Promise<void> {
    try {
      const parsed = new URL(url)
      const isTrusted = SkillDetailPanel.TRUSTED_DOMAINS.some(
        (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d)
      )
      if (isTrusted) {
        await vscode.env.openExternal(vscode.Uri.parse(url))
      } else {
        const choice = await vscode.window.showWarningMessage(
          `Open external link to ${parsed.hostname}?`,
          { modal: true },
          'Open'
        )
        if (choice === 'Open') {
          await vscode.env.openExternal(vscode.Uri.parse(url))
        }
      }
    } catch {
      // Malformed URL -- ignore
    }
  }

  /** Load skill data from SkillService and update the panel */
  private async _loadAndUpdate(): Promise<void> {
    this._panel.title = `Loading: ${this._skillId}`
    const loadingNonce = this._getNonce()
    this._panel.webview.html = getLoadingHtml(loadingNonce, getSkillDetailCsp(loadingNonce))
    this._showFullContent = false

    if (!SkillDetailPanel._skillService) {
      const nonce = this._getNonce()
      this._panel.webview.html = getErrorHtml(
        'SkillService not initialized. Run "Developer: Reload Window" from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P).',
        this._skillId,
        nonce
      )
      return
    }

    try {
      const { skill } = await SkillDetailPanel._skillService.getRichSkill(this._skillId)
      this._skillData = skill
      this._update()
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const userMessage = mapErrorToUserMessage(rawMessage)
      const nonce = this._getNonce()
      this._panel.title = `Error: ${this._skillId}`
      this._panel.webview.html = getErrorHtml(userMessage, this._skillId, nonce, rawMessage)
    }
  }

  private _update() {
    if (!this._skillData) {
      return
    }
    this._panel.title = `Skill: ${this._skillData.name}`
    this._panel.webview.html = this._getHtmlForWebview()
  }

  /** Validates that a URL is a safe HTTP/HTTPS URL */
  private _isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    } catch {
      return false
    }
  }

  /** Gets a nonce for Content Security Policy */
  private _getNonce(): string {
    return generateCspNonce()
  }

  /** Gets the resource URI for webview content */
  private _getResourceUri(resourcePath: string): vscode.Uri {
    return this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', resourcePath)
    )
  }

  private _getHtmlForWebview(): string {
    const skill = this._skillData
    if (!skill) {
      const nonce = this._getNonce()
      return getLoadingHtml(nonce, getSkillDetailCsp(nonce))
    }
    const nonce = this._getNonce()
    const csp = getSkillDetailCsp(nonce)

    // Ensure extensionUri is used (for future resource loading)
    void this._getResourceUri

    return getSkillDetailHtml(skill, nonce, csp, this._showFullContent)
  }
}
