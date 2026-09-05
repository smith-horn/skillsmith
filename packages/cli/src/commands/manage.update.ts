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
  classifyManifestEntryForUpdate,
  buildUpdateSkipReason,
  isUnsafeToForceInstall,
} from './manage.update.identity.js'
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

/** SMI-6343 (Wave 3, H5): richer per-skill outcome, distinguishing a safety-gated skip from a failure. */
export type UpdateSkillOutcome =
  | 'updated'
  | 'up-to-date'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  | 'not-installed'

export interface UpdateSkillResult {
  outcome: UpdateSkillOutcome
  /** Populated for `skipped` (why) and `failed` (the error). */
  reason?: string | undefined
}

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
 *
 * SMI-6343 (Wave 3, H5): richer outcome so `updateSkills()`'s summary can
 * distinguish a safety-gated `skipped` from a genuine `failed` — see
 * `updateSkill()` below for the boolean-returning wrapper every existing
 * caller/test keeps using unmodified.
 */
async function updateSkillWithOutcome(
  skillName: string,
  dbPath: string,
  dryRun = false,
  client: ClientId = CANONICAL_CLIENT,
  scopeTarget?: ScopedInstallTarget
): Promise<UpdateSkillResult> {
  const spinner = ora(`Checking updates for ${skillName}...`).start()

  try {
    const diff = await getSkillDiff(skillName, dbPath, client, scopeTarget)

    if (diff === 'not-installed') {
      spinner.fail(
        `"${skillName}" is not installed — use "skillsmith install <author>/${skillName}" instead`
      )
      return { outcome: 'not-installed' }
    }

    if (diff === 'unresolvable') {
      spinner.fail(
        `"${skillName}" has no recorded registry source — run "sklx audit sources" to recover it, or "skillsmith install <author>/${skillName} --force" with the full ID`
      )
      return { outcome: 'failed', reason: 'unresolvable' }
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
      return { outcome: 'failed', reason: 'adopted-unresolvable' }
    }

    if ('adoptionError' in diff) {
      spinner.fail(diff.adoptionError)
      return { outcome: 'failed', reason: diff.adoptionError }
    }

    if (diff.changes.length === 0) {
      spinner.succeed(`${skillName} is already up to date`)
      return { outcome: 'up-to-date' }
    }

    spinner.stop()

    console.log(chalk.bold(`\nChanges for ${skillName}:`))
    for (const change of diff.changes) {
      console.log(chalk.cyan(`  - ${change}`))
    }
    console.log()

    if (dryRun) {
      console.log(chalk.dim(`(dry run — ${skillName} was not updated)\n`))
      return { outcome: 'up-to-date' }
    }

    const proceed = await confirm({
      message: `Update ${skillName}?`,
      default: true,
    })

    if (!proceed) {
      console.log(chalk.yellow('Update cancelled'))
      return { outcome: 'cancelled' }
    }

    const updateSpinner = ora(`Updating ${skillName}...`).start()

    const db = await openCliDatabase(dbPath)
    try {
      const skillRepo = new SkillRepository(db)
      const skillDependencyRepo = new SkillDependencyRepository(db)
      const registryLookup = await createApiBackedRegistryLookup(skillRepo, db)

      // SMI-6343 (Wave 3, H5): refuse to force-install over an ALREADY-
      // corrupt entry before it happens — SMI-6103's existing gate protects
      // against CREATING a bad resolution; this protects against ACTING on
      // one that's already there. Reuses `diff.resolvedRegistryRecord`
      // (already obtained while resolving `diff` itself) rather than a
      // second registry lookup.
      const classification = await classifyManifestEntryForUpdate({
        entry: diff.currentEntry,
        client,
        scopeTarget,
        resolvedRegistryRecord: diff.resolvedRegistryRecord,
      })
      if (isUnsafeToForceInstall(classification)) {
        const reason = buildUpdateSkipReason(classification)
        updateSpinner.fail(`Skipping update for ${skillName}: ${reason}`)
        return { outcome: 'skipped', reason }
      }

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
        return { outcome: 'updated' }
      }

      updateSpinner.fail(`Failed to update ${skillName}: ${result.error}`)
      return { outcome: 'failed', reason: result.error }
    } finally {
      db.close()
    }
  } catch (error) {
    const reason = sanitizeError(error)
    spinner.fail(`Failed to update ${skillName}: ${reason}`)
    return { outcome: 'failed', reason }
  }
}

/**
 * Boolean-returning wrapper preserving `updateSkill()`'s pre-Wave-3 external
 * contract for every existing caller/test — `true` for `updated`/`up-to-date`,
 * `false` for everything else (failed, skipped, cancelled, not-installed).
 */
async function updateSkill(
  skillName: string,
  dbPath: string,
  dryRun = false,
  client: ClientId = CANONICAL_CLIENT,
  scopeTarget?: ScopedInstallTarget
): Promise<boolean> {
  const result = await updateSkillWithOutcome(skillName, dbPath, dryRun, client, scopeTarget)
  return result.outcome === 'updated' || result.outcome === 'up-to-date'
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
  let skipped = 0
  let failed = 0
  const skipReasons: string[] = []

  for (const name of targetNames) {
    const result = await updateSkillWithOutcome(name, dbPath, dryRun, client, scopeTarget)
    if (result.outcome === 'updated' || result.outcome === 'up-to-date') {
      updated++
    } else if (result.outcome === 'skipped') {
      // SMI-6343 (Wave 3, H5): a `local-drift`/`identity-mismatch`/`unknown`
      // classification lands here, never silently in `Updated` — the pre-
      // Wave-3 code had no bucket for this, so `updateSkill()` returning
      // `true` for "already up to date" made a skipped row indistinguishable
      // from a real success.
      skipped++
      skipReasons.push(`${name}: ${result.reason ?? 'unsafe to force-install'}`)
    } else {
      failed++
    }
  }

  console.log(chalk.bold('\nUpdate Summary:'))
  console.log(chalk.green(`  Updated: ${updated}`))
  if (skipped > 0) {
    console.log(chalk.yellow(`  Skipped: ${skipped}`))
    for (const reason of skipReasons) {
      console.log(chalk.dim(`    - ${reason}`))
    }
  }
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

export { getSkillDiff, updateSkill, updateSkillWithOutcome, updateSkills }
