/**
 * Webview panel for the Skill Inventory Audit (SMI-5318 / #1459; interactive
 * apply added in SMI-5325).
 *
 * Mirrors CompareSkillsPanel: singleton (`currentPanel`), `createOrShow`,
 * `dispose`, `resetForTests`, CSP nonce per render, host-built HTML, the message
 * listener wired BEFORE assigning `webview.html`. Inbound messages: `retry`
 * (re-run the audit), `openReport`, `copyRename`, and `applyRename` / `applyEdit`
 * (SMI-5325 — apply a suggested rename / prose edit, both mutating `~/.claude/`).
 *
 * All apply tools are ungated (Community tier) — no tier-denied handling. The
 * SMI-5213 confirmation gate is honored: every apply first fetches a non-mutating
 * preview (`confirmed: false`), shows a native modal, then mutates
 * (`confirmed: true`) only on confirm, and re-audits to refresh the report.
 */
import * as vscode from 'vscode'
import { generateCspNonce, getInventoryAuditCsp } from '../utils/csp.js'
import { getLoadingHtml } from './skill-panel-html.js'
import { getInventoryAuditHtml, getInventoryAuditErrorHtml } from './inventory-audit-panel-html.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import { track } from '../services/Telemetry.js'
import type { McpInventoryAuditResponse } from '../mcp/types.js'
import type { InventoryAuditPanelMessage } from './inventory-audit-panel-types.js'

/**
 * Structural view of an apply response envelope (both
 * `McpApplyNamespaceRenameResponse` and `McpApplyRecommendedEditResponse` are
 * assignable to it). Application-level failure is `success: false` + `errorCode`
 * inside the envelope — never a thrown error (the dispatcher uses `okBody`).
 */
interface ApplyEnvelope {
  success: boolean
  errorCode?: string
  error?: string
  preview?: boolean
  before?: string
  after?: string
  target?: string
  applied?: boolean
}

const NOT_CONNECTED_MSG = 'Skillsmith server is not connected. Start the MCP server and try again.'

export class InventoryAuditPanel {
  public static currentPanel: InventoryAuditPanel | undefined
  public static readonly viewType = 'skillsmith.inventoryAudit'

