#!/usr/bin/env node
/**
 * Skillsmith CLI - Claude Skill Discovery Tools
 *
 * Commands:
 * - import: Import skills from GitHub (SMI-580)
 * - search: Search for skills with interactive mode (SMI-744)
 * - list: List installed skills (SMI-745)
 * - update: Update installed skills (SMI-745)
 * - remove: Remove installed skills (SMI-745)
 * - init: Initialize new skill project (SMI-746)
 * - validate: Validate local SKILL.md (SMI-746)
 * - publish: Prepare skill for sharing (SMI-746)
 */

import { Command } from 'commander'
import { importSkills } from './import.js'
import {
  createSearchCommand,
  createListCommand,
  createUpdateCommand,
  createRemoveCommand,
  createInitCommand,
  createValidateCommand,
  createPublishCommand,
} from './commands/index.js'
import { DEFAULT_DB_PATH } from './config.js'
import { sanitizeError } from './utils/sanitize.js'

const program = new Command()

program.name('skillsmith').description('Claude Skill Discovery and Management CLI').version('0.1.0')

// SMI-580: Import command
program
  .command('import')
  .description('Import skills from GitHub')
  .option('-t, --topic <topic>', 'GitHub topic to search', 'claude-skill')
  .option('-m, --max <number>', 'Maximum skills to import', '1000')
  .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
  .option('-v, --verbose', 'Verbose output')
  .action(async (options: { topic: string; max: string; db: string; verbose?: boolean }) => {
    try {
      await importSkills({
        topic: options.topic,
        maxSkills: parseInt(options.max),
        dbPath: options.db,
        ...(options.verbose !== undefined && { verbose: options.verbose }),
      })
    } catch (error) {
      console.error('Import failed:', sanitizeError(error))
      process.exit(1)
    }
  })

// SMI-744: Search command with interactive mode
program.addCommand(createSearchCommand())

// SMI-745: Skill management commands
program.addCommand(createListCommand())
program.addCommand(createUpdateCommand())
program.addCommand(createRemoveCommand())

// SMI-746: Skill authoring commands
program.addCommand(createInitCommand())
program.addCommand(createValidateCommand())
program.addCommand(createPublishCommand())

program.parse()
