/**
 * Shared install utility functions for skill installation.
 * Extracted from installCommand.ts to keep file sizes manageable.
 */
import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { SkillData } from '../types/skill.js'

/**
 * Gets the skills directory path from settings
 */
export function getSkillsDirectory(): string {
  const config = vscode.workspace.getConfiguration('skillsmith')
  let skillsDir = config.get<string>('skillsDirectory') || '~/.claude/skills'

  if (skillsDir.startsWith('~')) {
    skillsDir = path.join(os.homedir(), skillsDir.slice(1))
  }

  return skillsDir
}

/**
 * Gets the full path for a skill, with path traversal protection
 */
export function getSkillPath(skillId: string): string {
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
export async function installSkillLocally(skill: SkillData): Promise<void> {
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
export function generateSkillMd(skill: SkillData): string {
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

This skill can be triggered when relevant context is detected.

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
export function getTrustBadge(tier: string): string {
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
