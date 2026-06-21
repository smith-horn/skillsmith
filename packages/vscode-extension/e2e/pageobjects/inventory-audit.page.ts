/**
 * Page object for the Skill Inventory Audit webview panel (SMI-5318 / SMI-5325).
 * Encapsulates opening the panel, entering its webview iframe, and driving the
 * SMI-5325 interactive-apply flow (webview button → native confirm modal).
 */
import { browser, $ } from '@wdio/globals'
import { type WebView } from 'wdio-vscode-service'

/** Panel title set by InventoryAuditPanel (`_panel.title`). */
const PANEL_TITLE = 'Skill Inventory Audit'

export class InventoryAuditPage {
  /**
   * Force an MCP connection. The extension only auto-connects on NON-first
   * activations (the first-run branch shows a welcome toast and skips connect),
   * and config-change driven connects race the test, so tests must trigger one
   * explicitly. `skillsmith.mcpReconnect` re-spawns the fake server and handshakes.
   */
  async forceConnect(): Promise<void> {
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.mcpReconnect')
    )
  }

  /**
   * Trigger the audit by command id (robust vs. command-palette fuzzy matching).
   * Runs in the extension host; the handler calls the (fake) MCP `skill_inventory_audit`
   * and opens the panel.
   */
  async runAudit(): Promise<void> {
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.auditInventory')
    )
  }

  /**
   * Open the audit panel and switch the wdio context INTO its webview iframe.
   * Retries the audit command until the panel appears: the handler early-returns
   * (no MCP call, no panel) while `isConnected()` is still false right after the
   * handshake, so a single invocation can race the connection. Disconnected
   * attempts never reach the fake server, so its stateful audit counter only
   * advances on the first CONNECTED call (→ the collision report).
   */
  async openAuditPanel(): Promise<WebView> {
    const workbench = await browser.getWorkbench()
    const webview = (await browser.waitUntil(
      async () => {
        await this.runAudit()
        try {
          return await workbench.getWebviewByTitle(PANEL_TITLE)
        } catch {
          return false
        }
      },
      {
        timeout: 40_000,
        interval: 3_000,
        timeoutMsg: `audit panel "${PANEL_TITLE}" did not open (MCP never connected?)`,
      }
    )) as WebView
    await webview.open()
    return webview
  }

  /** Re-enter an already-open panel's iframe (e.g. after a re-audit re-render). */
  async enterWebview(): Promise<WebView> {
    const workbench = await browser.getWorkbench()
    const webview = await workbench.getWebviewByTitle(PANEL_TITLE)
    await webview.open()
    return webview
  }

  /** Inside the iframe: click the "Apply rename…" button for a given collision id. */
  async clickApplyRename(collisionId: string): Promise<void> {
    const btn = await $(`.apply-rename-btn[data-collision="${collisionId}"]`)
    await btn.waitForClickable({ timeout: 15_000 })
    await btn.click()
  }
}
