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
 * - analyze: Analyze codebase for skill recommendations (SMI-1283)
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
  createSubagentCommand,
  createTransformCommand,
  createMcpInitCommand,
  createAnalyzeCommand,
  createRecommendCommand,
} from './commands/index.js'
import { DEFAULT_DB_PATH } from './config.js'
import { sanitizeError } from './utils/sanitize.js'
import { displayStartupHeader } from './utils/license.js'

const CLI_VERSION = '0.2.3'

const program = new Command()

// Detect which command name was used (skillsmith or sklx)
const commandName = process.argv[1]?.endsWith('sklx') ? 'sklx' : 'skillsmith'

program
  .name(commandName)
  .description('Claude Skill Discovery and Management CLI (alias: sklx)')
  .version(CLI_VERSION)

// Display startup header with license status before parsing commands
// Use hook to display header before any command runs
program.hook('preAction', async () => {
  await displayStartupHeader(CLI_VERSION)
})

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

// SMI-746: Skill authoring commands (under 'author' group)
const authorCommand = new Command('author')
  .description('Skill authoring and publishing tools')
  .addCommand(createInitCommand())
  .addCommand(createValidateCommand())
  .addCommand(createPublishCommand())
  .addCommand(createSubagentCommand())
  .addCommand(createTransformCommand())
  .addCommand(createMcpInitCommand())

program.addCommand(authorCommand)

// Legacy aliases for backward compatibility (direct commands)
program.addCommand(createInitCommand().name('init'))
program.addCommand(createValidateCommand().name('validate'))
program.addCommand(createPublishCommand().name('publish'))

// SMI-1283: Codebase analysis
program.addCommand(createAnalyzeCommand())

// SMI-1299: Recommendations
program.addCommand(createRecommendCommand())

program.parse()
