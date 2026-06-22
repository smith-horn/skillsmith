/**
 * Page object for the two-step tree-context compare flow (SMI-5340).
 *
 * Both commands accept an optional `SkillTreeItem` arg; when provided, they
 * skip the QuickPick entirely. We pass a duck-typed plain object (no `new
 * SkillTreeItem(...)` — the class lives in src/ and is unavailable to the wdio
 * runner) via executeWorkbench's extra-arg channel, which JSON-serialises the
 * value across the extension-host bridge. The command handlers only access
 * `.skillData.*` so a plain object satisfies all checks.
 *
 * compareWithSelectedImpl also re-validates the compare-source skill via
 * `deps.skillService.getSkill(sourceId)` → `client.getSkill()` → MCP
 * `get_skill`. The fake server handles `get_skill` so this round-trip succeeds.
 */
import { browser } from '@wdio/globals'

export interface SyntheticSkillArg {
  skillData: {
    id: string
    name: string
    isInstalled?: boolean
    path?: string
  }
}

export class CompareSkillsPage {
  /**
   * Force an MCP connection (identical to InventoryAuditPage.forceConnect).
   * The extension only auto-connects on non-first activations; tests must
   * trigger one explicitly.
   */
  async forceConnect(): Promise<void> {
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.mcpReconnect')
    )
  }

  /**
   * Execute `skillsmith.selectForCompare` with a synthetic SkillTreeItem arg.
   * Sets the compare source (stored in compare-source.ts) without showing the
   * QuickPick.
   */
  async selectForCompare(arg: SyntheticSkillArg): Promise<void> {
    await browser.executeWorkbench(
      (vscode, a) => vscode.commands.executeCommand('skillsmith.selectForCompare', a),
      arg
    )
  }

  /**
   * Execute `skillsmith.compareWithSelected` with a synthetic SkillTreeItem arg
   * as the B skill.  The handler re-validates the source skill (MCP `get_skill`)
   * then calls `skill_compare` and opens CompareSkillsPanel.
   */
  async compareWithSelected(arg: SyntheticSkillArg): Promise<void> {
    await browser.executeWorkbench(
      (vscode, a) => vscode.commands.executeCommand('skillsmith.compareWithSelected', a),
      arg
    )
  }
}
