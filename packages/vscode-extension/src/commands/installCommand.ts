/**
 * Quick Install Command - Enhanced skill installation with inline search
 * Implements SMI-749: Quick Install Command
 *
 * @module commands/installCommand
 */
import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { isValidSkillId } from '../utils/security.js'
import { searchSkills as searchMockSkills, type SkillData } from '../data/mockSkills.js'
import { getMcpClient } from '../mcp/McpClient.js'

/** Minimum query length for search */
const MIN_QUERY_LENGTH = 2

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
export function registerQuickInstallCommand(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('skillsmith.installSkill', async () => {
    await showQuickInstallPicker()
  })

  context.subscriptions.push(command)
}

/**
 * Shows the quick install picker with integrated search
 */
async function showQuickInstallPicker(): Promise<void> {
  const quickPick = vscode.window.createQuickPick<SkillQuickPickItem>()

  quickPick.title = 'Install Skill'
  quickPick.placeholder = 'Search for skills to install (type at least 2 characters)'
  quickPick.matchOnDescription = true
  quickPick.matchOnDetail = true

  // Track debounce timer
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  // Handle value changes with debouncing
  quickPick.onDidChangeValue((value: string) => {
    // Clear previous timer
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    const query = value.trim()

    if (query.length < MIN_QUERY_LENGTH) {
      quickPick.items = []
      quickPick.busy = false
      return
    }

    // Show loading state
    quickPick.busy = true

    // Debounce search
    debounceTimer = setTimeout(async () => {
      try {
        const results = await performSearch(query)

        if (results.length === 0) {
          quickPick.items = [
            {
              label: '$(info) No skills found',
              description: `No results for "${query}"`,
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

  // Handle selection
  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0]

    if (!selected || !selected.skill) {
      return
    }

    quickPick.hide()

    // Install the selected skill
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
 * Performs skill search using MCP with fallback to mock data
 */
async function performSearch(query: string): Promise<SkillData[]> {
  const client = getMcpClient()

  // Try MCP client first if connected
  if (client.isConnected()) {
    try {
      const response = await client.search(query)

      return response.results.map((result) => ({
        id: result.id,
        name: result.name,
        description: result.description,
        author: result.author,
        category: result.category,
        trustTier: result.trustTier,
        score: result.score,
      }))
    } catch (error) {
      console.warn('[Skillsmith] MCP search failed, falling back to mock data:', error)
    }
  }

  // Fallback to mock data
  console.log('[Skillsmith] Using mock data for search')
  await new Promise((resolve) => setTimeout(resolve, 50))
  return searchMockSkills(query)
}

/**
 * Installs a skill with progress notification
 */
async function installSkillWithProgress(skill: SkillData): Promise<void> {
  // Validate skill ID
  if (!isValidSkillId(skill.id)) {
    vscode.window.showErrorMessage(
      `Invalid skill ID "${skill.id}". Skill IDs must contain only letters, numbers, hyphens, and underscores.`
    )
    return
  }

  // Confirm installation
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
    async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
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

/**
 * Install result interface
 */
interface InstallResult {
  success: boolean
  installPath: string
  tips: string[] | undefined
  error: string | undefined
}

/**
 * Performs skill installation using MCP with fallback to local
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
        'To use this skill, mention it in Claude Code.',
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

  // Refresh the installed skills view
  await vscode.commands.executeCommand('skillsmith.refreshSkills')
}

/**
 * Gets the skills directory path
 */
function getSkillsDirectory(): string {
  const config = vscode.workspace.getConfiguration('skillsmith')
  let skillsDir = config.get<string>('skillsDirectory') || '~/.claude/skills'

  if (skillsDir.startsWith('~')) {
    skillsDir = path.join(os.homedir(), skillsDir.slice(1))
  }

  return skillsDir
}

/**
 * Gets the full path for a skill
 */
function getSkillPath(skillId: string): string {
  const safeId = path.basename(skillId)
  const skillPath = path.join(getSkillsDirectory(), safeId)

  // Verify path is within skills directory
  const skillsDir = getSkillsDirectory()
  const resolvedPath = path.resolve(skillPath)
  const resolvedSkillsDir = path.resolve(skillsDir)

  if (!resolvedPath.startsWith(resolvedSkillsDir + path.sep)) {
    throw new Error('Invalid skill path: path traversal detected')
  }

  return skillPath
}

/**
 * Installs skill locally (fallback when MCP is not available)
 */
async function installSkillLocally(skill: SkillData): Promise<void> {
  const skillsDir = getSkillsDirectory()
  const skillPath = getSkillPath(skill.id)

  // Ensure skills directory exists
  await fs.mkdir(skillsDir, { recursive: true })

  // Check if skill already exists
  try {
    await fs.access(skillPath)
    const overwrite = await vscode.window.showWarningMessage(
      `Skill "${skill.name}" is already installed. Overwrite?`,
      { modal: true },
      'Overwrite'
    )
    if (overwrite !== 'Overwrite') {
      throw new Error('Installation cancelled')
    }
    await fs.rm(skillPath, { recursive: true })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT' && err.message !== 'Installation cancelled') {
      throw error
    }
    if (err.message === 'Installation cancelled') {
      throw error
    }
  }

  // Create skill directory
  await fs.mkdir(skillPath, { recursive: true })

  // Create SKILL.md
  const skillMd = generateSkillMd(skill)
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), skillMd)

  // Create nested structure
  const skillsSubdir = path.join(skillPath, 'skills', skill.id)
  await fs.mkdir(skillsSubdir, { recursive: true })
  await fs.writeFile(path.join(skillsSubdir, 'SKILL.md'), skillMd)

  // Simulate installation delay
  await new Promise((resolve) => setTimeout(resolve, 300))
}

/**
 * Generates SKILL.md content for a skill
 */
function generateSkillMd(skill: SkillData): string {
  const trustBadge = getTrustBadge(skill.trustTier)

  return `---
name: "${skill.name}"
description: "${skill.description}"
author: "${skill.author}"
category: "${skill.category}"
---

# ${skill.name}

${trustBadge}

${skill.description}

## What This Skill Does

- **Author:** ${skill.author}
- **Category:** ${skill.category}
- **Trust Tier:** ${skill.trustTier}
- **Score:** ${skill.score}/100

## Quick Start

This skill can be triggered by Claude Code when relevant context is detected.

## Trigger Phrases

Add your trigger phrases here based on the skill's functionality.

## Installation

This skill was installed via the Skillsmith VS Code extension.

${skill.repository ? `## Repository\n\n[${skill.repository}](${skill.repository})` : ''}

## License

See repository for license information.
`
}

/**
 * Gets the trust badge for a tier
 */
function getTrustBadge(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'verified':
      return '![Verified](https://img.shields.io/badge/Trust-Verified-green)'
    case 'community':
      return '![Community](https://img.shields.io/badge/Trust-Community-yellow)'
    case 'standard':
      return '![Standard](https://img.shields.io/badge/Trust-Standard-blue)'
    default:
      return '![Unverified](https://img.shields.io/badge/Trust-Unverified-gray)'
  }
}
