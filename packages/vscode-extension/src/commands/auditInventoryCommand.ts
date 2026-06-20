/**
 * Audit Inventory command — audit the local `~/.claude/` inventory for
 * namespace collisions via the ungated `skill_inventory_audit` MCP tool, then
 * render the report in InventoryAuditPanel (SMI-5318 / Epic D / PR-D3).
 *
 * The tool is Community-tier and never tier-denies, so there is no
 * `handleTierDenied` path here. Mirrors recommendCommand's command shape
 * (track + isConnected guard + try/catch + withTelemetry export + register fn).
 *
 * @module commands/auditInventoryCommand
 */
import * as vscode from 'vscode'
import { getMcpClient } from '../mcp/McpClient.js'
import { withTelemetry } from '../services/telemetry-wrap.js'
import { track } from '../services/Telemetry.js'
import { InventoryAuditPanel } from '../views/InventoryAuditPanel.js'

async function auditInventoryCommandImpl(): Promise<void> {
  track('vscode_inventory_audit_start')

  const client = getMcpClient()

  if (!client.isConnected()) {
    void vscode.window.showInformationMessage(
      'Connect to the Skillsmith MCP server to audit your inventory.'
    )
    return
  }

  // SMI-5326: opt into the slower semantic-overlap pass via setting. Pass `deep`
  // only when true — exactOptionalPropertyTypes forbids `{ deep: undefined }`,
  // and `{}` preserves the existing fast-path default.
  const deep = vscode.workspace
    .getConfiguration('skillsmith')
    .get<boolean>('inventoryAudit.deep', false)

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Auditing skill inventory…' },
      async (_progress, token) => {
        const response = await client.skillInventoryAudit(deep ? { deep: true } : {})
        if (token.isCancellationRequested) return

        const flags = response.summary.errorCount + response.summary.warningCount
        track('vscode_inventory_audit_complete', {
          collisions: flags,
          entries: response.summary.totalEntries,
        })
        if (response.summary.totalFlags === 0) {
          track('vscode_inventory_audit_empty')
        }

        InventoryAuditPanel.createOrShow(vscode.Uri.file(''), response)
      }
    )
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
  }
}

export const auditInventoryCommandAction = withTelemetry(auditInventoryCommandImpl, {
  source: 'vscode-extension',
  extractSkillId: () => 'inventory-audit',
})

/**
 * Registers the Audit Inventory command (`skillsmith.auditInventory`).
 */
export function registerAuditInventoryCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('skillsmith.auditInventory', () =>
      auditInventoryCommandAction()
    )
  )
}
