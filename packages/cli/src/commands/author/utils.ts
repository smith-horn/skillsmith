/**
 * SMI-1487: Shared utilities for author commands
 *
 * Common helper functions used across multiple author subcommands.
 */

import chalk from 'chalk'
import { access } from 'fs/promises'
import { mkdir } from 'fs/promises'
import { resolve } from 'path'
import { homedir } from 'os'
import type { ValidationResult } from '@skillsmith/core'
import { resolveCompanionAgentDir, type ClientId } from '@skillsmith/core/install'

/**
 * Pretty print validation errors and warnings
 */
export function printValidationResult(result: ValidationResult, filePath: string): void {
  console.log(chalk.bold(`\nValidation Result for ${filePath}:\n`))

  if (result.valid) {
    console.log(chalk.green.bold('  VALID'))
  } else {
    console.log(chalk.red.bold('  INVALID'))
  }

  if (result.errors.length > 0) {
    console.log(chalk.red.bold('\nErrors:'))
    for (const error of result.errors) {
      console.log(chalk.red(`  - ${error}`))
    }
  }

  if (result.warnings.length > 0) {
    console.log(chalk.yellow.bold('\nWarnings:'))
    for (const warning of result.warnings) {
      console.log(chalk.yellow(`  - ${warning}`))
    }
  }

  console.log()
}

/**
 * Check if file exists
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Ensure the companion-subagent output directory exists and return it.
 *
 * `customPath` (`--output`) always wins when supplied — an explicit override
 * stays supported. Otherwise resolves per `client` via
 * `resolveCompanionAgentDir()` (SMI-5980 Wave 3) — for `client` omitted or
 * `'claude-code'` this is `~/.claude/agents/`, unchanged from the prior
 * hardcoded default.
 */
export async function ensureAgentsDirectory(
  customPath?: string,
  client?: ClientId
): Promise<string> {
  const agentsDir = customPath
    ? resolve(customPath.replace(/^~/, homedir()))
    : resolveCompanionAgentDir(client)

  await mkdir(agentsDir, { recursive: true })
  return agentsDir
}

/**
 * SMI-1389: Extract trigger phrases from skill description
 */
export function extractTriggerPhrases(description: string): string[] {
  const phrases: string[] = []

  // Pattern: "Use when [phrases]" or "when the user asks to [phrases]"
  const patterns = [
    /use when (?:the user asks to )?["']([^"']+)["']/gi,
    /when (?:the user asks to )?["']([^"']+)["']/gi,
    /trigger(?:ed)? (?:by|when|phrases?)[\s:]+["']([^"']+)["']/gi,
    /invoke when (?:the user )?["']([^"']+)["']/gi,
  ]

  for (const pattern of patterns) {
    const matches = description.matchAll(pattern)
    for (const match of matches) {
      if (match[1]) {
        phrases.push(match[1])
      }
    }
  }

  return phrases
}

/**
 * SMI-1389: Validate subagent definition structure
 */
export function validateSubagentDefinition(content: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Check for YAML frontmatter
  if (!content.trim().startsWith('---')) {
    errors.push('Missing YAML frontmatter')
  }

  // Extract and validate frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1] || ''

    const requiredFields = ['name', 'description', 'skills', 'tools', 'model']
    for (const field of requiredFields) {
      if (!frontmatter.includes(`${field}:`)) {
        errors.push(`Missing required field: ${field}`)
      }
    }
  } else {
    errors.push('Could not parse YAML frontmatter')
  }

  // Check for operating protocol section
  if (!content.includes('## Operating Protocol')) {
    warnings.push('Missing Operating Protocol section')
  }

  // Check for output format section
  if (!content.includes('## Output Format')) {
    warnings.push('Missing Output Format section')
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
