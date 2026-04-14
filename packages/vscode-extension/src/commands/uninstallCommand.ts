import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import { getMcpClient } from '../mcp/McpClient.js'
import { getSkillsDirectory } from '../services/installUtils.js'
import { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import { SkillTreeItem } from '../sidebar/SkillTreeItem.js'
import { assertInsideRoot, PathOutsideRoot } from '../utils/pathContainment.js'

interface InstalledPick extends vscode.QuickPickItem {
  skillId: string
  skillPath: string
}

/**
 * Register `skillsmith.uninstallSkill` (SMI-4195, closes GH #485).
 *
 * Invocation paths:
 *   - Command palette → quickPick of installed skills
 *   - Tree context menu → `SkillTreeItem` passed as argument
 *
 * Flow: select → modal confirm (id + resolved path) → realpath containment
 * check → MCP uninstall_skill → refresh tree. Falls back to `fs.rm` when MCP
 * is disconnected (same containment guard).
 */
export function registerUninstallCommand(
  context: vscode.ExtensionContext,
  treeProvider: SkillTreeDataProvider
): void {
  const disposable = vscode.commands.registerCommand(
    'skillsmith.uninstallSkill',
    async (arg?: SkillTreeItem) => {
      const pick = await resolveTarget(arg, treeProvider)
      if (!pick) return

      const confirm = await vscode.window.showWarningMessage(
        `Uninstall skill "${pick.skillId}"?`,
        {
          modal: true,
          detail: `This will permanently delete:\n${pick.skillPath}\n\nThis action cannot be undone.`,
        },
        'Uninstall'
      )
      if (confirm !== 'Uninstall') return

      const skillsRoot = getSkillsDirectory()
      try {
        await assertInsideRoot(pick.skillPath, skillsRoot)
      } catch (err) {
        if (err instanceof PathOutsideRoot) {
          void vscode.window.showErrorMessage(
            `Refusing to uninstall: "${pick.skillPath}" resolves outside the configured skills directory.`
          )
          return
        }
        throw err
      }

      const client = getMcpClient()
      let uninstalled = false

      if (client.isConnected()) {
        try {
          const result = await client.uninstallSkill(pick.skillId)
          if (!result.success) {
            // MCP is reachable and deliberately refused — surface this, do NOT fall back to
            // fs.rm. Falling back would bypass server-side enforcement (e.g. tier-gated ops).
            const reason = result.error ?? 'MCP server refused the uninstall request'
            void vscode.window.showErrorMessage(
              `Failed to uninstall "${pick.skillId}": ${reason}`
            )
            return
          }
          uninstalled = true
        } catch (err) {
          // Transport-level failure (disconnected mid-call, timeout, etc.).
          // Fall through to the fs.rm branch below.
          console.warn('[Skillsmith] MCP uninstall transport error, falling back to fs.rm:', err)
        }
      }

      if (!uninstalled) {
        try {
          await fs.rm(pick.skillPath, { recursive: true, force: true })
          uninstalled = true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          void vscode.window.showErrorMessage(`Failed to uninstall "${pick.skillId}": ${msg}`)
          return
        }
      }

      await treeProvider.refreshAndWait()
      void vscode.window.showInformationMessage(`Uninstalled "${pick.skillId}".`)
    }
  )
  context.subscriptions.push(disposable)
}

async function resolveTarget(
  arg: SkillTreeItem | undefined,
  treeProvider: SkillTreeDataProvider
): Promise<{ skillId: string; skillPath: string } | undefined> {
  if (arg?.skillData?.isInstalled && arg.skillData.path) {
    return { skillId: arg.skillData.id, skillPath: arg.skillData.path }
  }

  await treeProvider.refreshAndWait()
  const installed = treeProvider.getInstalledSkills()
  if (installed.length === 0) {
    void vscode.window.showInformationMessage('No installed skills to uninstall.')
    return undefined
  }

  const items: InstalledPick[] = installed
    .filter((s): s is typeof s & { path: string } => typeof s.path === 'string')
    .map((s) => {
      const item: InstalledPick = {
        label: s.name,
        description: s.id,
        skillId: s.id,
        skillPath: s.path,
      }
      if (s.description) item.detail = s.description
      return item
    })

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Uninstall Skill',
    placeHolder: 'Select a skill to remove',
    matchOnDescription: true,
    matchOnDetail: true,
  })

  return picked ? { skillId: picked.skillId, skillPath: picked.skillPath } : undefined
}
