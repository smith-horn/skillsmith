/**
 * Webview panel for displaying skill details
 * Uses SkillService for centralized MCP-first + mock fallback.
 */
import * as vscode from 'vscode'
import * as path from 'node:path'
import { generateCspNonce, getSkillDetailCsp } from '../utils/csp.js'
import type { SkillService } from '../services/SkillService.js'
import type { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import type {
  ExtendedSkillData,
  SkillPanelMessage,
  SkillActionContext,
} from './skill-panel-types.js'
import { skillComparisonKey } from '../utils/skillId.js'
import { uninstallByTarget } from '../commands/uninstallCommand.js'
import { track } from '../services/Telemetry.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import type { McpAdvisory } from '../mcp/types.js'
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
  private static _treeProvider: SkillTreeDataProvider | undefined

  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri
  private _skillId: string
  private _skillData: ExtendedSkillData | null = null
  private _showFullContent = false
  private _disposables: vscode.Disposable[] = []

  /** Installed-state resolved at load time (drives the conditional action set). */
  private _installed = false
  private _skillPath: string | undefined
  private _hasSkillMd = false

  /**
   * SMI-5317: lazily-loaded Team-gated security advisories. `_advisories` is the
   * filtered list once `skill_audit` resolves; `_advisoryTierDenied` flips when
   * a free/Individual user hits the Team gate (drives the quiet inline upsell).
   * `_disposed` guards against writes after the panel is closed (C2). The static
   * session flag (M1) skips the wasted Team-gated call after the first denial.
   */
  private _advisories: McpAdvisory[] | null = null
  private _advisoryTierDenied = false
  private _disposed = false
  private static _advisoryTierDeniedSession = false

  /** Set the shared SkillService instance (called once at activation) */
  public static setSkillService(service: SkillService): void {
    SkillDetailPanel._skillService = service
  }

  /**
   * Inject the tree provider (called once at activation). Used to look up
   * whether the viewed skill is installed locally and where on disk. When unset
   * (tests / the dead `revive` path), the panel treats the skill as
   * available-only (C3).
   */
  public static setTreeProvider(provider: SkillTreeDataProvider | undefined): void {
    SkillDetailPanel._treeProvider = provider
  }

  /** Clear both injected statics between tests (M1). */
  public static resetForTests(): void {
    SkillDetailPanel._skillService = undefined as unknown as SkillService
    SkillDetailPanel._treeProvider = undefined
    SkillDetailPanel._advisoryTierDeniedSession = false
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
    this._disposed = true

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
      case 'uninstall':
        void this._handleUninstall()
        return
      case 'openSkillFile':
        if (this._skillPath && this._hasSkillMd) {
          void vscode.commands.executeCommand(
            'vscode.open',
            vscode.Uri.file(path.join(this._skillPath, 'SKILL.md'))
          )
          track('vscode_open_skill_file', { surface: 'detail-panel' })
        }
        return
      case 'openFolder':
        if (this._skillPath) {
          void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this._skillPath))
          track('vscode_open_folder', { surface: 'detail-panel' })
        }
        return
    }
  }

  /**
   * Handle an in-panel uninstall request. Re-resolves the installed entry at
   * click time (multi-window safety, M2); if it's gone, notifies and aborts.
   * Delegates to the shared `uninstallByTarget` core (which shows the success
   * toast + emits telemetry), then disposes the panel on success (H9) so the
   * dead local-only skill is never re-fetched into an error page.
   */
  private async _handleUninstall(): Promise<void> {
    const provider = SkillDetailPanel._treeProvider
    if (!this._skillPath || !provider) {
      return
    }

    // Re-find at click time — the skill may have been removed in another window.
    const key = skillComparisonKey(this._skillId)
    const local = provider.getInstalledSkills().find((s) => skillComparisonKey(s.id) === key)
    if (!local || !local.path) {
      void vscode.window.showInformationMessage('Skill no longer installed — refresh the tree')
      return
    }

    try {
      const ok = await uninstallByTarget(
        { skillId: this._skillId, skillPath: local.path },
        { treeProvider: provider },
        'detail-panel'
      )
      if (ok) {
        this.dispose()
      }
    } catch (err) {
      // H3: never let an uninstall throw escape the handler — the core already
      // emits `vscode_uninstall_failed` for known failure shapes; surface the
      // rest as a generic error rather than a silent drop.
      const msg = err instanceof Error ? err.message : String(err)
      void vscode.window.showErrorMessage(`Failed to uninstall "${this._skillId}": ${msg}`)
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
    // SMI-5317: clear stale advisory state before the new load (C1).
    this._advisories = null
    this._advisoryTierDenied = false

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
      this._resolveInstalledState()
      this._update()
      // SMI-5317: lazily auto-load Team-gated advisories; never block the base
      // panel render on the gated call (it throws TierDenied for free users).
      void this._loadAdvisories(this._skillId)
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const userMessage = mapErrorToUserMessage(rawMessage)
      const nonce = this._getNonce()
      this._panel.title = `Error: ${this._skillId}`
      this._panel.webview.html = getErrorHtml(userMessage, this._skillId, nonce, rawMessage)
    }
  }

  /**
   * Cross-reference the viewed skill against the installed list to populate the
   * `_installed` / `_skillPath` / `_hasSkillMd` fields that drive the action set.
   * Null-guards the provider: when unset (tests / dead `revive` path), the skill
   * is treated as available-only (C3).
   */
  private _resolveInstalledState(): void {
    const key = skillComparisonKey(this._skillId)
    const local = SkillDetailPanel._treeProvider
      ?.getInstalledSkills()
      .find((s) => skillComparisonKey(s.id) === key)
    this._installed = !!local
    this._skillPath = local?.path
    this._hasSkillMd = local?.hasSkillMd ?? false
  }

  /**
   * SMI-5317: lazily fetch Team-gated security advisories for the viewed skill
   * and re-render. Passive and non-modal — a free user sees a single quiet
   * upsell line, never a billing modal. Guards (C1/C2): the captured `skillId`
   * must still match `this._skillId` and the panel must not be disposed before
   * any state mutation. M1: skip entirely once the session has seen a denial.
   */
  private async _loadAdvisories(skillId: string): Promise<void> {
    if (SkillDetailPanel._advisoryTierDeniedSession) {
      return
    }
    const client = getMcpClient()
    if (!client.isConnected()) {
      return
    }
    try {
      const r = await client.skillAudit({ skillIds: [skillId] })
      // C1 (stale-skill) + C2 (dispose): bail before mutating if context moved on.
      if (this._disposed || this._skillId !== skillId) {
        return
      }
      // M3: defensive normalized filter (the server already filters by skillIds).
      const key = skillComparisonKey(skillId)
      const list = (r.advisories ?? []).filter((a) => skillComparisonKey(a.skillName) === key)
      this._advisories = list
      if (list.length > 0) {
        track('vscode_advisories_shown', { count: list.length, surface: 'detail-panel' })
      }
      this._update()
    } catch (err) {
      if (this._disposed || this._skillId !== skillId) {
        return
      }
      if (err instanceof McpToolError && err.code === 'TierDenied') {
        SkillDetailPanel._advisoryTierDeniedSession = true
        this._advisoryTierDenied = true
        track('vscode_advisories_tier_denied', { surface: 'detail-panel' })
        this._update()
      }
      // Other errors: silently leave _advisories null (no modal — passive load).
    }
  }

  private _update() {
    // C2: never touch the webview after the panel is disposed.
    if (this._disposed) {
      return
    }
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

    // Build the action context conditionally: under exactOptionalPropertyTypes
    // an optional `skillPath?: string` must be omitted (not set to undefined).
    const actionCtx: SkillActionContext = {
      installed: this._installed,
      hasSkillMd: this._hasSkillMd,
      ...(this._skillPath !== undefined ? { skillPath: this._skillPath } : {}),
    }
    return getSkillDetailHtml(skill, nonce, csp, this._showFullContent, actionCtx, {
      advisories: this._advisories,
      tierDenied: this._advisoryTierDenied,
    })
  }
}
