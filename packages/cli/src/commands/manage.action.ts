/**
 * SMI-745: Skill Management Commands — action implementations.
 *
 * SMI-5593: split out of manage.ts (which had grown past the 500-line
 * standard once the real `skillsmith update` implementation replaced the
 * stub) following the <command>.action.ts convention established by
 * SMI-5040/SMI-5127. The update diff/apply logic lives in manage.update.ts
 * (a second sibling split — this file was still over 500 lines with it
 * inline). manage.ts keeps only the commander factory functions.
 */

import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import Table from 'cli-table3'
import ora from 'ora'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import {
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  type TrustTier,
} from '@skillsmith/core'
import { openCliDatabase } from '../utils/open-database.js'
import { DEFAULT_DB_PATH, DEFAULT_MANIFEST_PATH } from '../config.js'
import {
  removeLinks,
  getInstallPath,
  parseInstallScope,
  resolveClientId,
  resolveScopedSkillsDir,
  CANONICAL_CLIENT,
  type ClientId,
  type ScopedInstallTarget,
} from '@skillsmith/core/install'
import { getCliLogger } from '../cli-logger.js'
import { sanitizeError } from '../utils/sanitize.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import {
  getInstalledSkills,
  getInstalledSkillsForClient,
  getLocalSkillsDirDisplay,
  type InstalledSkill,
} from '../utils/skills-directory.js'
import { getSkillDiff, updateSkill, updateSkills } from './manage.update.js'

const logger = getCliLogger()

/**
 * SMI-5894 (Wave 1 Step 2): resolve the effective client for `remove` and
 * `update` the same way `install` does (Wave 1 Step 1) — an explicit
 * `--client` wins, otherwise fall back to `SKILLSMITH_CLIENT`, otherwise
 * the canonical client. This replaces the frozen `DEFAULT_SKILLS_DIR`
 * constant these commands used to read (always Claude Code, regardless of
 * the env var) with a per-invocation resolution.
 */
function resolveEffectiveClient(explicit: string | undefined): ClientId {
  return resolveClientId(explicit ?? process.env['SKILLSMITH_CLIENT'])
}

/**
 * ADR-139 (SMI-6274 Wave 4): resolve the exact `(scope, client)` target for
 * `remove`/`update` write operations — an explicit `--scope` flag routes
 * through the shared core resolver's full precedence chain (env var,
 * per-client config default, auto-detection, global). An unsatisfiable
 * explicit `--scope workspace` throws `UnsatisfiableWorkspaceScopeError`,
 * left to the caller's existing top-level catch (a hard error, never a
 * silent downgrade — ADR-139 point 2).
 */
function resolveEffectiveScope(
  client: ClientId,
  scopeFlag: string | undefined
): ScopedInstallTarget {
  return resolveScopedSkillsDir({
    client,
    explicitScope: parseInstallScope(scopeFlag),
    globalManifestPath: DEFAULT_MANIFEST_PATH,
  })
}

/**
 * ADR-139: the `installedVia` label an entry from `getInstalledSkillsForClient`
 * carries for `client`'s OWN installs — `'local'` for the canonical client
 * (matching the existing SMI-1630 convention), else `client` itself. Used to
 * filter out an unrelated same-scope entry belonging to a DIFFERENT client
 * (e.g. the always-present claude-code/'local' workspace scan) when
 * resolving the exact `(scope, client, name)` triple a write must target.
 */
function installedViaFor(client: ClientId): ClientId | 'local' {
  return client === CANONICAL_CLIENT ? 'local' : client
}

/**
 * SMI-1809: Added 'local' tier color for local skills
 * SMI-5205: Added 'official' and 'unverified' tier colors
 */
const TRUST_TIER_COLORS: Record<TrustTier, (text: string) => string> = {
  official: chalk.magenta, // SMI-5205: Platform/partner — magenta to stand out from verified
  verified: chalk.green,
  curated: chalk.blue,
  community: chalk.yellow,
  local: chalk.cyan, // SMI-1809: Cyan for local skills
  experimental: chalk.red,
  unknown: chalk.gray,
  unverified: chalk.gray, // SMI-5205: Public alias for unknown — same color as unknown
}

