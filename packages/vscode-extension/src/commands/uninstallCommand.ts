import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import { handleTierDenied } from '../mcp/tierDenied.js'
import { getSkillsDirectory } from '../services/installUtils.js'
import { track } from '../services/Telemetry.js'
import { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import { SkillTreeItem } from '../sidebar/SkillTreeItem.js'
import { assertInsideRoot, PathOutsideRoot } from '../utils/pathContainment.js'
import { withTelemetry } from '../services/telemetry-wrap.js'

interface InstalledPick extends vscode.QuickPickItem {
  skillId: string
  skillPath: string
}

interface UninstallCommandDeps {
  treeProvider: SkillTreeDataProvider
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
/** Where the uninstall was initiated from (drives the `via` telemetry dimension). */
type UninstallVia = 'context-menu' | 'palette' | 'detail-panel'

/**
 * Shared uninstall core (SMI-5308 / L3). Runs the confirm → containment guard →
 * MCP-first → `fs.rm` fallback → tierDenied → refresh → success-toast → telemetry
 * sequence for ALL entry paths (command palette, tree context menu, detail
 * panel). Keeping the `track()` calls here guarantees every caller emits the
 * full start/complete/failed/cancelled envelope.
 *
 * `via` is an explicit parameter (NOT derived from the target) so each caller
 * declares its own surface.
 *
 * @returns `true` on a successful uninstall, `false` on cancel/refusal/failure.
 */
export async function uninstallByTarget(
  target: { skillId: string; skillPath: string },
  deps: UninstallCommandDeps,
  via: UninstallVia
): Promise<boolean> {
  const { treeProvider } = deps
  track('vscode_uninstall_start', { via })

  const confirm = await vscode.window.showWarningMessage(
    `Uninstall skill "${target.skillId}"?`,
    {
      modal: true,
      detail: `This will permanently delete:\n${target.skillPath}\n\nThis action cannot be undone.`,
    },
    'Uninstall'
  )
  if (confirm !== 'Uninstall') {
    track('vscode_uninstall_cancelled', { via, stage: 'confirm' })
    return false
  }

  const skillsRoot = getSkillsDirectory()
  try {
    await assertInsideRoot(target.skillPath, skillsRoot)
  } catch (err) {
    if (err instanceof PathOutsideRoot) {
      track('vscode_uninstall_failed', { via, reason: 'path_outside_root' })
      void vscode.window.showErrorMessage(
        `Refusing to uninstall: "${target.skillPath}" resolves outside the configured skills directory.`
      )
      return false
    }
    throw err
  }

  const client = getMcpClient()
  let uninstalled = false

  if (client.isConnected()) {
    try {
      const result = await client.uninstallSkill(target.skillId)
      if (!result.success) {
        // MCP is reachable and deliberately refused — surface this, do NOT fall back to
        // fs.rm. Falling back would bypass server-side enforcement (e.g. tier-gated ops).
        // SMI-5288: a TierDenied refusal arrives as a structured {success:false}
        // payload (not an isError throw), so route it to the upgrade UX.
        if (/^TierDenied/i.test(result.error ?? '')) {
          track('vscode_uninstall_failed', { via, reason: 'tier_denied' })
          await handleTierDenied(
            'skillsmith.uninstallSkill',
            new McpToolError('uninstall_skill', 'TierDenied', result.error!)
          )
          return false
        }
        const reason = result.error ?? 'MCP server refused the uninstall request'
        track('vscode_uninstall_failed', { via, reason: 'mcp_refused' })
        void vscode.window.showErrorMessage(`Failed to uninstall "${target.skillId}": ${reason}`)
        return false
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
      await fs.rm(target.skillPath, { recursive: true, force: true })
      uninstalled = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      track('vscode_uninstall_failed', { via, reason: 'fs_rm_error' })
      void vscode.window.showErrorMessage(`Failed to uninstall "${target.skillId}": ${msg}`)
      return false
    }
  }

  await treeProvider.refreshAndWait()
  track('vscode_uninstall_complete', { via })
  void vscode.window.showInformationMessage(`Uninstalled "${target.skillId}".`)
  return true
}

// SMI-5130: extracted from the inline registerCommand closure so withTelemetry
// can wrap it at the export boundary (telemetry coverage gate).
async function uninstallCommandImpl(
  deps: UninstallCommandDeps,
  arg?: SkillTreeItem
): Promise<void> {
  const { treeProvider } = deps
  const via: UninstallVia = arg?.skillData?.isInstalled ? 'context-menu' : 'palette'
  const pick = await resolveTarget(arg, treeProvider)
  if (!pick) {
    // The resolve-stage cancel fires before the core's `start`, so emit `start`
    // here too to keep the start→cancelled envelope intact for this path.
    track('vscode_uninstall_start', { via })
    track('vscode_uninstall_cancelled', { via, stage: 'resolve' })
    return
  }

  await uninstallByTarget(pick, deps, via)
}

export const uninstallCommandAction = withTelemetry(uninstallCommandImpl, {
  source: 'vscode-extension',
  // SMI-5143: CLI-aligned action name. The CLI's canonical command is `remove`
  // (`uninstall` is an alias); the MCP tool stays `uninstall_skill`. `'remove'`
  // gives CLI↔VS Code correlation for the uninstall action.
  extractSkillId: () => 'remove',
})

export function registerUninstallCommand(
  context: vscode.ExtensionContext,
  treeProvider: SkillTreeDataProvider
): void {
  const disposable = vscode.commands.registerCommand(
    'skillsmith.uninstallSkill',
    (arg?: SkillTreeItem) => uninstallCommandAction({ treeProvider }, arg)
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
