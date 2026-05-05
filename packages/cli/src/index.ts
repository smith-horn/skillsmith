#!/usr/bin/env node
/**
 * Skillsmith CLI - Agent Skill Discovery Tools
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
 * - author subagent: Generate companion subagent for a skill (SMI-1389)
 * - author transform: Upgrade existing skill with subagent (SMI-1390)
 * - author mcp-init: Scaffold a new MCP server project (SMI-1433)
 * - install: Install a skill from registry or GitHub URL (SMI-3484)
 * - setup: Install skillsmith skill for /skillsmith slash command (SMI-824, renamed from install-skill)
 */

import { Command } from 'commander'
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
  createSyncCommand,
  createInstallCommand,
  createInstallSkillCommand,
  createLoginCommand,
  createLogoutCommand,
  createWhoamiCommand,
  createDiffCommand,
  createPinCommand,
  createUnpinCommand,
  createAuditCommand,
  createCreateCommand,
  createInfoCommand,
  createImportCommand,
  createImportLocalCommand,
  createConfigCommand,
} from './commands/index.js'
import { displayStartupHeader } from './utils/license.js'
import { checkNodeVersion } from './utils/node-version.js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// SMI-1629: Check Node.js version before anything else
const versionError = checkNodeVersion()
if (versionError) {
  console.error(versionError)
  process.exit(1)
}

// Read version from package.json dynamically
const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJsonPath = join(__dirname, '..', '..', 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
const CLI_VERSION = packageJson.version

const program = new Command()

// Detect which command name was used (skillsmith or sklx)
const commandName = process.argv[1]?.endsWith('sklx') ? 'sklx' : 'skillsmith'

program
  .name(commandName)
  .description('Agent Skill Discovery and Management CLI (alias: sklx)')
  .version(CLI_VERSION)

// Display startup header with license status before parsing commands.
// Skip for auth commands (login/logout/whoami) which manage credentials and
// must not emit extra output that could interfere with scripted use.
const NO_HEADER_COMMANDS = ['login', 'logout', 'whoami']
program.hook('preAction', async (_thisCommand, actionCommand) => {
  if (NO_HEADER_COMMANDS.includes(actionCommand.name())) return
  await displayStartupHeader(CLI_VERSION)
})

// SMI-580: Import command (GitHub topic walker)
// SMI-4665: refactored from inline registration to addCommand pattern
program.addCommand(createImportCommand())

// SMI-4665: Filesystem-walking SKILL.md importer
program.addCommand(createImportLocalCommand())

// SMI-744: Search command with interactive mode
program.addCommand(createSearchCommand())

// SMI-745: Skill management commands
program.addCommand(createListCommand())
program.addCommand(createUpdateCommand())
program.addCommand(createRemoveCommand())

// SMI-3484: Install skill from registry or GitHub URL
program.addCommand(createInstallCommand())

// SMI-746: Skill authoring commands (under 'author' group)
// SMI-1389, SMI-1390: Subagent generation
// SMI-1433: MCP server scaffolding
const authorCommand = new Command('author')
  .description('Skill authoring, subagent generation, and MCP server tools')
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

// Registry Sync
program.addCommand(createSyncCommand())

// SMI-824: Install skillsmith skill for /skillsmith slash command
// SMI-3484: Renamed from 'install-skill' to 'setup' to avoid confusion with 'install'
const setupCommand = createInstallSkillCommand()
program.addCommand(setupCommand)

// SMI-2715: CLI Login Device Flow
program.addCommand(createLoginCommand())
program.addCommand(createLogoutCommand())
program.addCommand(createWhoamiCommand())

// SMI-skill-version-tracking Wave 2: diff, pin, unpin
program.addCommand(createDiffCommand())
program.addCommand(createPinCommand())
program.addCommand(createUnpinCommand())

// SMI-skill-version-tracking Wave 3: Security Advisory Audit
program.addCommand(createAuditCommand())

// SMI-3083: Embedded skill scaffolding (also available as `sklx create`)
program.addCommand(createCreateCommand())

// SMI-3672: Skill info with SKILL.md content
program.addCommand(createInfoCommand())

// SMI-4590 Wave 4 PR 5/6: `sklx config get/set audit_mode`
program.addCommand(createConfigCommand())

program.parse()