/**
 * Display skills in a table format
 *
 * SMI-5893 (Wave 7 Step 1): `client` selects which resolved client's path is
 * shown in the "global: ..." footer segment — the footer used to hardcode
 * `~/.claude/skills` regardless of `--client`, even though `getInstallPath()`
 * has been the source of truth for this same file's other commands since
 * Wave 1. Defaults to `CANONICAL_CLIENT` (same value `resolveClientId(undefined)`
 * returns) so the unfiltered `list` call — which still scans every client's
 * directory, not just this one — keeps today's existing default text.
 *
 * SMI-6060: the footer's "local: ..." segment likewise now sources
 * `getLocalSkillsDirDisplay()` instead of hand-typing the literal
 * `./.claude/skills` — same displayed text (SMI-1630's repo-local
 * convention is unchanged and applies regardless of `--client`), just no
 * longer able to drift from `getLocalSkillsDir()`'s own path segments.
 *
 * ADR-139 (SMI-6274 Wave 4): adds a "Scope" column (global/workspace per
 * row — the ADR's own mitigation for "two directories to check when
 * debugging where a skill went") and marks an `untracked` entry (present on
 * disk with no manifest record) with a visible `[untracked]` suffix rather
 * than silently omitting it, per ADR-139 point 1's recovery requirement.
 */
function displaySkillsTable(skills: InstalledSkill[], client: ClientId = CANONICAL_CLIENT): void {
  if (skills.length === 0) {
    console.log(chalk.yellow('\nNo skills installed.\n'))
    console.log(chalk.dim('Install skills with: skillsmith install <author/skill-name>\n'))
    return
  }

  const table = new Table({
    head: [
      chalk.bold('Name'),
      chalk.bold('Version'),
      chalk.bold('Trust Tier'),
      chalk.bold('Scope'),
      chalk.bold('Install Date'),
      chalk.bold('Updates'),
    ],
    colWidths: [30, 15, 15, 11, 15, 12],
  })

  for (const skill of skills) {
    const colorFn = TRUST_TIER_COLORS[skill.trustTier]
    const name = skill.untracked
      ? `${skill.name} ${chalk.yellow('[untracked]')}`
      : colorFn(skill.name)
    table.push([
      name,
      skill.version || chalk.dim('N/A'),
      colorFn(skill.trustTier),
      skill.scope,
      skill.installDate,
      skill.hasUpdates ? chalk.green('Available') : chalk.dim('Up to date'),
    ])
  }

  console.log('\n' + chalk.bold.blue('Installed Skills') + '\n')
  console.log(table.toString())
  console.log(
    chalk.dim(
      `\n${skills.length} skill(s) found (global: ${getInstallPath(client)}, local: ${getLocalSkillsDirDisplay()})\n`
    )
  )
}

/**
 * Remove a skill using SkillInstallationService for manifest-aware removal.
 * Falls back to direct removal for orphan skills (on disk but not in manifest).
 *
 * SMI-5894 (Wave 1 Steps 2/3): `client` selects which agent's copy to
 * target — resolved by the caller via `resolveEffectiveClient()` (explicit
 * `--client`, else `SKILLSMITH_CLIENT`, else canonical). Both the
 * pre-confirm lookup and the actual removal now consistently target the
 * SAME resolved client's directory; previously the confirm-dialog lookup
 * scanned every client (`getInstalledSkills()`) while the actual removal
 * was hardcoded to Claude Code's directory regardless — so a skill
 * installed ONLY under a non-canonical client would show correctly in the
 * confirm dialog, then fail ("not installed") when actually removed.
 *
 * ADR-139 (SMI-6274 Wave 4): `scopeTarget` narrows this further to the
 * exact `(scope, client, name)` triple — both the pre-confirm lookup and
 * the actual `SkillInstallationService` construction now target the same
 * resolved scope's directory/manifest, never "whichever scope happened to
 * match by name" (the SMI-5894 defect class, one axis over).
 */
