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
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  SkillParser,
  type Skill,
} from '@skillsmith/core'
import { openCliDatabase } from '../utils/open-database.js'
import { DEFAULT_MANIFEST_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'
import { getInstalledSkillsForClient, type InstalledSkill } from '../utils/skills-directory.js'
import { createApiBackedRegistryLookup } from './install.js'
import { CANONICAL_CLIENT, getInstallPath, type ClientId } from '@skillsmith/core/install'

/**
 * Extended Skill type with optional version field.
 * Used for type-safe version comparisons in getSkillDiff.
 */
interface SkillWithVersion extends Skill {
  version?: string
}

/**
 * SMI-5593: read an installed skill's own SKILL.md front-matter `id` field
 * (conventionally `author/name`, stamped at install time — see SMI-5442
 * provenance capture). This is the fallback source of truth for resolving a
 * bare skill name to a full registry ID when the local SQLite cache doesn't
 * have the skill (the common case per SMI-5427 remote-default search).
 * Returns null when SKILL.md is unreadable or has no `author/name`-shaped id.
 */
async function resolveInstalledSkillId(installed: InstalledSkill): Promise<string | null> {
  try {
    const content = await readFile(join(installed.path, 'SKILL.md'), 'utf-8')
    const parsed = new SkillParser().parse(content) as unknown as Record<string, unknown> | null
    const id = parsed?.['id']
    return typeof id === 'string' && id.includes('/') ? id : null
  } catch {
    return null
  }
}

/** Resolved diff/update target for a single installed skill. */
interface SkillDiff {
  /** Full `author/name` registry ID to pass to SkillInstallationService.install(). */
  skillId: string
  oldVersion: string | null
  newVersion: string | null
  changes: string[]
}

/**
 * Get skill diff for an installed skill, checking the local registry cache
 * first and falling back to the remote registry when the cache doesn't have
 * it (SMI-5427: the local SQLite cache is commonly empty in the
 * remote-default world — the local-only lookup this replaced would report
 * "not found in registry" for most real installs).
 *
 * Returns `'not-installed'` when the skill isn't installed at all, or
 * `'unresolvable'` when it's installed but has no recorded registry ID
 * (locally or in its own SKILL.md front-matter) to update against.
 *
 * SMI-5894 (Wave 1 Steps 2/3): `client` scopes the "is this installed"
 * lookup to the resolved client's own directory (plus repo-local skills)
 * via `getInstalledSkillsForClient`, instead of `getInstalledSkills()`'s
 * global cross-client dedup. Without this, a skill installed under two
 * clients with the same name would always resolve to whichever client wins
 * that dedup's precedence (Claude Code), not necessarily the client the
 * caller asked `update --client <id>` to target.
 */
async function getSkillDiff(
  skillName: string,
  dbPath: string,
  client: ClientId = CANONICAL_CLIENT
): Promise<SkillDiff | 'not-installed' | 'unresolvable'> {
  const installed = (await getInstalledSkillsForClient(client, dbPath)).find(
    (s) => s.name.toLowerCase() === skillName.toLowerCase()
  )
  if (!installed) {
    return 'not-installed'
  }

  const db = await openCliDatabase(dbPath)
  const skillRepo = new SkillRepository(db)

  try {
    // Find skill in the local registry cache by name (case-insensitive search).
    const allSkills = skillRepo.findAll(1000, 0)
    const skill = allSkills.items.find(
      (s: Skill) => s.name.toLowerCase() === skillName.toLowerCase()
    )

    if (skill) {
      const changes: string[] = []
      const skillWithVersion = skill as SkillWithVersion

      if (installed.version !== skillWithVersion.version) {
        changes.push(
          `Version: ${installed.version || 'N/A'} -> ${skillWithVersion.version || 'N/A'}`
        )
      }

      if (installed.trustTier !== skill.trustTier) {
        changes.push(`Trust Tier: ${installed.trustTier || 'unknown'} -> ${skill.trustTier}`)
      }

      return {
        skillId: skill.id,
        oldVersion: installed.version,
        newVersion: skillWithVersion.version || null,
        changes,
      }
    }

    // Not in the local cache — resolve via the skill's own recorded id and
    // confirm it against the remote registry (same fallback shape as
    // install.ts's createApiBackedRegistryLookup, SMI-5427).
    const resolvedId = await resolveInstalledSkillId(installed)
    if (!resolvedId) {
      return 'unresolvable'
    }

    const registryLookup = await createApiBackedRegistryLookup(skillRepo, db)
    const remote = await registryLookup.lookup(resolvedId)
    if (!remote) {
      return 'unresolvable'
    }

    // The registry API doesn't expose a comparable version string, so we
    // can't render a version diff here — confirm the source and let the
    // force-install fetch + overwrite with the latest content.
    return {
      skillId: resolvedId,
      oldVersion: installed.version,
      newVersion: null,
      changes: [
        `Registry source confirmed at ${remote.repoUrl} — no cached version to diff; will fetch and overwrite with the latest content.`,
      ],
    }
  } finally {
    db.close()
  }
}

/**
 * Update a single skill. With `dryRun`, shows the same diff preview without
 * prompting or installing.
 *
 * SMI-5894 (Wave 1 Steps 2/3): `client` selects which agent's copy to
 * update — resolved by the caller (explicit `--client`, else
 * `SKILLSMITH_CLIENT`, else canonical). Replaces the previously frozen
 * `DEFAULT_SKILLS_DIR` (always Claude Code) with a per-invocation
 * resolution via `getInstallPath(client)`.
 */
async function updateSkill(
  skillName: string,
  dbPath: string,
  dryRun = false,
  client: ClientId = CANONICAL_CLIENT
): Promise<boolean> {
  const spinner = ora(`Checking updates for ${skillName}...`).start()

  try {
    const diff = await getSkillDiff(skillName, dbPath, client)

    if (diff === 'not-installed') {
      spinner.fail(
        `"${skillName}" is not installed — use "skillsmith install <author>/${skillName}" instead`
      )
      return false
    }

    if (diff === 'unresolvable') {
      spinner.fail(
        `"${skillName}" has no recorded registry source — try "skillsmith install <author>/${skillName} --force" with the full ID`
      )
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
        skillsDir: getInstallPath(client),
        manifestPath: DEFAULT_MANIFEST_PATH,
        registryLookup,
        client,
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
 */
async function updateSkills(
  names: string[] | undefined,
  dbPath: string,
  dryRun: boolean,
  client: ClientId = CANONICAL_CLIENT
): Promise<void> {
  const targetNames =
    names ?? (await getInstalledSkillsForClient(client, dbPath)).map((s) => s.name)

  if (targetNames.length === 0) {
    console.log(chalk.yellow('No skills installed'))
    return
  }

  console.log(chalk.bold(`\nChecking updates for ${targetNames.length} skill(s)...\n`))

  let updated = 0
  let failed = 0

  for (const name of targetNames) {
    const success = await updateSkill(name, dbPath, dryRun, client)
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
