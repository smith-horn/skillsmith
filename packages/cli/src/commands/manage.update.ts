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
import { basename, join } from 'path'
import {
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  SkillParser,
  SourceRecoveryService,
  hashContent,
  manifestKeyFor,
  type DatabaseType,
  type RecoveryConfidence,
  type Skill,
  type SkillRecoveryResult,
} from '@skillsmith/core'
import { openCliDatabase } from '../utils/open-database.js'
import { DEFAULT_MANIFEST_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'
import { loadManifest } from '../utils/manifest.js'
import { getInstalledSkillsForClient, type InstalledSkill } from '../utils/skills-directory.js'
import {
  buildFindCandidatesByName,
  buildFindRegistryIdByRepoUrl,
} from '../utils/source-recovery-deps.js'
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
 * SMI-5895 (Wave 2 Step 1): confidence tiers that {@link recoverConfidentSourceId}
 * auto-applies without asking the user to confirm — matches the same
 * "exact/high/user-specified auto-backfill, medium/low review-only" floor
 * `backfillManifest`'s own default `minConfidence: 'high'` already encodes
 * (`provenance/backfill.ts`, `commands/audit-sources.ts --min-confidence`
 * default). A medium/low match is a *speculative* name lookup — silently
 * trusting it here could overwrite a local skill with the wrong upstream
 * version, so `update` fails safely instead (plan-review correction).
 */
const AUTO_APPLY_RECOVERY_CONFIDENCES = new Set<RecoveryConfidence>([
  'exact',
  'high',
  'user-specified',
])

/**
 * SMI-5895 (Wave 2 Step 1): fall back to `SourceRecoveryService` (SMI-5407,
 * already exposed via `sklx audit sources` / `skill_recover_source`) ONLY
 * when the manifest has no entry for this skill at all. Gated on confidence
 * — see {@link AUTO_APPLY_RECOVERY_CONFIDENCES}. Returns null (never
 * throws) when recovery is unavailable, unresolved/ambiguous, or below the
 * auto-apply confidence floor; the caller directs the user to
 * `sklx audit sources` for manual review in that case.
 */
async function recoverConfidentSourceId(
  skillName: string,
  installed: InstalledSkill,
  db: DatabaseType
): Promise<string | null> {
  let skillMd: string | null
  try {
    skillMd = await readFile(join(installed.path, 'SKILL.md'), 'utf-8')
  } catch {
    skillMd = null
  }
  const service = new SourceRecoveryService({
    hashContent,
    findCandidatesByName: buildFindCandidatesByName(db),
    findRegistryIdByRepoUrl: buildFindRegistryIdByRepoUrl(db),
  })
  let result: SkillRecoveryResult
  try {
    result = await service.recoverOne(installed.path, skillName, skillMd)
  } catch {
    // The injected deps hit the local `skills` cache directly, so a missing/
    // corrupt table throws rather than returning zero candidates. Recovery is
    // a best-effort fallback — degrade to "unresolvable" (whose message points
    // at `sklx audit sources`) instead of failing the whole update command.
    return null
  }
  if (result.status !== 'recovered' || !AUTO_APPLY_RECOVERY_CONFIDENCES.has(result.confidence)) {
    return null
  }
  // SMI-5895 review (D-1): prefer the skill-specific recoveredSource.url over
  // registryId. registryId comes from findRegistryIdByRepoUrl's `repo_url`-only
  // lookup (source-recovery-deps.ts), which has no per-skill disambiguation --
  // a multi-skill plugin/monorepo shares one repo_url across every skill in it,
  // so it can resolve to a DIFFERENT skill's registry row than the one being
  // recovered. recoveredSource is always populated alongside registryId for
  // both auto-apply-eligible tiers (SourceRecoveryService.recoverOne's
  // git-remote/plugin-json branches), so this never loses real recovery
  // coverage -- registryId only remains as a defensive fallback for a future
  // confidence tier that might populate one without the other.
  return result.recoveredSource?.url ?? result.registryId ?? null
}

/**
 * SMI-6103: the installed skill's own claimed author, read directly from its
 * SKILL.md front-matter (never null-defaulted to a directory/display name —
 * an unclaimed "Local" skill, the website's own term, genuinely has none).
 * Returns null on any read/parse failure or an absent `author` field.
 */
async function readClaimedAuthor(installedPath: string): Promise<string | null> {
  try {
    const skillMd = await readFile(join(installedPath, 'SKILL.md'), 'utf-8')
    const parsed = new SkillParser().parse(skillMd)
    const author = (parsed as unknown as Record<string, unknown> | undefined)?.['author']
    return typeof author === 'string' && author.trim().length > 0 ? author.trim() : null
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
 * `'unresolvable'` when it's installed but no registry ID can be resolved
 * for it — from the local cache, the manifest, or (below) a confident
 * SourceRecoveryService recovery.
 *
 * SMI-5894 (Wave 1 Steps 2/3): `client` scopes the "is this installed"
 * lookup to the resolved client's own directory (plus repo-local skills)
 * via `getInstalledSkillsForClient`, instead of `getInstalledSkills()`'s
 * global cross-client dedup. Without this, a skill installed under two
 * clients with the same name would always resolve to whichever client wins
 * that dedup's precedence (Claude Code), not necessarily the client the
 * caller asked `update --client <id>` to target.
 *
 * SMI-5895 (Wave 2 Step 1): when the local cache doesn't have the skill,
 * this now consults `~/.skillsmith/manifest.json` — which
 * `SkillInstallationService.install()` already writes a correct `id`/
 * `source` into on every successful install (skill-installation.service.ts)
 * — keyed by `manifestKeyFor(<install dir basename>, client)` so a
 * same-named skill installed independently under two clients resolves to
 * the entry that actually matches the client being asked about, not
 * whichever one was written last (see the key-derivation note at the lookup
 * site). Only when the manifest entry is genuinely missing does this
 * fall back to a confidence-gated `SourceRecoveryService` recovery (see
 * {@link recoverConfidentSourceId}) — replacing the previous
 * `resolveInstalledSkillId()` dead code, which read a `SKILL.md`
 * front-matter `id` field `SkillParser` never actually populates.
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
    // SMI-6103: a bare-name match here is only trustworthy when the installed
    // skill's OWN front-matter claims the same author as the matched cache
    // row — otherwise this silently resolves to an unrelated same-named
    // skill from a different author (confirmed data loss: two personal,
    // unclaimed skills were overwritten with unrelated registry content this
    // way). A skill with no claimed author at all ("Local", the website's
    // own term for this) must fall through to the confidence-gated
    // manifest/recovery path below rather than be trusted here.
    const allSkills = skillRepo.findAll(1000, 0)
    const skill = allSkills.items.find(
      (s: Skill) => s.name.toLowerCase() === skillName.toLowerCase()
    )

    if (skill) {
      const claimedAuthor = await readClaimedAuthor(installed.path)
      if (
        claimedAuthor &&
        skill.author &&
        claimedAuthor.toLowerCase() === skill.author.toLowerCase()
      ) {
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
      // Bare-name cache hit with no matching author claim — do not trust it.
      // Fall through to the manifest / confidence-gated recovery path.
    }

    // Not in the local cache — consult the manifest first (SMI-5895 Wave 2
    // Step 1: the manifest entry install() already wrote is the source of
    // truth this was previously never reading), keyed by (name, client) per
    // Wave 1 Step 3 so a same-named skill installed under two clients
    // resolves the entry that matches THIS client, not name alone.
    //
    // The key is derived from the install DIRECTORY basename, not from
    // `skillName` (the caller-supplied argument) or `installed.name` (which
    // `getSkillsFromDirectory` takes from SKILL.md front-matter, falling
    // back to the directory name). `install()` builds both `installPath =
    // join(skillsDir, skillName)` and `manifestKeyFor(skillName, client)`
    // from the same string, so the basename is the only value guaranteed to
    // reproduce the key it wrote — the argument is matched case-insensitively
    // ("update Astro" resolves the `astro` install) and front-matter `name`
    // can differ from the directory outright, so keying off either silently
    // misses the entry and falls through to source recovery.
    const manifest = await loadManifest()
    const manifestEntry =
      manifest.installedSkills?.[manifestKeyFor(basename(installed.path), client)]
    const manifestId =
      manifestEntry && typeof manifestEntry.id === 'string' && manifestEntry.id.trim().length > 0
        ? manifestEntry.id
        : null

    // Genuinely missing from the manifest — fall back to a confidence-gated
    // SourceRecoveryService recovery (SMI-5407). Never silently trust a
    // medium/low-confidence speculative match here.
    const resolvedId = manifestId ?? (await recoverConfidentSourceId(skillName, installed, db))
    if (!resolvedId) {
      return 'unresolvable'
    }

    // A raw GitHub URL (a direct-URL install's manifest `id`, or a
    // git-remote/plugin-json SourceRecoveryService recovery) isn't a
    // registry ID — skip the registry API confirmation below and let the
    // force-install fetch it directly, same as a direct-URL `install` does.
    if (resolvedId.startsWith('https://github.com/')) {
      return {
        skillId: resolvedId,
        oldVersion: installed.version,
        newVersion: null,
        changes: [
          `Source resolved to ${resolvedId} — no cached version to diff; will fetch and overwrite with the latest content.`,
        ],
      }
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
        `"${skillName}" has no recorded registry source — run "sklx audit sources" to recover it, or "skillsmith install <author>/${skillName} --force" with the full ID`
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