async function removeSkill(
  skillName: string,
  force: boolean,
  dbPath: string,
  client: ClientId,
  scopeTarget: ScopedInstallTarget
): Promise<boolean> {
  const skillsDir = scopeTarget.dir

  // Show skill info and confirm before proceeding (unless --force)
  if (!force) {
    const installed = await getInstalledSkillsForClient(client)
    const wantedVia = installedViaFor(client)
    const skill = installed.find(
      (s) =>
        s.name.toLowerCase() === skillName.toLowerCase() &&
        s.installedVia === wantedVia &&
        s.scope === scopeTarget.scope
    )

    if (!skill) {
      console.log(
        chalk.red(
          `Skill "${skillName}" is not installed for client "${client}" at ${scopeTarget.scope} scope`
        )
      )
      return false
    }

    console.log(chalk.bold(`\nSkill to remove:`))
    console.log(`  Name: ${skill.name}`)
    console.log(`  Version: ${skill.version || 'N/A'}`)
    console.log(`  Path: ${skill.path}`)
    if (skill.untracked) {
      console.log(
        chalk.yellow(
          `  Note: this install has no manifest entry (untracked) — it will be adopted before removal.`
        )
      )
    }
    console.log()

    const proceed = await confirm({
      message: `Are you sure you want to remove ${skill.name}?`,
      default: false,
    })

    if (!proceed) {
      console.log(chalk.yellow('Removal cancelled'))
      return false
    }
  }

  const spinner = ora(`Removing ${skillName}...`).start()

  // Ensure database directory exists before opening
  await mkdir(dirname(dbPath), { recursive: true })
  const db = await openCliDatabase(dbPath)

  try {
    const skillRepo = new SkillRepository(db)
    const skillDependencyRepo = new SkillDependencyRepository(db)

    const service = new SkillInstallationService({
      db,
      skillRepo,
      skillDependencyRepo,
      skillsDir,
      manifestPath: scopeTarget.manifestPath,
      client,
      onProgress: (_stage: string, detail: string) => {
        spinner.text = detail
      },
    })

    const result = await service.uninstall(skillName, { force })

    if (result.success) {
      // SMI-4578: tear down any --also-link fan-out destinations recorded
      // for this skill. Best-effort — uninstall must succeed even if the
      // manifest is missing or a destination was already cleaned up.
      //
      // SMI-5894 review: fan-out links are always recorded FROM the
      // canonical install (getDefaultFromClient()) -- removeLinks(skillId)
      // has no per-destination client scoping, so calling it unconditionally
      // would delete a canonical install's unrelated fan-out links whenever
      // a *non-canonical* independent install of the same-named skill is
      // removed (e.g. `remove foo --client cursor` nuking a canonical
      // `foo`'s `--also-link vscode` copy). Only the canonical removal path
      // legitimately owns those links.
      //
      // ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review round 3: client
      // identity alone is not sufficient once workspace scope is a real,
      // independent install location -- `client === CANONICAL_CLIENT` alone
      // still fires for a canonical client's WORKSPACE-scoped removal,
      // deleting the unrelated GLOBAL canonical install's fan-out links even
      // though only the workspace copy was meant to go. Fan-out is always
      // global-canonical-to-global-client, so scope must also be checked.
      if (client === CANONICAL_CLIENT && scopeTarget.scope === 'global') {
        try {
          const linkCount = await removeLinks(skillName)
          if (linkCount > 0) {
            spinner.text = `Removed ${linkCount} cross-client link${linkCount > 1 ? 's' : ''}`
          }
        } catch (linkErr) {
          console.log(
            chalk.yellow(
              `  Warning: could not clean up cross-client links: ${sanitizeError(linkErr)}`
            )
          )
        }
      }

      spinner.succeed(`Successfully removed ${skillName}`)
      if (result.warning) {
        console.log(chalk.yellow(`  Warning: ${result.warning}`))
      }
      return true
    } else {
      spinner.fail(result.message)
      if (result.warning) {
        console.log(chalk.yellow(`  ${result.warning}`))
      }
      return false
    }
  } catch (error) {
    spinner.fail(`Failed to remove ${skillName}: ${sanitizeError(error)}`)
    return false
  } finally {
    db.close()
  }
}

/**
 * List action
 */