  private readonly _panel: vscode.WebviewPanel
  private _response: McpInventoryAuditResponse
  private _disposed = false
  // SMI-5325: re-entrancy guard — at most one apply flow runs at a time on the
  // singleton. Set synchronously at the top of an apply (before any await), so a
  // second webview click is ignored while one is in flight.
  private _applyInFlight = false
  // SMI-5325: once the server's `apply_recommended_edit` is known unavailable
  // (registry empty → UnknownTool), suppress all Apply-edit buttons.
  private _editApplyUnavailable = false
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
      void this._reaudit()
    } else if (message.command === 'openReport') {
      void this._openReport()
    } else if (message.command === 'copyRename') {
      void this._copyRename(message.text)
    } else if (message.command === 'applyRename') {
      void this._applyRename(message.collisionId)
    } else if (message.command === 'applyEdit') {
      void this._applyEdit(message.collisionId)
    }
  }

  /** Apply a suggested rename. Validates the collisionId against the live report. */
  private async _applyRename(collisionId: string): Promise<void> {
    const suggestion = this._response.renameSuggestions.find((s) => s.collisionId === collisionId)
    if (!suggestion) return
    const before = typeof suggestion.currentName === 'string' ? suggestion.currentName : ''
    const after = typeof suggestion.suggested === 'string' ? suggestion.suggested : ''
    await this._runApply('rename', {
      confirmTitle: 'Apply this rename?',
      summary: `"${before}" → "${after}"`,
      successMessage: `Renamed "${before}" → "${after}" — a backup was saved.`,
      call: (confirmed) =>
        getMcpClient().applyNamespaceRename({
          auditId: this._response.auditId,
          collisionId,
          action: 'apply',
          confirmed,
        }),
    })
  }

  /** Apply a recommended prose edit (only reachable for apply_with_confirmation rows). */
  private async _applyEdit(collisionId: string): Promise<void> {
    const edit = this._response.recommendedEdits.find((e) => e.collisionId === collisionId)
    if (!edit) return
    const filePath = typeof edit.filePath === 'string' ? edit.filePath : 'the file'
    await this._runApply('edit', {
      confirmTitle: 'Apply this edit?',
      summary: `Rewrite ${filePath}`,
      successMessage: 'Applied edit — a backup was saved.',
      call: (confirmed) =>
        getMcpClient().applyRecommendedEdit({
          auditId: this._response.auditId,
          collisionId,
          confirmed,
        }),
    })
  }

  /**
   * Shared apply flow: preview (confirmed:false) → native-modal confirm → apply
   * (confirmed:true) → re-audit. Guarded by `_applyInFlight`.
   */
  private async _runApply(
    kind: 'rename' | 'edit',
    opts: {
      confirmTitle: string
      summary: string
      successMessage: string
      call: (confirmed: boolean) => Promise<ApplyEnvelope>
    }
  ): Promise<void> {
    if (this._disposed || this._applyInFlight) return
    this._applyInFlight = true
    try {
      if (!getMcpClient().isConnected()) {
        void vscode.window.showInformationMessage(NOT_CONNECTED_MSG)
        return
      }

      // Phase 1: non-mutating preview.
      let preview: ApplyEnvelope
      try {
        preview = await opts.call(false)
      } catch (err) {
        this._handleApplyThrow(kind, err)
        return
      }
      if (this._disposed) return
      track('vscode_inventory_apply_preview', { kind })
      if (!preview.success) {
        await this._handleApplyErrorCode(kind, preview)
        return
      }

      // Phase 2: native-modal confirmation (the rich diff stays in the panel row).
      const detail = `${opts.summary}\n\nThis modifies a file under ~/.claude (a backup is saved).`
      const choice = await vscode.window.showWarningMessage(
        opts.confirmTitle,
        { modal: true, detail },
        'Apply'
      )
      if (this._disposed) return
      if (choice !== 'Apply') {
        track('vscode_inventory_apply_cancelled', { kind })
        return
      }

      // Phase 3: mutating apply.
      let applied: ApplyEnvelope
      try {
        applied = await opts.call(true)
      } catch (err) {
        this._handleApplyThrow(kind, err)
        return
      }
      if (this._disposed) return
      if (!applied.success) {
        await this._handleApplyErrorCode(kind, applied)
        return
      }

      // Phase 4: success → re-audit + announce.
      track('vscode_inventory_apply_applied', { kind })
      void vscode.window.showInformationMessage(opts.successMessage)
      await this._reaudit(opts.successMessage)
    } finally {
      this._applyInFlight = false
    }
  }

  /** Map a thrown McpToolError (transport-level) to user-facing messaging. */
  private _handleApplyThrow(kind: 'rename' | 'edit', err: unknown): void {
    const code = err instanceof McpToolError ? err.code : 'Unknown'
    track('vscode_inventory_apply_failed', { kind, errorCode: code })
    if (code === 'NotConnected') {
      void vscode.window.showInformationMessage(NOT_CONNECTED_MSG)
      return
    }
    if (code === 'UnknownTool' && kind === 'edit') {
      // Registry-empty server build: collapse all Apply-edit buttons to the hint.
      this._editApplyUnavailable = true
      void vscode.window.showInformationMessage(
        "Applying recommended edits isn't supported by the connected Skillsmith server."
      )
      this._update()
      return
    }
    const raw = err instanceof Error ? err.message : String(err)
    void vscode.window.showErrorMessage(`Could not apply the change. ${raw}`)
  }

  /** Map a structured `success:false` envelope (errorCode) to user-facing messaging. */
  private async _handleApplyErrorCode(kind: 'rename' | 'edit', env: ApplyEnvelope): Promise<void> {
    const code = env.errorCode ?? 'unknown'
    track('vscode_inventory_apply_failed', { kind, errorCode: code })
    // Self-heal: a drifted persisted audit → silently re-scan. No mutation
    // happened in these cases, so this cannot produce a partial apply, and the
    // re-audit never re-fires an apply (no loop).
    if (
      code === 'namespace.audit.history_not_found' ||
      code === 'namespace.audit.collision_not_found'
    ) {
      await this._reaudit('Your inventory changed — refreshing the audit…')
      return
    }
    const detail = typeof env.error === 'string' ? env.error : ''
    const messages: Record<string, string> = {
      'namespace.audit.invalid_input': "That suggestion couldn't be applied (invalid input).",
      'namespace.rename.subcall_failed': `Rename failed: ${detail} — re-run the audit to see the current state.`,
      'edit.template_not_in_apply_registry': "This edit template can't be applied automatically.",
      'edit.subcall_failed': `Edit failed: ${detail} — re-run the audit to see the current state.`,
    }
    void vscode.window.showErrorMessage(messages[code] ?? 'Could not apply the change.')
  }

  /**
   * Re-run the inventory audit (shared by the Re-run button and post-apply
   * refresh). Shows a loading state, then re-renders on success. `statusMessage`,
   * when set, is announced via the panel's aria-live status node.
   */
  private async _reaudit(statusMessage = ''): Promise<void> {
    if (this._disposed) return
    const nonce = generateCspNonce()
    this._panel.webview.html = getLoadingHtml(nonce, getInventoryAuditCsp(nonce))

    const client = getMcpClient()
    if (!client.isConnected()) {
      const errNonce = generateCspNonce()
      this._panel.webview.html = getInventoryAuditErrorHtml(NOT_CONNECTED_MSG, errNonce)
      return
    }

    try {
      const response = await client.skillInventoryAudit({})
      if (this._disposed) return
      this._response = response
      this._update(statusMessage)
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

  private _update(statusMessage = ''): void {
    if (this._disposed) return
    const nonce = generateCspNonce()
    this._panel.webview.html = getInventoryAuditHtml(this._response, nonce, {
      editApplyUnavailable: this._editApplyUnavailable,
      statusMessage,
    })
  }
}
