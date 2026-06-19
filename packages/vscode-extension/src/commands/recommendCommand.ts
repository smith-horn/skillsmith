/**
 * Recommend Command — surface contextual skill recommendations via MCP
 * (SMI-5314 / Epic D / PR-D1).
 *
 * @module commands/recommendCommand
 */
import * as vscode from 'vscode'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import { handleTierDenied } from '../mcp/tierDenied.js'
import { getTrustTierCodicon } from '../sidebar/trustTier.js'
import { withTelemetry } from '../services/telemetry-wrap.js'
import { track } from '../services/Telemetry.js'

/** QuickPick item that carries the resolved skill_id for downstream navigation. */
interface RecommendQuickPickItem extends vscode.QuickPickItem {
  skillId: string
}

async function recommendCommandImpl(): Promise<void> {
  track('vscode_recommend_start')

  const client = getMcpClient()

  if (!client.isConnected()) {
    vscode.window.showInformationMessage(
      'Connect to the Skillsmith MCP server to get recommendations.'
    )
    return
  }

  try {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name
    const extraArgs = workspaceName ? { project_context: workspaceName } : {}

    const response = await client.skillRecommend({ limit: 10, ...extraArgs })
    const { recommendations } = response

    if (recommendations.length === 0) {
      track('vscode_recommend_empty')
      const action = await vscode.window.showInformationMessage(
        'No skill recommendations found for this workspace.',
        'Search skills'
      )
      if (action === 'Search skills') {
        await vscode.commands.executeCommand('skillsmith.searchSkills')
      }
      return
    }

    const items: RecommendQuickPickItem[] = recommendations.map((r) => ({
      label: `${getTrustTierCodicon(r.trust_tier)} ${r.name}`,
      description: r.reason,
      detail: `similarity ${Math.round(r.similarity_score * 100)}% · quality ${r.quality_score}/100`,
      skillId: r.skill_id,
    }))

    track('vscode_recommend_complete', { count: recommendations.length })

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Recommended Skills',
      matchOnDescription: true,
      matchOnDetail: true,
    })

    if (picked) {
      await vscode.commands.executeCommand('skillsmith.viewSkillDetails', picked.skillId)
    }
  } catch (err) {
    if (err instanceof McpToolError && err.code === 'TierDenied') {
      await handleTierDenied('skillsmith.recommendSkills', err)
      return
    }
    vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
  }
}

export const recommendCommandAction = withTelemetry(recommendCommandImpl, {
  source: 'vscode-extension',
  extractSkillId: () => 'recommend',
})

export function registerRecommendCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('skillsmith.recommendSkills', () => recommendCommandAction())
  )
}
