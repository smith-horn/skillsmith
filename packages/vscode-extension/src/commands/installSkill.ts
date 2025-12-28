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

      // Validate skill ID to prevent path traversal
      if (!isValidSkillId(skill.id)) {
        vscode.window.showErrorMessage(
          `Invalid skill ID "${skill.id}". Skill IDs must contain only letters, numbers, hyphens, and underscores.`
        )
        return
      }

      // Confirm installation
      const confirm = await vscode.window.showInformationMessage(
        `Install "${skill.name}" skill?`,
        { modal: true, detail: `This will install the skill to ~/.claude/skills/${skill.id}` },
        'Install'
      )

      if (confirm !== 'Install') {
        return
      }

      // Install the skill
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Installing ${skill.name}...`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0 })

          try {
            await installSkill(skill)
            progress.report({ increment: 100 })

            const action = await vscode.window.showInformationMessage(
              `Successfully installed "${skill.name}"!`,
              'View Skill',
              'Open Folder'
            )

            if (action === 'View Skill') {
              await vscode.commands.executeCommand('skillsmith.viewSkillDetails', skill.id)
            } else if (action === 'Open Folder') {
              const skillPath = getSkillPath(skill.id)
              await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skillPath))
            }

            // Refresh the installed skills view
            await vscode.commands.executeCommand('skillsmith.refreshSkills')
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

async function installSkill(skill: SkillData): Promise<void> {
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

This skill can be triggered by Claude Code when relevant context is detected.

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
