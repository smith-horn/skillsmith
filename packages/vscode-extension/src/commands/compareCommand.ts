/**
 * Compare Skills command (SMI-5315 / #1456).
 *
 * Two sequential debounced QuickPick searches pick exactly two skills, then
 * `skill_compare` runs and the result opens in CompareSkillsPanel. Mirrors
 * installCommand's debounced `createQuickPick` search pattern + the
 * withTelemetry export/register shape.
 *
 * SMI-5340 adds two tree-context commands:
 *   - `skillsmith.selectForCompare`   — sets the compare source on a SkillTreeItem
 *   - `skillsmith.compareWithSelected` — completes the comparison against the source
 *
 * @module commands/compareCommand
 */
import * as vscode from 'vscode'
import type { SkillData } from '../types/skill.js'
import type { SkillService } from '../services/SkillService.js'
import { SkillTreeItem } from '../sidebar/SkillTreeItem.js'
import { getTrustTierCodicon, getTrustTierLabel } from '../sidebar/trustTier.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { McpToolError } from '../mcp/McpToolError.js'
import { handleTierDenied } from '../mcp/tierDenied.js'
import { withTelemetry } from '../services/telemetry-wrap.js'
import { track } from '../services/Telemetry.js'
import { CompareSkillsPanel } from '../views/CompareSkillsPanel.js'
import { getCompareSource, setCompareSource, clearCompareSource } from './compare-source.js'

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

/** Shared deps passed to `runComparison`. */
interface ComparisonDeps {
  skillService: SkillService
  context: vscode.ExtensionContext
}

/**
 * Core compare logic: calls `skill_compare` on the MCP client and opens
 * `CompareSkillsPanel`. Extracted so both the QuickPick palette flow and the
 * tree-context "Compare with Selected" flow share a single implementation.
 *
 * Handles: not-connected, TierDenied, SkillNotFound, and generic errors.
 * Emits `vscode_compare_complete` on success only; callers emit
 * `vscode_compare_start`. Returns `true` on success, `false` on any handled
 * failure (so callers can decide whether to preserve a selected source).
 */
export async function runComparison(
  skillAId: string,
  skillBId: string,
  deps: ComparisonDeps
): Promise<boolean> {
  const client = getMcpClient()
  if (!client.isConnected()) {
    void vscode.window.showInformationMessage(
      'Skillsmith server is not connected. Start the MCP server and try again.'
    )
    return false
  }

  try {
    const response = await client.skillCompare({ skill_a: skillAId, skill_b: skillBId })
    CompareSkillsPanel.createOrShow(deps.context.extensionUri, response, skillAId, skillBId)
    track('vscode_compare_complete')
    return true
  } catch (err) {
    if (err instanceof McpToolError) {
      if (err.code === 'TierDenied') {
        await handleTierDenied('skillsmith.compareSkills', err)
        return false
      }
      if (err.code === 'SkillNotFound') {
        void vscode.window.showWarningMessage(
          'One or both skills could not be found. Check the skill IDs and try again.'
        )
        return false
      }
      void vscode.window.showErrorMessage(err.message)
      return false
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    void vscode.window.showErrorMessage(`Could not compare skills: ${message}`)
    return false
  }
}

async function compareCommandImpl(deps: ComparisonDeps): Promise<void> {
  track('vscode_compare_start')

  const first = await pickSkill(deps.skillService, 'Compare skills (1 of 2)')
  if (!first) {
    return
  }

  const second = await pickSecondSkill(deps.skillService, first)
  if (!second) {
    return
  }

  await runComparison(first.id, second.id, deps)
}

// ── Tree-context: Select for Compare (SMI-5340) ───────────────────────────────

async function selectForCompareImpl(_deps: ComparisonDeps, arg?: SkillTreeItem): Promise<void> {
  if (!arg?.skillData) {
    return
  }
  setCompareSource(arg.skillData.id)
  void vscode.window.showInformationMessage(
    `Selected "${arg.skillData.name}" for compare — pick a second skill.`
  )
}

// ── Tree-context: Compare with Selected (SMI-5340) ───────────────────────────

async function compareWithSelectedImpl(deps: ComparisonDeps, arg?: SkillTreeItem): Promise<void> {
  if (!arg?.skillData) {
    return
  }

  const sourceId = getCompareSource()
  if (!sourceId) {
    void vscode.window.showWarningMessage(
      'No skill selected for compare. Right-click a skill and choose "Select for Compare" first.'
    )
    return
  }

  const targetId = arg.skillData.id
  if (sourceId === targetId) {
    void vscode.window.showWarningMessage('Pick two different skills to compare.')
    return
  }

  // Re-validate the source is still resolvable in the registry (compare is a
  // registry operation; a source that 404s there can't be compared).
  try {
    await deps.skillService.getSkill(sourceId)
  } catch {
    void vscode.window.showWarningMessage(
      'The first skill is no longer available. Please select it again.'
    )
    clearCompareSource()
    return
  }

  track('vscode_compare_start')
  const succeeded = await runComparison(sourceId, targetId, deps)
  // Drop the selected source only on success — on a transient failure (e.g. MCP
  // disconnected) keep it so the retry is a single click.
  if (succeeded) {
    clearCompareSource()
  }
}

export const compareCommandAction = withTelemetry(compareCommandImpl, {
  source: 'vscode-extension',
  extractSkillId: () => 'compare',
})

export const selectForCompareAction = withTelemetry(
  (deps: ComparisonDeps, arg?: SkillTreeItem) => selectForCompareImpl(deps, arg),
  {
    source: 'vscode-extension',
    extractSkillId: () => 'selectForCompare',
  }
)

export const compareWithSelectedAction = withTelemetry(
  (deps: ComparisonDeps, arg?: SkillTreeItem) => compareWithSelectedImpl(deps, arg),
  {
    source: 'vscode-extension',
    extractSkillId: () => 'compareWithSelected',
  }
)

/**
 * Registers the Compare Skills command (`skillsmith.compareSkills`) and the two
 * tree-context compare commands added by SMI-5340.
 */
export function registerCompareCommand(
  context: vscode.ExtensionContext,
  skillService: SkillService
): void {
  const deps: ComparisonDeps = { skillService, context }

  context.subscriptions.push(
    vscode.commands.registerCommand('skillsmith.compareSkills', () => compareCommandAction(deps)),
    vscode.commands.registerCommand('skillsmith.selectForCompare', (arg?: SkillTreeItem) =>
      selectForCompareAction(deps, arg)
    ),
    vscode.commands.registerCommand('skillsmith.compareWithSelected', (arg?: SkillTreeItem) =>
      compareWithSelectedAction(deps, arg)
    )
  )
}
