/**
 * Check Skill for Updates command (SMI-5316 / #1457).
 *
 * Product framing (owner decision D-B): an UPDATE ADVISOR. Pick an installed
 * skill, read its local SKILL.md, fetch the registry's latest version, and run
 * `skill_diff` to advise whether to update. The result opens in SkillDiffPanel,
 * which leads with the recommendation verdict. `skill_diff` is tier-gated to
 * Individual+ — a denial routes to the upgrade UX BEFORE any panel opens.
 *
 * SMI-5412: bare-id (local) skills now resolve their upstream source from
 * ~/.skillsmith/manifest.json (written by SMI-5407) and diff against the raw
 * GitHub SKILL.md instead of immediately blocking with the "not published"
 * message (SMI-5406). When no source is tracked, an actionable prompt guides
 * the user to run `sklx audit sources` / MCP `skill_recover_source`.
 *
 * @module commands/diffCommand
 */
import * as vscode from 'vscode'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { SkillItemData, SkillTreeItem } from '../sidebar/SkillTreeItem.js'
import type { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import { getTrustTierCodicon } from '../sidebar/trustTier.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import { handleTierDenied } from '../mcp/tierDenied.js'
import { withTelemetry } from '../services/telemetry-wrap.js'
import { track } from '../services/Telemetry.js'
import { SkillDiffPanel } from '../views/SkillDiffPanel.js'
import type { SkillDiffArgs } from '../views/diff-panel-types.js'
import { isLocalSkillId } from '../utils/skillId.js'
import { readManifestEntry, fetchRawSkillMd } from '../services/manifestReader.js'

interface InstalledPickItem extends vscode.QuickPickItem {
  item: SkillItemData
}

/** Map the extension's 5-tier trust model to skill_diff's narrower input. */
function toDiffTrustTier(tier: SkillItemData['trustTier']): 'verified' | 'community' {
  return tier === 'verified' ? 'verified' : 'community'
}

/** Show the installed-skill picker; resolve with the pick or undefined (cancel). */
async function pickInstalledSkill(
  treeProvider: SkillTreeDataProvider
): Promise<SkillItemData | undefined> {
  const installed = treeProvider.getInstalledSkills().filter((s) => s.path)
  if (installed.length === 0) {
    void vscode.window.showInformationMessage('No installed skills to check for updates.')
    return undefined
  }

  const items: InstalledPickItem[] = installed.map((s) => ({
    label: `${getTrustTierCodicon(s.trustTier)} ${s.name}`,
    description: s.id,
    item: s,
  }))

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Check Skill for Updates',
    placeHolder: 'Select an installed skill to compare with the latest version',
    matchOnDescription: true,
  })
  return picked?.item
}

async function diffCommandImpl(deps: {
  treeProvider: SkillTreeDataProvider
  context: vscode.ExtensionContext
  preselected?: SkillTreeItem | undefined
}): Promise<void> {
  track('vscode_diff_start')

  let skill: SkillItemData | undefined
  if (deps.preselected?.skillData?.isInstalled && deps.preselected.skillData.path) {
    skill = deps.preselected.skillData
  } else {
    skill = await pickInstalledSkill(deps.treeProvider)
  }
  if (!skill || !skill.path) {
    return
  }

  // Read the locally-installed SKILL.md (oldContent). Both the registry path and
  // the local-source path need this, so we resolve it before branching on skill type.
  let oldContent: string
  try {
    oldContent = await readFile(path.join(skill.path, 'SKILL.md'), 'utf8')
  } catch {
    void vscode.window.showInformationMessage(
      `Couldn't read SKILL.md for "${skill.name}" — nothing to compare.`
    )
    return
  }
  if (!oldContent.trim()) {
    void vscode.window.showInformationMessage(`"${skill.name}" has no SKILL.md content to compare.`)
    return
  }

  const client = getMcpClient()
  if (!client.isConnected()) {
    void vscode.window.showInformationMessage(
      'Skillsmith server is not connected. Start the MCP server and try again.'
    )
    return
  }

  try {
    let newContent: string

    if (isLocalSkillId(skill.id)) {
      // Local (bare-id) skill: attempt to diff against the upstream source
      // recorded in ~/.skillsmith/manifest.json (recovered by SMI-5407).
      // If no source is tracked, prompt the user to run the recovery tool
      // rather than showing the old "not published" copy (SMI-5406).
      const entry = await readManifestEntry({ name: skill.name, id: skill.id, path: skill.path })
      if (!entry?.source) {
        void vscode.window.showInformationMessage(
          `"${skill.name}" is a local skill. Run \`sklx audit sources\` (or MCP \`skill_recover_source\`) to recover its source, then try View Changes again.`
        )
        return
      }
      const fetched = await fetchRawSkillMd(entry.source)
      if (fetched === null) {
        void vscode.window.showInformationMessage(
          `Couldn't fetch the latest version from ${entry.source}. Check your network connection and try again.`
        )
        return
      }
      newContent = fetched
    } else {
      // Registry-latest content (newContent).
      const detail = await client.getSkill(skill.id)
      const content = detail.content
      if (!content || !content.trim()) {
        void vscode.window.showInformationMessage(
          `"${skill.name}" isn't in the registry, so there's no newer version to compare against.`
        )
        return
      }
      newContent = content
    }

    const args: SkillDiffArgs = {
      skillId: skill.id,
      oldContent,
      newContent,
      trustTier: toDiffTrustTier(skill.trustTier),
    }

    const response = await client.skillDiff(args)
    SkillDiffPanel.createOrShow(deps.context.extensionUri, skill.name, response, args)
    track('vscode_diff_complete', { changeType: response.changeType })
  } catch (err) {
    if (err instanceof McpToolError) {
      // Route a tier denial to the upgrade UX before any panel opens. The
      // defensive message check covers a denial that arrives without the
      // TierDenied code (e.g. a differently-shaped middleware message). Kept
      // narrow — grouped to "requires … (tier|plan)" so a bare "upgrade"
      // substring in an unrelated error can't misroute (M1).
      if (err.code === 'TierDenied' || /requires .*(tier|plan)/i.test(err.message)) {
        await handleTierDenied('skillsmith.diffSkill', err)
        return
      }
      if (err.code === 'SkillNotFound') {
        void vscode.window.showWarningMessage(
          'This skill could not be found in the registry. It may have been removed or renamed.'
        )
        return
      }
      void vscode.window.showErrorMessage(err.message)
      return
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    void vscode.window.showErrorMessage(`Could not check for updates: ${message}`)
  }
}

export const diffCommandAction = withTelemetry(diffCommandImpl, {
  source: 'vscode-extension',
  extractSkillId: () => 'diff',
})

/**
 * Registers the Check Skill for Updates command (`skillsmith.diffSkill`).
 */
export function registerDiffCommand(
  context: vscode.ExtensionContext,
  treeProvider: SkillTreeDataProvider
): void {
  const command = vscode.commands.registerCommand('skillsmith.diffSkill', (arg?: SkillTreeItem) =>
    diffCommandAction({ treeProvider, context, preselected: arg })
  )
  context.subscriptions.push(command)
}
