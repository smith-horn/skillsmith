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

import chalk from 'chalk'
import Table from 'cli-table3'
import { type TrustTier } from '@skillsmith/core'
import { DEFAULT_DB_PATH, DEFAULT_MANIFEST_PATH } from '../config.js'
import {
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
import { removeExitCode, removeSkill } from './manage.remove.js'
// ADR-175 § 5 / SMI-6946: extracted to stay under the 500-line standard, same
// reason manage.update.helpers.ts exists.
import { warnDatabaseUnopenable, warnUndetermined } from './manage.update-status.js'

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
      // ADR-175 § 5: three states, because a database fault makes the answer
      // unknowable and printing "Up to date" for it is a claim with no basis.
      skill.updateStatus === 'available'
        ? chalk.green('Available')
        : skill.updateStatus === 'unknown'
          ? chalk.yellow('Unknown')
          : chalk.dim('Up to date'),
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
    // SMI-7260: the scan's own open failure, kept so it can be reported once,
    // even when no skill row exists to carry it. No second open.
    let dbOpenError: unknown
    const noteOpenFailure = (error: unknown) => {
      dbOpenError ??= error
    }
    const skills =
      clientOpt !== undefined
        ? await getInstalledSkillsForClient(resolvedClient, dbPath, noteOpenFailure)
        : await getInstalledSkills(dbPath, noteOpenFailure)
    // ADR-175 § 5. `--outdated` filters on a CONFIRMED newer version, so an
    // entry whose state could not be determined is neither listed as outdated
    // nor silently counted as current — it is reported separately below.
    const undetermined = skills.filter((s) => s.updateStatus === 'unknown')
    // ADR-175 § 5: one warning per command, and a database fault costs the
    // update column, not the command (exit 0). When the open failed, its one
    // warning replaces the per-skill one, so the cause is printed once.
    const warn = () =>
      dbOpenError !== undefined
        ? warnDatabaseUnopenable(dbOpenError, undetermined.length, skills.length)
        : warnUndetermined(undetermined, skills.length)
    const filtered = outdated ? skills.filter((s) => s.updateStatus === 'available') : skills

    if (outdated && filtered.length === 0) {
      // The old message here was "All installed skills are up to date." — a
      // second false statement on exactly the same fault as the table's "Up to
      // date", and reachable whenever the database cannot be read. It may only
      // be printed when every skill was actually checked.
      if (undetermined.length === 0) {
        console.log(chalk.green('\nAll installed skills are up to date.\n'))
      } else if (undetermined.length < skills.length) {
        // Partial: say what WAS established, then let the warning say what
        // was not. When nothing could be checked, this line would only
        // restate the warning, so it is omitted rather than duplicated.
        console.log(chalk.yellow('\nNo updates found among the skills that could be checked.\n'))
      }
      warn()
      return
    }

    displaySkillsTable(filtered, resolvedClient)
    warn()
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
  const yes = (opts['yes'] as boolean) ?? false

  try {
    const client = resolveEffectiveClient(opts['client'] as string | undefined)
    const scopeTarget = resolveEffectiveScope(client, opts['scope'] as string | undefined)
    if (updateAll) {
      if (skillNames.length > 0) {
        logger.error(chalk.red('Cannot combine --all with specific skill names.'))
        process.exit(1)
        return
      }
      await updateSkills(undefined, dbPath, dryRun, client, scopeTarget, yes)
    } else if (skillNames.length > 0) {
      await updateSkills(skillNames, dbPath, dryRun, client, scopeTarget, yes)
    } else {
      console.log(
        chalk.yellow('Specify one or more skills to update, or pass --all for everything.')
      )
      // SMI-6530 containment: lead with a dry-run review of everything; a bulk,
      // non-dry-run `update --all` can overwrite local edits until the update
      // eligibility gate (SMI-6532) ships.
      console.log(chalk.dim('  skillsmith update --all --dry-run   # review every update first'))
      console.log(chalk.dim('  skillsmith update <skill>'))
      console.log(chalk.dim('  skillsmith update <skill1> <skill2> ...'))
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
    const outcome = await removeSkill(skillName, force, dbPath, client, scopeTarget)
    process.exit(removeExitCode(outcome))
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
