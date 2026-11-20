/**
 * SMI-6531 (A1 step 8-i-a-1): `skillsmith remove`'s skill removal, split out
 * of `manage.action.ts` to keep that file under the 500-line standard.
 *
 * Uninstall parks the folder (A1 plan §3.8 row 3). `removeSkill` reports one
 * of three outcomes, and `removeExitCode` maps them (UD32): `removed` 0,
 * `failed` 1 (every existing refusal), `not-done` 4 (the park ended `kept`,
 * `held` or `stopped`; the manifest entry was kept). The fan-out link
 * teardown still runs only on `removed`. The space warning and the
 * `.gitignore` hints, from core's park-result path, go to stderr.
 *
 * @module @skillsmith/cli/commands/manage.remove
 */
import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import {
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  type CoreUninstallResult,
} from '@skillsmith/core'
import {
  removeLinks,
  CANONICAL_CLIENT,
  type ClientId,
  type ScopedInstallTarget,
} from '@skillsmith/core/install'
import { openCliDatabase } from '../utils/open-database.js'
import { sanitizeError } from '../utils/sanitize.js'
import { getInstalledSkillsForClient } from '../utils/skills-directory.js'

/** What one `remove` ended as. */
export type RemoveOutcome = 'removed' | 'failed' | 'not-done'

/** UD32: 0 removed, 1 failed or refused, 4 not done (the park did not finish). */
export function removeExitCode(outcome: RemoveOutcome): 0 | 1 | 4 {
  return outcome === 'removed' ? 0 : outcome === 'not-done' ? 4 : 1
}

/** The park-result path's stderr lines: the space warning, then each hint. */
export function printParkResultLines(
  result: Pick<CoreUninstallResult, 'usageWarning' | 'hints'>
): void {
  if (result.usageWarning !== undefined) console.error(result.usageWarning)
  for (const hint of result.hints ?? []) console.error(hint)
}

/**
 * ADR-139: the `installedVia` label an entry from `getInstalledSkillsForClient`
 * carries for `client`'s OWN installs — `'local'` for the canonical client
 * (matching the existing SMI-1630 convention), else `client` itself. Used to
 * filter out an unrelated same-scope entry belonging to a DIFFERENT client
 * (e.g. the always-present claude-code/'local' workspace scan) when
 * resolving the exact `(scope, client, name)` triple a write must target.
 */
export function installedViaFor(client: ClientId): ClientId | 'local' {
  return client === CANONICAL_CLIENT ? 'local' : client
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
export async function removeSkill(
  skillName: string,
  force: boolean,
  dbPath: string,
  client: ClientId,
  scopeTarget: ScopedInstallTarget
): Promise<RemoveOutcome> {
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
      return 'failed'
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
      return 'failed'
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
      // 8-i-a-1 gate Major 2: when another install claimed the name, the links
      // recorded under it are that install's, so they are left alone.
      if (result.claimedByAnotherInstall === true) {
        console.log(
          chalk.yellow(
            '  Warning: another install claimed this name while it was being removed, so its ' +
              'cross-client links were left in place for that install.'
          )
        )
      } else if (client === CANONICAL_CLIENT && scopeTarget.scope === 'global') {
        try {
          // SMI-6529 N6 (round 4): `removeLinks` now reports destinations it
          // refused to remove (e.g. a recorded fan-out copy that has since
          // become a real `.git` working tree) instead of silently
          // discarding both the manifest entry and the content — surface
          // each refusal so the user knows a fan-out destination was left
          // behind and why.
          const { removed: linkCount, refused, warnings } = await removeLinks(skillName)
          if (linkCount > 0) {
            spinner.text = `Removed ${linkCount} cross-client link${linkCount > 1 ? 's' : ''}`
          }
          for (const text of [...refused.map((r) => r.reason), ...(warnings ?? [])]) {
            console.log(chalk.yellow(`  Warning: ${text}`))
          }
        } catch (linkErr) {
          console.log(
            chalk.yellow(
              `  Warning: could not clean up cross-client links: ${sanitizeError(linkErr)}`
            )
          )
        }
      }

      spinner.succeed(result.message)
      if (result.warning) {
        console.log(chalk.yellow(`  Warning: ${result.warning}`))
      }
      printParkResultLines(result)
      return 'removed'
    }
    // One stderr line (ora writes to stderr) naming the path, status and reason.
    spinner.fail(result.message)
    if (result.warning) {
      console.log(chalk.yellow(`  ${result.warning}`))
    }
    printParkResultLines(result)
    return result.notDone === undefined ? 'failed' : 'not-done'
  } catch (error) {
    spinner.fail(`Failed to remove ${skillName}: ${sanitizeError(error)}`)
    return 'failed'
  } finally {
    db.close()
  }
}
