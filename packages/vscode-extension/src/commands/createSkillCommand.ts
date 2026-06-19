/**
 * Register `skillsmith.createSkill` (SMI-5313 / GH #1454).
 *
 * Opens the single-page Create Skill webview wizard (CreateSkillPanel). The
 * command verifies the CLI is available before opening the panel; once open,
 * the panel drives all form state and CLI interaction. Re-invoking the command
 * while the panel is already open simply reveals it (H5 — no redundant CLI check).
 *
 * Output is streamed to a dedicated OutputChannel so completion status is
 * observable (exit code captured). OutputChannel preferred over Terminal because
 * the `-y` non-interactive path has no interactive I/O.
 */
import * as vscode from 'vscode'
import { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import { track } from '../services/Telemetry.js'
import { withTelemetry } from '../services/telemetry-wrap.js'
import { ensureCliAvailable } from '../utils/createSkill.helpers.js'
import { CreateSkillPanel } from '../views/CreateSkillPanel.js'

interface CreateSkillDeps {
  output: vscode.OutputChannel
  treeProvider: SkillTreeDataProvider
  extensionUri: vscode.Uri
}

// SMI-5130: extracted from the inline registerCommand closure so withTelemetry
// can wrap it at the export boundary (telemetry coverage gate).
async function createSkillImpl(deps: CreateSkillDeps): Promise<void> {
  const { output, treeProvider, extensionUri } = deps

  if (CreateSkillPanel.currentPanel) {
    // H5: re-invoking while open just reveals — no second ensureCliAvailable.
    CreateSkillPanel.createOrShow(extensionUri, output, treeProvider)
    return
  }

  track('vscode_create_start')
  if (!(await ensureCliAvailable())) {
    track('vscode_create_failed', { reason: 'cli_missing' })
    return
  }
  CreateSkillPanel.createOrShow(extensionUri, output, treeProvider)
}

export const createSkillAction = withTelemetry(createSkillImpl, {
  source: 'vscode-extension',
  // SMI-5143: CLI-aligned action name (shared skill_id across CLI + VS Code).
  extractSkillId: () => 'create',
})

export function registerCreateSkillCommand(
  context: vscode.ExtensionContext,
  treeProvider: SkillTreeDataProvider
): void {
  const output = vscode.window.createOutputChannel('Skillsmith CLI')
  context.subscriptions.push(output)

  const extensionUri = context.extensionUri
  const disposable = vscode.commands.registerCommand('skillsmith.createSkill', () =>
    createSkillAction({ output, treeProvider, extensionUri })
  )
  context.subscriptions.push(disposable)
}
