/**
 * Page object for the skillsmith.diffSkill tree-context command (SMI-5340).
 *
 * When `preselected.skillData.isInstalled && preselected.skillData.path` is
 * truthy, diffCommandImpl skips the QuickPick and reads SKILL.md from the
 * provided `path`.  We pass a duck-typed plain object via executeWorkbench's
 * extra-arg channel — the handler only checks `.skillData.*` properties.
 *
 * After reading SKILL.md, the command calls:
 *   1. `client.getSkill(skill.id)` → MCP `get_skill` (registry content)
 *   2. `client.skillDiff(args)` → MCP `skill_diff`
 * Both are handled by the fake server; `get_skill` returns a non-empty
 * `content` field so the "no registry content" early-return is not hit.
 */
import { browser } from '@wdio/globals'

export interface SyntheticInstalledSkillArg {
  skillData: {
    id: string
    name: string
    isInstalled: true
    /** Absolute path to the directory containing SKILL.md. */
    path: string
    trustTier?: string
  }
}

export class DiffSkillPage {
  /**
   * Force an MCP connection (identical to InventoryAuditPage.forceConnect).
   */
  async forceConnect(): Promise<void> {
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.mcpReconnect')
    )
  }

  /**
   * Execute `skillsmith.diffSkill` with a synthetic installed SkillTreeItem arg.
   * Skips the installed-skill QuickPick and goes straight to the MCP calls.
   */
  async diffSkill(arg: SyntheticInstalledSkillArg): Promise<void> {
    await browser.executeWorkbench(
      (vscode, a) => vscode.commands.executeCommand('skillsmith.diffSkill', a),
      arg
    )
  }
}
