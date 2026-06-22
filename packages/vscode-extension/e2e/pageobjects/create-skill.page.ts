/**
 * Page object for the skillsmith.createSkill command (SMI-5339 Phase 2b).
 *
 * `createSkill` opens a webview wizard, but only after `ensureCliAvailable()`
 * succeeds. In CI there is no `skillsmith` binary on PATH, so the command
 * fails fast inside `ensureCliAvailable()` and the 'Create Skill' panel never
 * opens. This page object exposes the helpers needed to drive and assert that
 * degraded path without any fake-MCP dependency.
 */
import { browser } from '@wdio/globals'

export class CreateSkillPage {
  /**
   * Force an MCP connection. Mirrors InventoryAuditPage / DiffSkillPage so the
   * extension host is in a consistent state before the command under test fires.
   */
  async forceConnect(): Promise<void> {
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.mcpReconnect')
    )
  }

  /**
   * Execute `skillsmith.createSkill`. The command takes no arguments.
   * On CI (no `skillsmith` binary) `ensureCliAvailable()` rejects before the
   * panel is constructed, so the returned promise resolves without opening a tab.
   */
  async openCreate(): Promise<void> {
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.createSkill')
    )
  }

  /**
   * Returns true if a tab whose label is exactly 'Create Skill' is currently
   * open in any tab group. Checks synchronously inside the extension host so
   * no round-trip to the webview DOM is needed.
   *
   * The CreateSkillPanel sets `panel.title = 'Create Skill'` (CreateSkillPanel.ts:80).
   */
  async createTabExists(): Promise<boolean> {
    return (await browser.executeWorkbench((vscode) => {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.label === 'Create Skill') {
            return true
          }
        }
      }
      return false
    })) as boolean
  }
}
