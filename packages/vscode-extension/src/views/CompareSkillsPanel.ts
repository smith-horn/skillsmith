/**
 * Webview panel for comparing exactly two skills side-by-side (SMI-5315 / #1456).
 *
 * Mirrors SkillDetailPanel: singleton (`currentPanel`), `createOrShow`,
 * `dispose`, `resetForTests`, CSP nonce per render, host-built HTML, the message
 * listener wired BEFORE assigning `webview.html`. Read-only — the only inbound
 * message is `retry`, which re-runs the comparison via the MCP client.
 */
import * as vscode from 'vscode'
import { generateCspNonce, getCompareCsp } from '../utils/csp.js'
import { getLoadingHtml } from './skill-panel-html.js'
import { getCompareHtml, getCompareErrorHtml } from './compare-panel-html.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import { handleTierDenied } from '../mcp/tierDenied.js'
import type { McpCompareResponse } from '../mcp/types.js'
import type { ComparePanelMessage } from './compare-panel-types.js'

export class CompareSkillsPanel {
  public static currentPanel: CompareSkillsPanel | undefined
  public static readonly viewType = 'skillsmith.compareSkills'

  private readonly _panel: vscode.WebviewPanel
  private _response: McpCompareResponse
  /** Original picked ids — retry re-runs against these, not the response echo (L3). */
  private _skillAId: string
  private _skillBId: string
  private _disposables: vscode.Disposable[] = []

  /** Reset the singleton between tests. */
  public static resetForTests(): void {
    CompareSkillsPanel.currentPanel?.dispose()
    CompareSkillsPanel.currentPanel = undefined
  }

  public static createOrShow(
    _extensionUri: vscode.Uri,
    response: McpCompareResponse,
    skillAId: string,
    skillBId: string
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    if (CompareSkillsPanel.currentPanel) {
      CompareSkillsPanel.currentPanel._panel.reveal(column)
      CompareSkillsPanel.currentPanel._response = response
      CompareSkillsPanel.currentPanel._skillAId = skillAId
      CompareSkillsPanel.currentPanel._skillBId = skillBId
      CompareSkillsPanel.currentPanel._update()
      return
    }

    const panel = vscode.window.createWebviewPanel(
      CompareSkillsPanel.viewType,
      'Compare Skills',
      column || vscode.ViewColumn.One,
      { enableScripts: true }
    )

    CompareSkillsPanel.currentPanel = new CompareSkillsPanel(panel, response, skillAId, skillBId)
  }

  private constructor(
    panel: vscode.WebviewPanel,
    response: McpCompareResponse,
    skillAId: string,
    skillBId: string
  ) {
    this._panel = panel
    this._response = response
    this._skillAId = skillAId
    this._skillBId = skillBId

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Wire the message listener BEFORE assigning webview.html.
    this._panel.webview.onDidReceiveMessage(
      (message: ComparePanelMessage) => {
        this._handleMessage(message)
      },
      null,
      this._disposables
    )

    this._update()
  }

  public dispose(): void {
    CompareSkillsPanel.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  private _handleMessage(message: ComparePanelMessage): void {
    if (message.command === 'retry') {
      void this._retry()
    }
  }

  /**
   * Re-run the comparison for the same two skills. Shows a loading state, then
   * re-renders on success. TierDenied routes to the upgrade UX; other errors
   * re-render the error page.
   */
  private async _retry(): Promise<void> {
    const nonce = generateCspNonce()
    this._panel.webview.html = getLoadingHtml(nonce, getCompareCsp(nonce))

    const client = getMcpClient()
    if (!client.isConnected()) {
      const errNonce = generateCspNonce()
      this._panel.webview.html = getCompareErrorHtml(
        'Skillsmith server is not connected. Start the MCP server and try again.',
        errNonce
      )
      return
    }

    try {
      const response = await client.skillCompare({
        skill_a: this._skillAId,
        skill_b: this._skillBId,
      })
      this._response = response
      this._update()
    } catch (err) {
      if (err instanceof McpToolError && err.code === 'TierDenied') {
        await handleTierDenied('skillsmith.compareSkills', err)
        return
      }
      const raw = err instanceof Error ? err.message : String(err)
      const errNonce = generateCspNonce()
      const headline =
        err instanceof McpToolError && err.code === 'SkillNotFound'
          ? 'One or both skills could not be found. Check the skill IDs and try again.'
          : 'Could not compare these skills. Please try again.'
      this._panel.webview.html = getCompareErrorHtml(headline, errNonce, raw)
    }
  }

  private _update(): void {
    const a = this._response.comparison.a.name
    const b = this._response.comparison.b.name
    this._panel.title = `Compare: ${a} vs ${b}`
    const nonce = generateCspNonce()
    this._panel.webview.html = getCompareHtml(this._response, nonce)
  }
}
