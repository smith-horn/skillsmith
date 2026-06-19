/**
 * Compare Skills command (SMI-5315 / #1456).
 *
 * Two sequential debounced QuickPick searches pick exactly two skills, then
 * `skill_compare` runs and the result opens in CompareSkillsPanel. Mirrors
 * installCommand's debounced `createQuickPick` search pattern + the
 * withTelemetry export/register shape.
 *
 * @module commands/compareCommand
 */
import * as vscode from 'vscode'
import type { SkillData } from '../types/skill.js'
import type { SkillService } from '../services/SkillService.js'
import { getTrustTierCodicon, getTrustTierLabel } from '../sidebar/trustTier.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import { handleTierDenied } from '../mcp/tierDenied.js'
import { withTelemetry } from '../services/telemetry-wrap.js'
import { track } from '../services/Telemetry.js'
import { CompareSkillsPanel } from '../views/CompareSkillsPanel.js'

/** Debounce delay for search input (matches installCommand). */
const SEARCH_DEBOUNCE_MS = 300

interface SkillQuickPickItem extends vscode.QuickPickItem {
  skill: SkillData | null
}

function createQuickPickItem(skill: SkillData): SkillQuickPickItem {
  const trustIcon = getTrustTierCodicon(skill.trustTier)
  const tierLabel = getTrustTierLabel(skill.trustTier)
  return {
    label: `${trustIcon} ${skill.name}`,
    description: tierLabel ? `by ${skill.author} | ${tierLabel}` : `by ${skill.author}`,
    detail: skill.description,
    skill,
  }
}

/**
 * Shows one debounced skill-search QuickPick and resolves with the picked
 * skill, or `undefined` when the user dismisses it (silent cancel).
 */
function pickSkill(skillService: SkillService, title: string): Promise<SkillData | undefined> {
  return new Promise<SkillData | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<SkillQuickPickItem>()
    quickPick.title = title
    quickPick.placeholder = 'Search for a skill to compare'
    quickPick.matchOnDescription = true
    quickPick.matchOnDetail = true

    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let accepted = false

    quickPick.onDidChangeValue((value: string) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      const query = value.trim()
      quickPick.busy = true
      debounceTimer = setTimeout(async () => {
        try {
          const { results } = await skillService.search(query)
          if (results.length === 0) {
            quickPick.items = [
              {
                label: '$(info) No skills found',
                description: query ? `No results for "${query}"` : 'Type to search',
                alwaysShow: true,
                skill: null,
              },
            ]
          } else {
            quickPick.items = results.map((skill) => createQuickPickItem(skill))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          quickPick.items = [
            {
              label: '$(error) Search failed',
              description: message,
              alwaysShow: true,
              skill: null,
            },
          ]
        } finally {
          quickPick.busy = false
        }
      }, SEARCH_DEBOUNCE_MS)
    })

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0]
      if (!selected || !selected.skill) {
        return
      }
      accepted = true
      const picked = selected.skill
      quickPick.hide()
      resolve(picked)
    })

    quickPick.onDidHide(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      quickPick.dispose()
      if (!accepted) {
        resolve(undefined)
      }
    })

    quickPick.show()
  })
}

/**
 * Picks the second skill, re-opening the picker if the user selects the same
 * skill as the first (self-compare guard).
 */
async function pickSecondSkill(
  skillService: SkillService,
  first: SkillData
): Promise<SkillData | undefined> {
  const title = `Compare skills (2 of 2) — compare with "${first.name}"`
  for (;;) {
    const second = await pickSkill(skillService, title)
    if (!second) {
      return undefined
    }
    if (second.id === first.id) {
      void vscode.window.showWarningMessage('Pick two different skills to compare.')
      continue
    }
    return second
  }
}

async function compareCommandImpl(deps: {
  skillService: SkillService
  context: vscode.ExtensionContext
}): Promise<void> {
  track('vscode_compare_start')

  const first = await pickSkill(deps.skillService, 'Compare skills (1 of 2)')
  if (!first) {
    return
  }

  const second = await pickSecondSkill(deps.skillService, first)
  if (!second) {
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
    const response = await client.skillCompare({ skill_a: first.id, skill_b: second.id })
    CompareSkillsPanel.createOrShow(deps.context.extensionUri, response)
    track('vscode_compare_complete')
  } catch (err) {
    if (err instanceof McpToolError) {
      if (err.code === 'TierDenied') {
        await handleTierDenied('skillsmith.compareSkills', err)
        return
      }
      void vscode.window.showErrorMessage(err.message)
      return
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    void vscode.window.showErrorMessage(`Could not compare skills: ${message}`)
  }
}

export const compareCommandAction = withTelemetry(compareCommandImpl, {
  source: 'vscode-extension',
  extractSkillId: () => 'compare',
})

/**
 * Registers the Compare Skills command (`skillsmith.compareSkills`).
 */
export function registerCompareCommand(
  context: vscode.ExtensionContext,
  skillService: SkillService
): void {
  const command = vscode.commands.registerCommand('skillsmith.compareSkills', () =>
    compareCommandAction({ skillService, context })
  )
  context.subscriptions.push(command)
}