// SMI-5128: handler impls extracted from inline .action() closures so
// withTelemetry can wrap them at the export boundary (SMI-5040 coverage gate).
async function listActionImpl(opts: Record<string, string | boolean | undefined>): Promise<void> {
  try {
    const dbPath = opts['db'] as string
    const outdated = (opts['outdated'] as boolean) ?? false
    const clientOpt = opts['client'] as string | undefined

    // SMI-5894 (Wave 1 Step 2): `list` already scans every client by
    // default (this is a working cross-client inventory, not a detection
    // gap) — `--client` narrows that inventory down to one client. Unlike
    // `remove`/`update`, this is an explicit-opt-in filter only: it does
    // NOT fall back to SKILLSMITH_CLIENT, since that would silently change
    // `list`'s existing "show everything" default for anyone who already
    // sets the env var for install/remove/update.
    // SMI-5893 (Wave 7 Step 1): resolves the SAME value used to select the
    // scan directory above — `resolveClientId(clientOpt)` returns
    // CANONICAL_CLIENT when clientOpt is undefined, matching the unfiltered
    // scan's existing default. This does not add an SKILLSMITH_CLIENT env
    // fallback for `list` (see the doc comment above `clientOpt`'s
    // declaration) — only the footer text's client resolution, not the scan
    // filter, changes here.
    const resolvedClient = resolveClientId(clientOpt)
    const skills =
      clientOpt !== undefined
        ? await getInstalledSkillsForClient(resolvedClient, dbPath)
        : await getInstalledSkills(dbPath)
    const filtered = outdated ? skills.filter((s) => s.hasUpdates) : skills

    if (outdated && filtered.length === 0) {
      console.log(chalk.green('\nAll installed skills are up to date.\n'))
      return
    }

    displaySkillsTable(filtered, resolvedClient)
  } catch (error) {
    logger.error(`${chalk.red('Error listing skills:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const listAction = withTelemetry(listActionImpl, {
  source: 'cli',
  extractSkillId: () => 'list',
  extractFramework: () => 'cli',
})

/**
 * Update action
 *
 * SMI-5593: user control over one skill, a set of skills, or all skills.
 * Bare `skillsmith update` (no names, no --all) prints usage guidance
 * instead of silently updating everything — a behavior change from the
 * prior implicit "no args = update all" (see docs updated alongside this).
 */
async function updateActionImpl(
  skillNames: string[],
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const dbPath = (opts['db'] as string) ?? DEFAULT_DB_PATH
  const updateAll = (opts['all'] as boolean) ?? false
  const dryRun = (opts['dryRun'] as boolean) ?? false

  try {
    const client = resolveEffectiveClient(opts['client'] as string | undefined)
    const scopeTarget = resolveEffectiveScope(client, opts['scope'] as string | undefined)
    if (updateAll) {
      if (skillNames.length > 0) {
        logger.error(chalk.red('Cannot combine --all with specific skill names.'))
        process.exit(1)
        return
      }
      await updateSkills(undefined, dbPath, dryRun, client, scopeTarget)
    } else if (skillNames.length > 0) {
      await updateSkills(skillNames, dbPath, dryRun, client, scopeTarget)
    } else {
      console.log(
        chalk.yellow('Specify one or more skills to update, or pass --all for everything.')
      )
      console.log(chalk.dim('  skillsmith update <skill>'))
      console.log(chalk.dim('  skillsmith update <skill1> <skill2> ...'))
      console.log(chalk.dim('  skillsmith update --all'))
      console.log(chalk.dim('  skillsmith update <skill> --dry-run'))
      process.exit(1)
    }
  } catch (error) {
    logger.error(`${chalk.red('Error updating skills:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const updateAction = withTelemetry(updateActionImpl, {
  source: 'cli',
  extractSkillId: () => 'update',
  extractFramework: () => 'cli',
})

/**
 * Remove action
 */
async function removeActionImpl(
  skillName: string,
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const force = (opts['force'] as boolean) ?? false
  const dbPath = (opts['db'] as string) ?? DEFAULT_DB_PATH

  try {
    const client = resolveEffectiveClient(opts['client'] as string | undefined)
    const scopeTarget = resolveEffectiveScope(client, opts['scope'] as string | undefined)
    const success = await removeSkill(skillName, force, dbPath, client, scopeTarget)
    process.exit(success ? 0 : 1)
  } catch (error) {
    logger.error(`${chalk.red('Error removing skill:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const removeAction = withTelemetry(removeActionImpl, {
  source: 'cli',
  extractSkillId: () => 'remove',
  extractFramework: () => 'cli',
})

export { getInstalledSkills, displaySkillsTable, getSkillDiff, updateSkill, updateSkills }
