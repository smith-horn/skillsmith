/**
 * SMI-5593: `skillsmith update` diff/apply logic.
 *
 * Split out of manage.action.ts (which had grown past the 500-line standard)
 * following the <command>.action.ts / <command>.<concern>.ts sibling
 * convention established by SMI-5040/SMI-5127.
 */

import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import {
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
} from '@skillsmith/core'
import { openCliDatabase } from '../utils/open-database.js'
import { DEFAULT_MANIFEST_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'
import { getInstalledSkillsForClient } from '../utils/skills-directory.js'
import { createApiBackedRegistryLookup } from './install.js'
import { installedViaFor, getSkillDiff } from './manage.update.helpers.js'
import {
  CANONICAL_CLIENT,
  getInstallPath,
  type ClientId,
  type ScopedInstallTarget,
} from '@skillsmith/core/install'

// `SkillDiff` and `getSkillDiff` moved to manage.update.helpers.ts (SMI-6274
// Wave 4, file-length gate) — `getSkillDiff` imported above for local use
// (updateSkill calls it directly) and re-exported at the bottom of this file
// alongside updateSkill/updateSkills so manage.action.ts's existing
// `from './manage.update.js'` import path is unaffected.
export type { SkillDiff } from './manage.update.helpers.js'

/**
 * Update a single skill. With `dryRun`, shows the same diff preview without
 * prompting or installing.
 *
 * SMI-5894 (Wave 1 Steps 2/3): `client` selects which agent's copy to
 * update — resolved by the caller (explicit `--client`, else
 * `SKILLSMITH_CLIENT`, else canonical). Replaces the previously frozen
 * `DEFAULT_SKILLS_DIR` (always Claude Code) with a per-invocation
 * resolution.
 *
 * ADR-139 (SMI-6274 Wave 4): `scopeTarget` (when passed) resolves the exact
 * `(scope, client)` write target — `skillsDir`/`manifestPath` come from it
 * rather than always `getInstallPath(client)`/the global manifest, so an
 * `update --scope workspace` overwrites the workspace copy, never the
 * global one. Optional (defaulting to the canonical global resolution) so
 * this stays callable from tests/callers that predate ADR-139.
 */
async function updateSkill(
  skillName: string,
  dbPath: string,
  dryRun = false,
  client: ClientId = CANONICAL_CLIENT,
  scopeTarget?: ScopedInstallTarget
): Promise<boolean> {
  const spinner = ora(`Checking updates for ${skillName}...`).start()

  try {
    const diff = await getSkillDiff(skillName, dbPath, client, scopeTarget)

    if (diff === 'not-installed') {
      spinner.fail(
        `"${skillName}" is not installed — use "skillsmith install <author>/${skillName}" instead`
      )
      return false
    }

    if (diff === 'unresolvable') {
      spinner.fail(
        `"${skillName}" has no recorded registry source — run "sklx audit sources" to recover it, or "skillsmith install <author>/${skillName} --force" with the full ID`
      )
      return false
    }

    if (diff === 'adopted-unresolvable') {
      // ADR-139 (SMI-6274 Wave 4): this skill WAS untracked (no manifest
      // entry) and has now been adopted — a manifest entry exists with
      // version/source recorded as "unknown" — but no registry source could
      // be determined for it either. The command "says so" explicitly per
      // ADR-139 point 1, distinct from the generic 'unresolvable' message.
      spinner.fail(
        `"${skillName}" was untracked and has been adopted (version/source recorded as "unknown"), ` +
          `but no registry source could be determined — run "sklx audit sources" to recover it, ` +
          `or "skillsmith install <author>/${skillName} --force" to set the real source`
      )
      return false
    }

    if ('adoptionError' in diff) {
      spinner.fail(diff.adoptionError)
      return false
    }

    if (diff.changes.length === 0) {
      spinner.succeed(`${skillName} is already up to date`)
      return true
    }

    spinner.stop()

    console.log(chalk.bold(`\nChanges for ${skillName}:`))
    for (const change of diff.changes) {
      console.log(chalk.cyan(`  - ${change}`))
    }
    console.log()

    if (dryRun) {
      console.log(chalk.dim(`(dry run — ${skillName} was not updated)\n`))
      return true
    }

    const proceed = await confirm({
      message: `Update ${skillName}?`,
      default: true,
    })

    if (!proceed) {
      console.log(chalk.yellow('Update cancelled'))
      return false
    }

    const updateSpinner = ora(`Updating ${skillName}...`).start()

    const db = await openCliDatabase(dbPath)
    try {
      const skillRepo = new SkillRepository(db)
      const skillDependencyRepo = new SkillDependencyRepository(db)
      const registryLookup = await createApiBackedRegistryLookup(skillRepo, db)

      const service = new SkillInstallationService({
        db,
        skillRepo,
        skillDependencyRepo,
        skillsDir: scopeTarget?.dir ?? getInstallPath(client),
        manifestPath: scopeTarget?.manifestPath ?? DEFAULT_MANIFEST_PATH,
        registryLookup,
        client,
        // SMI-5982 PR-review follow-up: explicit now that
        // resolveCompanionAgentPath() no longer defaults a missing baseDir to
        // process.cwd() itself — this CLI command's real "cwd" IS the
        // process's invocation directory, so this restores today's exact
        // behavior explicitly instead of relying on a now-removed implicit
        // default.
        companionBaseDir: process.cwd(),
        onProgress: (_stage: string, detail: string) => {
          updateSpinner.text = detail
        },
      })

      const result = await service.install(diff.skillId, { force: true })

      if (result.success) {
        updateSpinner.succeed(`Updated ${skillName}`)
        return true
      }

      updateSpinner.fail(`Failed to update ${skillName}: ${result.error}`)
      return false
    } finally {
      db.close()
    }
  } catch (error) {
    spinner.fail(`Failed to update ${skillName}: ${sanitizeError(error)}`)
    return false
  }
}

/**
 * Update a set of skills by name, or every installed skill when `names` is
 * omitted (the `--all` path). Shared by the explicit-list and `--all`
 * commander paths so both print the same per-skill progress + summary.
 *
 * SMI-5894 (Wave 1 Steps 2/3): `client` scopes both the `--all` skill-name
 * enumeration and each per-skill update to the resolved client.
 *
 * ADR-139 (SMI-6274 Wave 4): `scopeTarget` (when passed) additionally
 * narrows the `--all` enumeration to skills actually installed at THIS
 * exact `(scope, client)` pair — without it, `update --all --scope
 * workspace` would enumerate every one of `client`'s installs (global AND
 * workspace) and then try to write every one of them to the workspace
 * directory.
 */
async function updateSkills(
  names: string[] | undefined,
  dbPath: string,
  dryRun: boolean,
  client: ClientId = CANONICAL_CLIENT,
  scopeTarget?: ScopedInstallTarget
): Promise<void> {
  const wantedVia = installedViaFor(client)
  const targetNames =
    names ??
    (await getInstalledSkillsForClient(client, dbPath))
      .filter(
        (s) => !scopeTarget || (s.installedVia === wantedVia && s.scope === scopeTarget.scope)
      )
      .map((s) => s.name)

  if (targetNames.length === 0) {
    console.log(chalk.yellow('No skills installed'))
    return
  }

  console.log(chalk.bold(`\nChecking updates for ${targetNames.length} skill(s)...\n`))

  let updated = 0
  let failed = 0

  for (const name of targetNames) {
    const success = await updateSkill(name, dbPath, dryRun, client, scopeTarget)
    if (success) {
      updated++
    } else {
      failed++
    }
  }

  console.log(chalk.bold('\nUpdate Summary:'))
  console.log(chalk.green(`  Updated: ${updated}`))
  if (failed > 0) {
    console.log(chalk.red(`  Failed: ${failed}`))
  }
  console.log()

  if (!dryRun && updated > 0) {
    console.log(
      chalk.dim('Run "skillsmith inventory push" to sync this to skillsmith.app/account/skills.\n')
    )
  }
}

export { getSkillDiff, updateSkill, updateSkills }
