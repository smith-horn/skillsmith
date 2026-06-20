/**
 * Webview panel for the Skill Diff / update-advisor (SMI-5316 / #1457).
 *
 * Mirrors SkillDetailPanel / CompareSkillsPanel: singleton (`currentPanel`),
 * `createOrShow`, `dispose`, `resetForTests`, CSP nonce per render, host-built
 * HTML, the message listener wired BEFORE assigning `webview.html`. The command
 * routes a tier denial to the upgrade UX before this panel ever opens, so the
 * panel opens only on a successful diff. Read-only — the only inbound message is
 * `retry`, which re-runs `skill_diff` with the stored args (covers a transient
 * disconnect between the initial check and a manual retry).
 */
import * as vscode from 'vscode'
import { generateCspNonce, getSkillDiffCsp } from '../utils/csp.js'
import { getLoadingHtml } from './skill-panel-html.js'
import { getDiffHtml, getDiffErrorHtml } from './diff-panel-html.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import { handleTierDenied } from '../mcp/tierDenied.js'
import type { McpSkillDiffResponse } from '../mcp/types.js'
import type { DiffPanelMessage, SkillDiffArgs } from './diff-panel-types.js'

export class SkillDiffPanel {
  public static currentPanel: SkillDiffPanel | undefined
  public static readonly viewType = 'skillsmith.skillDiff'

  private readonly _panel: vscode.WebviewPanel
  private _skillName: string
  private _response: McpSkillDiffResponse
  private readonly _args: SkillDiffArgs
  private _disposables: vscode.Disposable[] = []

  /** Reset the singleton between tests. */
  public static resetForTests(): void {
    SkillDiffPanel.currentPanel?.dispose()
    SkillDiffPanel.currentPanel = undefined
  }

  public static createOrShow(
    _extensionUri: vscode.Uri,
    skillName: string,
    response: McpSkillDiffResponse,
    args: SkillDiffArgs
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    if (SkillDiffPanel.currentPanel) {
      SkillDiffPanel.currentPanel._panel.reveal(column)
      SkillDiffPanel.currentPanel._skillName = skillName
      SkillDiffPanel.currentPanel._response = response
      SkillDiffPanel.currentPanel._update()
      return
    }

    const panel = vscode.window.createWebviewPanel(
      SkillDiffPanel.viewType,
      'Check for Updates',
      column || vscode.ViewColumn.One,
      { enableScripts: true }
    )

    SkillDiffPanel.currentPanel = new SkillDiffPanel(panel, skillName, response, args)
  }

  private constructor(
    panel: vscode.WebviewPanel,
    skillName: string,
    response: McpSkillDiffResponse,
    args: SkillDiffArgs
  ) {
    this._panel = panel
    this._skillName = skillName
    this._response = response
    this._args = args

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Wire the message listener BEFORE assigning webview.html.
    this._panel.webview.onDidReceiveMessage(
      (message: DiffPanelMessage) => {
        this._handleMessage(message)
      },
      null,
      this._disposables
    )

    this._update()
  }

  public dispose(): void {
    SkillDiffPanel.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  private _handleMessage(message: DiffPanelMessage): void {
    if (message.command === 'retry') {
      void this._retry()
    }
  }

  /**
   * Re-run the update check with the stored args. Shows a loading state, then
   * re-renders on success. TierDenied routes to the upgrade UX; other errors
   * re-render the error page.
   */
  private async _retry(): Promise<void> {
    const nonce = generateCspNonce()
    this._panel.webview.html = getLoadingHtml(nonce, getSkillDiffCsp(nonce))

    const client = getMcpClient()
    if (!client.isConnected()) {
      const errNonce = generateCspNonce()
      this._panel.webview.html = getDiffErrorHtml(
        'Skillsmith server is not connected. Start the MCP server and try again.',
        errNonce
      )
      return
    }

    try {
      const response = await client.skillDiff(this._args)
      this._response = response
      this._update()
    } catch (err) {
      if (err instanceof McpToolError && err.code === 'TierDenied') {
        await handleTierDenied('skillsmith.diffSkill', err)
        return
      }
      const raw = err instanceof Error ? err.message : String(err)
      const errNonce = generateCspNonce()
      const headline =
        err instanceof McpToolError && err.code === 'SkillNotFound'
          ? 'This skill could not be found in the registry. It may have been removed or renamed.'
          : 'Could not check this skill for updates. Please try again.'
      this._panel.webview.html = getDiffErrorHtml(headline, errNonce, raw)
    }
  }

  private _update(): void {
    this._panel.title = `Updates: ${this._skillName}`
    const nonce = generateCspNonce()
    this._panel.webview.html = getDiffHtml(this._skillName, this._response, nonce)
  }
}
