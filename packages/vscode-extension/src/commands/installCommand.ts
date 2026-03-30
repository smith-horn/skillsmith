/**
 * Quick Install Command - Enhanced skill installation with inline search
 * Implements SMI-749: Quick Install Command
 * Uses SkillService for centralized MCP-first + mock fallback.
 *
 * @module commands/installCommand
 */
import * as vscode from 'vscode'
import { isValidSkillId } from '../utils/security.js'
import type { SkillData } from '../types/skill.js'
import type { SkillService } from '../services/SkillService.js'
import { getSkillPath, installSkillLocally } from '../services/installUtils.js'
import { getMcpClient } from '../mcp/McpClient.js'

/** Debounce delay for search input */
const SEARCH_DEBOUNCE_MS = 300

/**
 * Quick pick item with skill data
 */
interface SkillQuickPickItem extends vscode.QuickPickItem {
  skill: SkillData | null
}

/**
 * Registers the quick install command
 */
export function registerQuickInstallCommand(
  context: vscode.ExtensionContext,
  skillService: SkillService
): void {
  const command = vscode.commands.registerCommand('skillsmith.installSkill', async () => {
    await showQuickInstallPicker(skillService)
  })

  context.subscriptions.push(command)
}

/**
 * Shows the quick install picker with integrated search
 */
async function showQuickInstallPicker(skillService: SkillService): Promise<void> {
  const quickPick = vscode.window.createQuickPick<SkillQuickPickItem>()

  quickPick.title = 'Install Skill'
  quickPick.placeholder = 'Search for skills to install (or browse by selecting filters)'
  quickPick.matchOnDescription = true
  quickPick.matchOnDetail = true

  // Track debounce timer
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  // Handle value changes with debouncing
  quickPick.onDidChangeValue((value: string) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    const query = value.trim()

    quickPick.busy = true

    debounceTimer = setTimeout(async () => {
      try {
        const { results, isOffline } = await skillService.search(query)

        if (results.length === 0) {
          if (isOffline) {
            quickPick.items = [
              {
                label: '$(cloud-offline) No offline results',
                description: 'Connect to Skillsmith for full search',
                alwaysShow: true,
                skill: null,
              },
            ]
          } else {
            quickPick.items = [
              {
                label: '$(info) No skills found',
                description: query ? `No results for "${query}"` : 'No skills available',
                alwaysShow: true,
                skill: null,
              },
            ]
          }
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

  // Handle selection
  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0]

    if (!selected || !selected.skill) {
      return
    }

    quickPick.hide()

    await installSkillWithProgress(selected.skill)
  })

  // Handle hide (cleanup)
  quickPick.onDidHide(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    quickPick.dispose()
  })

  quickPick.show()
}

/**
 * Creates a quick pick item from skill data
 */
function createQuickPickItem(skill: SkillData): SkillQuickPickItem {
  const trustIcon = getTrustTierIcon(skill.trustTier)

  return {
    label: `${trustIcon} ${skill.name}`,
    description: `by ${skill.author} | ${skill.trustTier}`,
    detail: skill.description,
    skill,
  }
}

/**
 * Gets the icon for a trust tier
 */
function getTrustTierIcon(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'verified':
      return '$(verified-filled)'
    case 'community':
      return '$(star-full)'
    case 'standard':
      return '$(circle-filled)'
    default:
      return '$(question)'
  }
}

/**
 * Installs a skill with progress notification
 */
async function installSkillWithProgress(skill: SkillData): Promise<void> {
  if (!isValidSkillId(skill.id)) {
    vscode.window.showErrorMessage(
      `Invalid skill ID "${skill.id}". Skill IDs must contain only letters, numbers, hyphens, and underscores.`
    )
    return
  }

  const confirm = await vscode.window.showInformationMessage(
    `Install "${skill.name}" skill?`,
    {
      modal: true,
      detail: `This will install the skill to ~/.claude/skills/${skill.id}`,
    },
    'Install'
  )

  if (confirm !== 'Install') {
    return
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing ${skill.name}...`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ increment: 0, message: 'Preparing installation...' })

      try {
        const result = await performInstall(skill)

        progress.report({ increment: 100, message: 'Complete!' })

        if (result.success) {
          await showInstallSuccess(skill, result)
        } else {
          throw new Error(result.error || 'Installation failed')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        vscode.window.showErrorMessage(`Installation failed: ${message}`)
      }
    }
  )
}

/** Install result interface */
interface InstallResult {
  success: boolean
  installPath: string
  tips: string[] | undefined
  error: string | undefined
}

/**
 * Performs skill installation using MCP with fallback to local.
 * Shows warning when falling back to local placeholder install.
 */
async function performInstall(skill: SkillData): Promise<InstallResult> {
  const client = getMcpClient()

  // Try MCP client first if connected
  if (client.isConnected()) {
    try {
      const result = await client.installSkill(skill.id)

      if (result.success) {
        return {
          success: true,
          installPath: result.installPath,
          tips: result.tips,
          error: undefined,
        }
      } else {
        return {
          success: false,
          installPath: result.installPath || '',
          tips: undefined,
          error: result.error,
        }
      }
    } catch (error) {
      console.warn('[Skillsmith] MCP install failed, falling back to local:', error)
    }
  }

  // Warn user about placeholder install
  const proceedLocally = await vscode.window.showWarningMessage(
    'MCP server unavailable -- install a placeholder skill?',
    { detail: 'Reinstall when connected for the full skill content.', modal: true },
    'Install Placeholder'
  )
  if (proceedLocally !== 'Install Placeholder') {
    return { success: false, installPath: '', tips: undefined, error: 'Installation cancelled' }
  }

  // Fallback to local installation
  console.log('[Skillsmith] Using local installation for skill:', skill.id)

  try {
    await installSkillLocally(skill)
    const installPath = getSkillPath(skill.id)

    return {
      success: true,
      installPath,
      tips: [
        `Skill "${skill.name}" installed successfully!`,
        'To use this skill, mention it in your AI assistant.',
        'View installed skills: ls ~/.claude/skills/',
      ],
      error: undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      installPath: '',
      tips: undefined,
      error: message,
    }
  }
}

/**
 * Shows success message with actions after installation
 */
async function showInstallSuccess(skill: SkillData, result: InstallResult): Promise<void> {
  const tips = result.tips?.join('\n') || ''
  const message = `Successfully installed "${skill.name}"!${tips ? '\n\n' + tips : ''}`

  const action = await vscode.window.showInformationMessage(
    message,
    'View Skill',
    'Open Folder',
    'Reload Window'
  )

  switch (action) {
    case 'View Skill':
      await vscode.commands.executeCommand('skillsmith.viewSkillDetails', skill.id)
      break
    case 'Open Folder':
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.installPath))
      break
    case 'Reload Window':
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
      break
  }

  await vscode.commands.executeCommand('skillsmith.refreshSkills')
}
