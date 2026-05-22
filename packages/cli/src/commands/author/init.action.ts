/**
 * @fileoverview `skillsmith author init|validate|publish` command factories +
 *   withTelemetry-wrapped action handlers.
 * @module @skillsmith/cli/commands/author/init.action
 * @see SMI-5129 — sibling-split of init.ts so the 3 author handlers can be
 *   wrapped without init.ts exceeding the 500-LOC gate. Mirrors the
 *   sync.action.ts / telemetry.action.ts convention (SMI-5127/SMI-5128): the
 *   business logic (initSkill/validateSkill/publishSkill) stays in init.ts;
 *   the commander factories + wrapped actions live here. One-way import
 *   (init.action → init), so no import cycle.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'

import { sanitizeError } from '../../utils/sanitize.js'
import { InitSkillError } from '../../utils/errors.js'
import { initSkill, validateSkill, publishSkill } from './init.js'

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function initActionImpl(
  name: string | undefined,
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const targetPath = (opts['path'] as string) || '.'

  try {
    await initSkill(name, targetPath, {
      description: opts['description'] as string | undefined,
      author: opts['author'] as string | undefined,
      category: opts['category'] as string | undefined,
      yes: opts['yes'] as boolean | undefined,
    })
  } catch (error) {
    // SMI-4314: typed InitSkillError → user-facing message is already
    // composed (and chalk-styled); print it verbatim and exit with the
    // requested code. Anything else is an unexpected bug — route
    // through sanitizeError with the generic prefix.
    if (error instanceof InitSkillError) {
      console.error(error.message)
      process.exit(error.exitCode)
    }
    console.error(chalk.red('Error initializing skill:'), sanitizeError(error))
    process.exit(1)
  }
}

export const initAction = withTelemetry(initActionImpl, {
  source: 'cli',
  extractSkillId: () => 'author init',
  extractFramework: () => 'cli',
})

/**
 * Create init command
 * SMI-1473: Added non-interactive flags for E2E testing
 */
export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize a new skill directory')
    .argument('[name]', 'Skill name')
    .option('-p, --path <path>', 'Target directory', '.')
    .option('-d, --description <description>', 'Skill description (non-interactive)')
    .option('-a, --author <author>', 'Skill author (non-interactive)')
    .option(
      '-c, --category <category>',
      'Skill category: development|productivity|communication|data|security|other (non-interactive)'
    )
    .option('-y, --yes', 'Auto-confirm overwrite (non-interactive)')
    .action(initAction)
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

async function validateActionImpl(skillPath: string): Promise<void> {
  try {
    const valid = await validateSkill(skillPath)
    process.exit(valid ? 0 : 1)
  } catch (error) {
    console.error(chalk.red('Error validating skill:'), sanitizeError(error))
    process.exit(1)
  }
}

export const validateAction = withTelemetry(validateActionImpl, {
  source: 'cli',
  extractSkillId: () => 'author validate',
  extractFramework: () => 'cli',
})

/**
 * Create validate command
 */
export function createValidateCommand(): Command {
  return new Command('validate')
    .description('Validate a local SKILL.md file')
    .argument('[path]', 'Path to SKILL.md or skill directory', '.')
    .action(validateAction)
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function publishActionImpl(
  skillPath: string,
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  try {
    const referencePatterns = opts['referencePatterns']
      ? String(opts['referencePatterns'])
          .split(',')
          .map((p) => p.trim())
      : undefined
    // SMI-2444: Use conditional spread to satisfy exactOptionalPropertyTypes
    const success = await publishSkill(skillPath, {
      ...(opts['checkReferences'] !== undefined && {
        checkReferences: opts['checkReferences'] as boolean,
      }),
      ...(referencePatterns !== undefined && { referencePatterns }),
    })
    process.exit(success ? 0 : 1)
  } catch (error) {
    console.error(chalk.red('Error publishing skill:'), sanitizeError(error))
    process.exit(1)
  }
}

export const publishAction = withTelemetry(publishActionImpl, {
  source: 'cli',
  extractSkillId: () => 'author publish',
  extractFramework: () => 'cli',
})

/**
 * Create publish command
 */
export function createPublishCommand(): Command {
  return new Command('publish')
    .description('Prepare skill for sharing')
    .argument('[path]', 'Path to skill directory', '.')
    .option('--check-references', 'Scan for project-specific references before publishing')
    .option(
      '--reference-patterns <patterns>',
      'Additional regex patterns to check (comma-separated)'
    )
    .action(publishAction)
}
