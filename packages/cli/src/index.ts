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
 * - registry install: Install a skill from your team's private registry (SMI-5905, Enterprise)
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
  createRegistryCommand,
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
  createTelemetryCommand,
  createInventoryCommand,
  createAgentCommand,
  createDiagnoseCommand,
  createLogsCommand,
} from './commands/index.js'
import { getCliLogger } from './cli-logger.js'
import { displayStartupHeader } from './utils/license.js'
import { resolveCommandPath, shouldShowStartupHeader } from './utils/startup-header-gate.js'
import { applyRootQuietOption } from './utils/quiet-mode-gate.js'
import { checkNodeVersion } from './utils/node-version.js'
import { readFileSync } from 'fs'
import { join } from 'path'
import { packageRoot } from './utils/package-root.js'

// SMI-5615: shared structured logger for this CLI process — writes redacted
// JSON-line records to disk and, for warn/error, still mirrors to
// console.warn/console.error exactly as before (see logger.ts's persistRecord).
const logger = getCliLogger()

// SMI-1629: Check Node.js version before anything else
const versionError = checkNodeVersion()
if (versionError) {
  logger.error(versionError)
  process.exit(1)
}

// Read version from package.json dynamically
const packageJsonPath = join(packageRoot(), 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
const CLI_VERSION = packageJson.version

const program = new Command()

// Detect which command name was used (skillsmith or sklx)
const commandName = process.argv[1]?.endsWith('sklx') ? 'sklx' : 'skillsmith'

program
  .name(commandName)
  .description(
    'A registry for sharing, scanning, and tracking agent skills across teams. (alias: sklx)'
  )
  .version(CLI_VERSION)
  // SMI-5893 (Wave 7 Step 4): a single root-level --quiet, wired once via
  // the preAction hook below, instead of every command independently
  // mapping its own `--quiet`/`--no-progress` into SKILLSMITH_QUIET (only
  // `search.action.ts` did, and via a narrower literal-'true' string check
  // rather than the shared `isQuietModeEnabled()` helper). Deliberately no
  // `-q` short alias here: several subcommands (search, install, registry
  // install) already declare their own local `-q, --quiet` — Commander
  // resolves an identically-spelled flag to whichever Command instance
  // registers it FIRST regardless of where in argv it appears, so a root
  // `-q` would silently steal those subcommands' own short flag. The long
  // `--quiet` form has the same collision for the LONG spelling specifically
  // (root wins there too), which is why `search.action.ts`'s own
  // `options.quiet` check below is OR'd with `isQuietModeEnabled()` rather
  // than replaced by it — command-local wins when Commander actually routes
  // the flag to the subcommand (e.g. via `-q`), and the shared env var
  // still covers the case where root captured a bare `--quiet` instead.
  .option(
    '--quiet',
    'Suppress advisory/progress output across all commands (sets SKILLSMITH_QUIET)'
  )

// SMI-5893 (Wave 7 Step 4): resolved before ANY subcommand's action runs,
// regardless of where in the command tree --quiet was passed, so every
// command that already honors SKILLSMITH_QUIET (probe.ts, createDatabase.ts,
// embeddings/index.ts) — and any command updated to call
// `isQuietModeEnabled()` — picks it up without each command re-deriving it.
// Only SETS the env var when root's own --quiet was passed; never clears
// it, so an externally-set SKILLSMITH_QUIET (shell/CI) is never clobbered
// by an invocation that didn't pass --quiet at all.
program.hook('preAction', (thisCommand) => {
  applyRootQuietOption(thisCommand.opts()['quiet'] as boolean | undefined)
})

// Display startup header with license status before parsing commands.
// SMI-5427: gated by startup-header-gate — suppressed for non-TTY / piped use,
// auth commands, and machine-readable subcommands (matched by full parent+leaf
// path so a bare `status` does not over-exempt `sync status`/`telemetry status`).
program.hook('preAction', async (_thisCommand, actionCommand) => {
  const path = resolveCommandPath(actionCommand.name(), actionCommand.parent?.name(), commandName)
  if (!shouldShowStartupHeader(path, Boolean(process.stdout.isTTY))) return
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

// SMI-5905 Wave 4: `skillsmith registry install <skillId>` (Enterprise private registry)
program.addCommand(createRegistryCommand())

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

// SMI-5615 Wave 3 Step 1: diagnostic snapshot + log inspection commands
program.addCommand(createDiagnoseCommand())
program.addCommand(createLogsCommand())

// SMI-5021 Wave 3: telemetry opt-in + Claude Code hook management
program.addCommand(createTelemetryCommand())

// SMI-5392 Wave 3: cross-harness inventory push/status/forget-device
program.addCommand(createInventoryCommand())

// SMI-5456 Wave 1 Step 5: install/uninstall the portable Skillsmith Agent pack
program.addCommand(createAgentCommand())

program.parse()
