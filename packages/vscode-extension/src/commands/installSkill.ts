/**
 * Install skill command implementation
 */
import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillSearchProvider } from '../providers/SkillSearchProvider.js'
import { isValidSkillId } from '../utils/security.js'
import { type SkillData } from '../data/mockSkills.js'
import { getMcpClient } from '../mcp/McpClient.js'

export function registerInstallCommand(
  context: vscode.ExtensionContext,
  searchProvider: SkillSearchProvider
): void {
  const installCommand = vscode.commands.registerCommand(
    'skillsmith.installSkill',
    async (item?: SkillData) => {
      // If called from context menu, item is provided
      // If called from command palette, show quick pick
      let skill: SkillData | undefined = item

      if (!skill) {
        const results = searchProvider.getResults()
        if (results.length === 0) {
          const result = await vscode.window.showWarningMessage(
            'No search results. Would you like to search for skills first?',
            'Search Skills'
          )
          if (result === 'Search Skills') {
            await vscode.commands.executeCommand('skillsmith.searchSkills')
          }
          return
        }

        // Show quick pick for skill selection
        const selected = await vscode.window.showQuickPick(
          results.map((s) => ({
            label: s.name,
            description: `by ${s.author}`,
            detail: s.description,
            skill: s,
          })),
          {
            placeHolder: 'Select a skill to install',
            title: 'Install Skill',
          }
        )

        if (!selected) {
          return
        }

        skill = selected.skill
      }

      // At this point skill must be defined (either passed in or selected)
      const skillToInstall = skill as SkillData

      // Validate skill ID to prevent path traversal
      if (!isValidSkillId(skillToInstall.id)) {
        vscode.window.showErrorMessage(
          `Invalid skill ID "${skillToInstall.id}". Skill IDs must contain only letters, numbers, hyphens, and underscores.`
        )
        return
      }

      // Confirm installation
      const confirm = await vscode.window.showInformationMessage(
        `Install "${skillToInstall.name}" skill?`,
        {
          modal: true,
          detail: `This will install the skill to ~/.claude/skills/${skillToInstall.id}`,
        },
        'Install'
      )

      if (confirm !== 'Install') {
        return
      }

      // Install the skill
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Installing ${skillToInstall.name}...`,
          cancellable: false,
        },
        async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
          progress.report({ increment: 0 })

          try {
            // Try MCP installation first
            const installResult = await performInstall(skillToInstall)

            progress.report({ increment: 100 })

            // Show result message
            if (installResult.success) {
              const tips = installResult.tips?.join('\n') || ''
              const action = await vscode.window.showInformationMessage(
                `Successfully installed "${skillToInstall.name}"!${tips ? '\n\n' + tips : ''}`,
                'View Skill',
                'Open Folder'
              )

              if (action === 'View Skill') {
                await vscode.commands.executeCommand(
                  'skillsmith.viewSkillDetails',
                  skillToInstall.id
                )
              } else if (action === 'Open Folder') {
                const skillPath = installResult.installPath || getSkillPath(skillToInstall.id)
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skillPath))
              }

              // Refresh the installed skills view
              await vscode.commands.executeCommand('skillsmith.refreshSkills')
            } else {
              throw new Error(installResult.error || 'Installation failed')
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            vscode.window.showErrorMessage(`Installation failed: ${message}`)
          }
        }
      )
    }
  )

  context.subscriptions.push(installCommand)
}

/**
 * Install result from either MCP or local installation
 */
interface InstallResult {
  success: boolean
  installPath: string
  tips: string[] | undefined
  error: string | undefined
}

/**
 * Perform skill installation using MCP with fallback to local
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
        // MCP reported failure, return it
        return {
          success: false,
          installPath: result.installPath || '',
          tips: undefined,
          error: result.error,
        }
      }
    } catch (error) {
      console.warn('[Skillsmith] MCP install failed, falling back to local:', error)
      // Fall through to local installation
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
        `To use this skill, mention it in your AI assistant.`,
        `View installed skills: ls ~/.claude/skills/`,
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

function getSkillsDirectory(): string {
  const config = vscode.workspace.getConfiguration('skillsmith')
  let skillsDir = config.get<string>('skillsDirectory') || '~/.claude/skills'

  if (skillsDir.startsWith('~')) {
    skillsDir = path.join(os.homedir(), skillsDir.slice(1))
  }

  return skillsDir
}

function getSkillPath(skillId: string): string {
  // Additional safety: use path.basename to strip any directory components
  const safeId = path.basename(skillId)
  const skillPath = path.join(getSkillsDirectory(), safeId)

  // Verify the resolved path is still within the skills directory
  const skillsDir = getSkillsDirectory()
  const resolvedPath = path.resolve(skillPath)
  const resolvedSkillsDir = path.resolve(skillsDir)

  if (!resolvedPath.startsWith(resolvedSkillsDir + path.sep)) {
    throw new Error('Invalid skill path: path traversal detected')
  }

  return skillPath
}

/**
 * Install skill locally (fallback when MCP is not available)
 */
async function installSkillLocally(skill: SkillData): Promise<void> {
  const skillsDir = getSkillsDirectory()
  const skillPath = getSkillPath(skill.id)

  // Ensure skills directory exists
  await fs.mkdir(skillsDir, { recursive: true })

  // Check if skill already exists
  try {
    await fs.access(skillPath)
    // Skill exists, ask to overwrite
    const overwrite = await vscode.window.showWarningMessage(
      `Skill "${skill.name}" is already installed. Overwrite?`,
      { modal: true },
      'Overwrite'
    )
    if (overwrite !== 'Overwrite') {
      throw new Error('Installation cancelled')
    }
    // Remove existing skill
    await fs.rm(skillPath, { recursive: true })
  } catch (error) {
    // Skill doesn't exist or user cancelled
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

  // Create SKILL.md with basic template
  const skillMd = generateSkillMd(skill)
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), skillMd)

  // Create skills subdirectory structure
  const skillsSubdir = path.join(skillPath, 'skills', skill.id)
  await fs.mkdir(skillsSubdir, { recursive: true })

  // Create a copy of SKILL.md in the nested structure
  await fs.writeFile(path.join(skillsSubdir, 'SKILL.md'), skillMd)

  // Simulate download delay for MVP
  await new Promise((resolve) => setTimeout(resolve, 500))
}

function generateSkillMd(skill: SkillData): string {
  const trustBadge = getTrustBadge(skill.trustTier)

  return `# ${skill.name}

${trustBadge}

${skill.description}

## Overview

- **Author:** ${skill.author}
- **Category:** ${skill.category}
- **Trust Tier:** ${skill.trustTier}
- **Score:** ${skill.score}/100

## Usage

This skill can be triggered when relevant context is detected.

### Trigger Phrases

Add your trigger phrases here based on the skill's functionality.

## Installation

This skill was installed via the Skillsmith VS Code extension.

${skill.repository ? `## Repository\n\n[${skill.repository}](${skill.repository})` : ''}

## License

See repository for license information.
`
}

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
