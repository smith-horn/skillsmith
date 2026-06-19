/**
 * Webview panel for the Skill Inventory Audit (SMI-5318 / #1459).
 *
 * Mirrors CompareSkillsPanel: singleton (`currentPanel`), `createOrShow`,
 * `dispose`, `resetForTests`, CSP nonce per render, host-built HTML, the
 * message listener wired BEFORE assigning `webview.html`. Read-only — inbound
 * messages are `retry` (re-run the audit), `openReport` (open the formatted
 * report file in an editor), and `copyRename` (copy a suggested name to the
 * clipboard).
 *
 * The `skill_inventory_audit` MCP tool is ungated (Community tier) — there is
 * no tier-denied handling anywhere in this panel.
 */
import * as vscode from 'vscode'
import { generateCspNonce, getInventoryAuditCsp } from '../utils/csp.js'
import { getLoadingHtml } from './skill-panel-html.js'
import { getInventoryAuditHtml, getInventoryAuditErrorHtml } from './inventory-audit-panel-html.js'
import { getMcpClient } from '../mcp/McpClient.js'
import type { McpInventoryAuditResponse } from '../mcp/types.js'
import type { InventoryAuditPanelMessage } from './inventory-audit-panel-types.js'

export class InventoryAuditPanel {
  public static currentPanel: InventoryAuditPanel | undefined
  public static readonly viewType = 'skillsmith.inventoryAudit'

  private readonly _panel: vscode.WebviewPanel
  private _response: McpInventoryAuditResponse
  private _disposed = false
  private _disposables: vscode.Disposable[] = []

  /** Reset the singleton between tests. */
  public static resetForTests(): void {
    InventoryAuditPanel.currentPanel?.dispose()
    InventoryAuditPanel.currentPanel = undefined
  }

  public static createOrShow(_extensionUri: vscode.Uri, response: McpInventoryAuditResponse): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    if (InventoryAuditPanel.currentPanel) {
      InventoryAuditPanel.currentPanel._panel.reveal(column)
      InventoryAuditPanel.currentPanel._response = response
      InventoryAuditPanel.currentPanel._update()
      return
    }

    const panel = vscode.window.createWebviewPanel(
      InventoryAuditPanel.viewType,
      'Skill Inventory Audit',
      column || vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    )

    InventoryAuditPanel.currentPanel = new InventoryAuditPanel(panel, response)
  }

  private constructor(panel: vscode.WebviewPanel, response: McpInventoryAuditResponse) {
    this._panel = panel
    this._response = response
    this._panel.title = 'Skill Inventory Audit'

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Wire the message listener BEFORE assigning webview.html.
    this._panel.webview.onDidReceiveMessage(
      (message: InventoryAuditPanelMessage) => {
        this._handleMessage(message)
      },
      null,
      this._disposables
    )

    this._update()
  }

  public dispose(): void {
    this._disposed = true
    InventoryAuditPanel.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  private _handleMessage(message: InventoryAuditPanelMessage): void {
    if (message.command === 'retry') {
      void this._retry()
    } else if (message.command === 'openReport') {
      void this._openReport()
    } else if (message.command === 'copyRename') {
      void this._copyRename(message.text)
    }
  }

  /**
   * Re-run the inventory audit. Shows a loading state, then re-renders on
   * success. The tool is ungated, so any error renders the error page (no
   * tier-denied handling).
   */
  private async _retry(): Promise<void> {
    if (this._disposed) return
    const nonce = generateCspNonce()
    this._panel.webview.html = getLoadingHtml(nonce, getInventoryAuditCsp(nonce))

    const client = getMcpClient()
    if (!client.isConnected()) {
      const errNonce = generateCspNonce()
      this._panel.webview.html = getInventoryAuditErrorHtml(
        'Skillsmith server is not connected. Start the MCP server and try again.',
        errNonce
      )
      return
    }

    try {
      const response = await client.skillInventoryAudit({})
      if (this._disposed) return
      this._response = response
      this._update()
    } catch (err) {
      if (this._disposed) return
      const raw = err instanceof Error ? err.message : String(err)
      const errNonce = generateCspNonce()
      this._panel.webview.html = getInventoryAuditErrorHtml(
        'Could not audit your inventory. Please try again.',
        errNonce,
        raw
      )
    }
  }

  /** Open the formatted audit report file in an editor tab. */
  private async _openReport(): Promise<void> {
    if (this._disposed) return
    const reportPath = this._response.reportPath
    if (typeof reportPath !== 'string' || reportPath.length === 0) {
      void vscode.window.showErrorMessage('No audit report is available.')
      return
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath))
      if (this._disposed) return
      await vscode.window.showTextDocument(doc)
    } catch {
      void vscode.window.showErrorMessage('Could not open the audit report.')
    }
  }

  /** Copy a suggested rename to the clipboard. */
  private async _copyRename(text: string): Promise<void> {
    if (this._disposed) return
    if (typeof text !== 'string') return
    await vscode.env.clipboard.writeText(text)
    void vscode.window.showInformationMessage(`Copied: ${text}`)
  }

  private _update(): void {
    if (this._disposed) return
    const nonce = generateCspNonce()
    this._panel.webview.html = getInventoryAuditHtml(this._response, nonce)
  }
}
