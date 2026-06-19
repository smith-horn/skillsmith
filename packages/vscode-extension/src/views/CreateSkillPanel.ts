/**
 * Webview panel for the single-page Create Skill wizard (SMI-5313 / GH #1454).
 *
 * Mirrors SkillDetailPanel's singleton lifecycle but renders a static form once
 * and drives all subsequent state via the typed postMessage protocol
 * (create-panel-types.ts). The caller (createSkillCommand) is responsible for
 * `ensureCliAvailable()` BEFORE the first open; on reveal of an existing panel,
 * form state is preserved (no reset).
 *
 * Concurrency / lifecycle guards (binding, from the plan-review findings):
 *  - H1: onDidReceiveMessage is wired BEFORE webview.html is assigned.
 *  - C1: `_creating` is set synchronously on receiving `submit`, before any
 *    await; a second submit while creating is dropped.
 *  - C2: `_succeeded` is set ONLY on the confirmed success path, immediately
 *    before dispose(); onDidDispose fires `vscode_create_cancelled` only when
 *    `!_succeeded`.
 *  - L3: dispose() does NOT kill an in-flight crossSpawn child (a kill would
 *    race the success path; matches the old runWizard behavior).
 */
import * as vscode from 'vscode'
import * as path from 'node:path'
import { generateCspNonce, getCreateSkillCsp } from '../utils/csp.js'
import { track } from '../services/Telemetry.js'
import { validateSkillName } from '../utils/skillNameValidation.js'
import type { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import type {
  CreatePanelInbound,
  CreatePanelOutbound,
  CreateFormFields,
} from './create-panel-types.js'
import {
  buildCreateArgs,
  runCli,
  exists,
  targetDirFor,
  showPostCreateChecklist,
} from '../utils/createSkill.helpers.js'
import { getCreateSkillHtml } from './create-panel-html.js'

const VALID_TYPES: ReadonlySet<string> = new Set(['basic', 'intermediate', 'advanced'])

export class CreateSkillPanel {
  public static currentPanel: CreateSkillPanel | undefined
  public static readonly viewType = 'skillsmith.createSkillWizard'

  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri
  private readonly _output: vscode.OutputChannel
  private readonly _treeProvider: SkillTreeDataProvider
  private _disposables: vscode.Disposable[] = []

  /** C1: in-process re-entrancy lock; a `submit` while true is dropped. */
  private _creating = false
  /** C2: set ONLY on the confirmed success path, immediately before dispose(). */
  private _succeeded = false
  /** Guards `_post` after dispose so we never message a torn-down webview. */
  private _disposed = false

  /**
   * Open a new Create Skill panel, OR reveal the existing one (singleton).
   * The caller MUST run `ensureCliAvailable()` before the first open. On reveal,
   * existing form state is preserved (no reset).
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    output: vscode.OutputChannel,
    treeProvider: SkillTreeDataProvider
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    if (CreateSkillPanel.currentPanel) {
      CreateSkillPanel.currentPanel._panel.reveal(column)
      return
    }

    const panel = vscode.window.createWebviewPanel(
      CreateSkillPanel.viewType,
      'Create Skill',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
      }
    )

    CreateSkillPanel.currentPanel = new CreateSkillPanel(panel, extensionUri, output, treeProvider)
  }

  /** Clear the singleton between tests. */
  public static resetForTests(): void {
    CreateSkillPanel.currentPanel = undefined
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    output: vscode.OutputChannel,
    treeProvider: SkillTreeDataProvider
  ) {
    this._panel = panel
    this._extensionUri = extensionUri
    this._output = output
    this._treeProvider = treeProvider

    // Reference the extensionUri for the localResourceRoots contract / future
    // resource loading (keeps it a tracked field without an unused-var lint).
    void this._extensionUri

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // H1: wire the message listener BEFORE assigning html, so an early debounced
    // `validateName` from the webview is never dropped.
    this._panel.webview.onDidReceiveMessage(
      (message: CreatePanelInbound) => {
        void this._handleMessage(message)
      },
      null,
      this._disposables
    )

    const nonce = generateCspNonce()
    this._panel.webview.html = getCreateSkillHtml(nonce, getCreateSkillCsp(nonce))
  }

  public dispose(): void {
    // L1: re-entry guard — if `_panel.dispose()` ever fires `onDidDispose`
    // synchronously, this prevents a double `vscode_create_cancelled`.
    if (this._disposed) {
      return
    }
    this._disposed = true
    CreateSkillPanel.currentPanel = undefined

    // C2: a close that wasn't a confirmed success is a cancellation.
    if (!this._succeeded) {
      track('vscode_create_cancelled', { stage: 'wizard' })
    }

    // L3: do NOT kill any in-flight crossSpawn child here — a kill would race
    // the success path (matches the old runWizard behavior).
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  /** Post an outbound message; no-op once disposed. */
  private _post(msg: CreatePanelOutbound): void {
    if (this._disposed) {
      return
    }
    void this._panel.webview.postMessage(msg)
  }

  private async _handleMessage(message: CreatePanelInbound): Promise<void> {
    switch (message.command) {
      case 'validateName': {
        const res = validateSkillName(message.value)
        this._post({
          command: 'nameValidity',
          valid: res === true,
          ...(res === true ? {} : { message: res }),
        })
        return
      }
      case 'submit':
        await this._handleSubmit(message.fields)
        return
      case 'cancel':
        // onDidDispose fires the cancelled telemetry via the _succeeded guard.
        this.dispose()
        return
    }
  }

  private async _handleSubmit(fields: CreateFormFields): Promise<void> {
    // C1: synchronous re-entrancy lock — must be the first thing, before any await.
    if (this._creating) {
      return
    }
    this._creating = true

    const errors = this._validateFields(fields)
    if (Object.keys(errors).length > 0) {
      this._post({ command: 'submitError', errors })
      this._creating = false
      return
    }

    const targetDir = targetDirFor(fields.name)

    if (await exists(targetDir)) {
      const choice = await vscode.window.showWarningMessage(
        `A skill named "${fields.name}" already exists at ${targetDir}.`,
        { modal: true, detail: 'Overwrite it?' },
        'Overwrite'
      )
      if (choice !== 'Overwrite') {
        track('vscode_create_cancelled', { stage: 'overwrite' })
        this._post({ command: 'createFailed', message: 'Cancelled.' })
        this._creating = false
        return
      }
    }

    this._post({ command: 'creating' })

    const code = await runCli(buildCreateArgs(fields), this._output, (chunk) =>
      this._post({ command: 'cliOutput', chunk })
    )

    if (code === 0) {
      track('vscode_create_complete', { type: fields.type })
      await this._treeProvider.refreshAndWait()
      // C2: mark success only here, immediately before dispose().
      this._succeeded = true
      try {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(path.join(targetDir, 'SKILL.md'))
        )
        await vscode.window.showTextDocument(doc)
      } catch {
        // SKILL.md may be absent for an unexpected scaffold shape — not fatal.
      }
      this.dispose()
      void showPostCreateChecklist(targetDir, fields.name)
      return
    }

    track('vscode_create_failed', { reason: 'cli_nonzero_exit', exit_code: code })
    this._post({
      command: 'createFailed',
      message: `Create failed (exit ${code}). See the log.`,
    })
    this._creating = false
  }

  /** Re-validate all fields host-side; returns a field→message map (empty = ok). */
  private _validateFields(
    fields: CreateFormFields
  ): Partial<Record<keyof CreateFormFields, string>> {
    const errors: Partial<Record<keyof CreateFormFields, string>> = {}
    if (!fields.author?.trim()) {
      errors.author = 'Author is required'
    }
    const nameRes = validateSkillName(fields.name ?? '')
    if (nameRes !== true) {
      errors.name = nameRes
    }
    if (!fields.description?.trim()) {
      errors.description = 'Description is required'
    }
    if (!VALID_TYPES.has(fields.type)) {
      errors.type = 'Select a skill type'
    }
    return errors
  }
}
