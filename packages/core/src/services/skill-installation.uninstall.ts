/**
 * @fileoverview `performUninstall` — manifest-aware skill removal, including
 *   ADR-139 (SMI-6274 Wave 4)'s untracked-skill adoption.
 * @module @skillsmith/core/services/skill-installation.uninstall
 *
 * Split out of `skill-installation.helpers.ts` to stay under the 500-line
 * standard once ADR-139's adoption logic was added — mirrors the existing
 * `skill-installation.io.ts` sibling-split convention. `performUninstall`
 * has exactly one internal consumer (`skill-installation.service.ts`) and
 * is not part of `@skillsmith/core`'s public export surface.
 */

import type { Stats } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'

import { checkGitAtRoot } from '../install/fan-out.overwrite.js'
import {
  listParkedLeftovers,
  parkedLeftoverWarning,
  removeIfSame,
} from '../install/remove-if-same.js'

import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'
import type { ProgressCallback, UninstallResult } from './skill-installation.types.js'
import { checkForModifications } from './skill-installation.io.js'
import { hashContent, manifestKeyFor } from './skill-installation.helpers.js'
import type { ManifestManager } from './skill-manifest.js'
import { CANONICAL_CLIENT, type ClientId } from '../install/paths.js'
import type { SkillManifestEntry } from './skill-installation.types.js'

/**
 * ADR-139 (SMI-6274 Wave 4): build a manifest entry for a skill found on
 * disk with no manifest record — "adoption." Every field is reconstructed
 * from what is directly observable on disk; fields that genuinely cannot
 * be recovered this way (the originating registry version/source) are
 * recorded as `'unknown'` rather than guessed, so a later `update` sees
 * `'unknown'` and falls through to confidence-gated source recovery
 * instead of silently trusting a wrong version (ADR-139 point 1).
 *
 * Exported (not just used by {@link performUninstall}) so `update`'s own
 * adoption path (`packages/cli/src/commands/manage.update.ts`) reuses the
 * IDENTICAL reconstruction logic rather than a second, driftable copy —
 * GPT-5.6-Sol PR review, ADR-139 follow-up: `update` previously never
 * adopted an untracked skill at all, only `remove` did.
 */
export async function buildAdoptedManifestEntry(
  skillName: string,
  installPath: string
): Promise<SkillManifestEntry> {
  const dirStat = await fs.stat(installPath)
  // installedAt is set to the NEWEST top-level file mtime (falling back to
  // the directory's own mtime when it has no files), mirroring exactly the
  // scan `checkForModifications` (skill-installation.io.ts) performs — a
  // directory's own mtime can legitimately be OLDER than a file inside it
  // last touched, which would otherwise make an adopted skill look
  // "modified" (and thus require force=true) on the very next removal
  // attempt, immediately after adoption.
  let newestMtimeMs = dirStat.mtime.getTime()
  try {
    const entries = await fs.readdir(installPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fileStat = await fs.stat(path.join(installPath, entry.name))
      if (fileStat.mtime.getTime() > newestMtimeMs) newestMtimeMs = fileStat.mtime.getTime()
    }
  } catch {
    // Fall back to the directory's own mtime — best-effort.
  }
  const nowIso = new Date(newestMtimeMs).toISOString()
  let contentHash: string | undefined
  try {
    const skillMd = await fs.readFile(path.join(installPath, 'SKILL.md'), 'utf-8')
    contentHash = hashContent(skillMd)
  } catch {
    contentHash = undefined
  }
  return {
    id: skillName,
    name: skillName,
    version: 'unknown',
    source: 'unknown',
    installPath,
    installedAt: nowIso,
    lastUpdated: nowIso,
    ...(contentHash !== undefined && { contentHash }),
  }
}

/**
 * ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review round 4: adopt an
 * untracked skill (present on disk, no manifest entry) by writing a
 * reconstructed manifest entry — race-safe against a concurrent writer
 * (e.g. a real `install()`, or another concurrent `update()`) tracking the
 * SAME skill between the caller's own (unlocked) manifest read and this
 * call's lock-acquired write.
 *
 * Single shared implementation for BOTH adoption call sites —
 * {@link performUninstall} (this file, calls it directly) and
 * `getSkillDiff` (`packages/cli/src/commands/manage.update.ts`, via this
 * function's re-export at the `@skillsmith/core` package root). Round 3's
 * confirmation review found a CLI-package-local copy of this exact
 * race-safety logic (`manage.update.helpers.ts`'s now-removed
 * `adoptUntrackedSkill`) had drifted from `performUninstall`'s own
 * still-non-race-safe inline version — importing a CLI file into `core`
 * would be a layering violation, so the fix moves the ONE race-safe
 * implementation here, alongside {@link buildAdoptedManifestEntry}, instead
 * of maintaining two copies of the same logic.
 *
 * The `updateSafely()` callback checks `current.installedSkills[manifestKey]`
 * INSIDE the callback, against the FRESH, lock-acquired state it's handed —
 * never a caller's own stale, unlocked read: if a real entry is already
 * there by the time the lock is held, that entry wins and the guessed one
 * is discarded entirely (never written) — a concurrent legitimate
 * `install()` must never be clobbered by a same-tick adoption's guess.
 *
 * Returns the entry now in the manifest (freshly adopted, or a real one a
 * concurrent writer got there first with) plus whether OUR write happened,
 * or `{ adoptionError }` if the write itself failed — naming the skill,
 * path, and manifest (via `manifest.path`), per ADR-139 point 1's stated
 * failure contract.
 */
export async function adoptUntrackedSkillEntry(
  skillName: string,
  skillDirName: string,
  installPath: string,
  manifestKey: string,
  manifest: ManifestManager
): Promise<{ entry: SkillManifestEntry; adopted: boolean } | { adoptionError: string }> {
  const adoptedEntry = await buildAdoptedManifestEntry(skillDirName, installPath)
  let resolvedEntry = adoptedEntry
  let adopted = true

  try {
    await manifest.updateSafely((current) => {
      const existing = current.installedSkills?.[manifestKey]
      if (existing) {
        resolvedEntry = existing
        adopted = false
        return current
      }
      resolvedEntry = adoptedEntry
      adopted = true
      return {
        ...current,
        installedSkills: { ...current.installedSkills, [manifestKey]: adoptedEntry },
      }
    })
  } catch (adoptError) {
    return {
      adoptionError:
        'Failed to adopt untracked skill "' +
        skillName +
        '" at ' +
        installPath +
        ' into manifest ' +
        manifest.path +
        ': ' +
        (adoptError instanceof Error ? adoptError.message : String(adoptError)),
    }
  }

  return { entry: resolvedEntry, adopted }
}

/**
 * SMI-6529 round 15 (cross-model review, Critical): what uninstall found at
 * `installPath` before removing it. A folder with `.git` at its root is a git
 * working tree, which git owns (ADR-155), so it is refused with or without
 * `force`: deleting it would take unpushed commits and uncommitted edits with
 * it. A symlink or a file needs no such check, since removing it leaves what
 * it points at alone. Returns the entry's identity (null when nothing is
 * there), so the delete can confirm it is still the same entry.
 */
async function inspectForRemoval(
  installPath: string
): Promise<{ stat: Stats | null } | { refusal: string }> {
  let stat: Stats
  try {
    stat = await fs.lstat(installPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { stat: null }
    return {
      refusal:
        'Could not check ' +
        installPath +
        ' (' +
        (code ?? String(error)) +
        '); nothing was removed.',
    }
  }
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    const git = await checkGitAtRoot(installPath)
    if (git.kind === 'present') {
      return {
        refusal:
          installPath +
          ' is a git working tree (it has .git at its root), so Skillsmith will not delete it, ' +
          'even with force. Check `git -C ' +
          installPath +
          ' status`, then remove the folder yourself.',
      }
    }
    if (git.kind === 'unknown') {
      return {
        refusal:
          'Could not check ' +
          installPath +
          ' for a .git directory (' +
          git.reason +
          '); nothing was removed.',
      }
    }
  }
  return { stat }
}

/** Perform skill uninstall with manifest awareness and orphan fallback. */
export async function performUninstall(params: {
  skillName: string
  force: boolean
  skillsDir: string
  manifest: ManifestManager
  skillDependencyRepo: SkillDependencyRepository
  onProgress: ProgressCallback
  /** SMI-5894 Wave 1 Step 3: defaults to the canonical client for callers
   *  that don't yet resolve a client (preserves pre-existing behavior). */
  client?: ClientId
}): Promise<UninstallResult> {
  const {
    skillName,
    force,
    skillsDir,
    manifest,
    skillDependencyRepo,
    onProgress,
    client = CANONICAL_CLIENT,
  } = params
  const manifestKey = manifestKeyFor(skillName, client)

  try {
    onProgress('manifest', 'Loading manifest')
    const manifestData = await manifest.load()
    let skillEntry = manifestData.installedSkills[manifestKey]
    let adopted = false

    if (!skillEntry) {
      const potentialPath = path.join(skillsDir, skillName)
      try {
        await fs.access(potentialPath)
      } catch {
        return { success: false, skillName, message: 'Skill "' + skillName + '" is not installed.' }
      }
      // SMI-6529 round 15: refuse a git working tree before adopting it, so a
      // refusal writes nothing to the manifest.
      const early = await inspectForRemoval(potentialPath)
      if ('refusal' in early) return { success: false, skillName, message: early.refusal }

      // ADR-139 (SMI-6274 Wave 4): a skill present on disk with no manifest
      // entry is ADOPTED — reconciled by writing a manifest entry derived
      // from disk — rather than requiring force=true just to remove it (the
      // previous behavior). This closes the "untracked install" recovery
      // gap ADR-139 point 1 requires: `update`/`remove` must not fail
      // obscurely on an untracked skill.
      //
      // GPT-5.6-Sol PR review round 4: routed through the shared, race-safe
      // {@link adoptUntrackedSkillEntry} instead of an inline write — this
      // call site previously wrote the guessed entry unconditionally,
      // without re-checking the manifest state under lock, so a concurrent
      // real `install()` landing in that window could be silently
      // clobbered. `adopted` now reflects whether OUR guess actually won
      // (false when a concurrent writer's real entry was found instead).
      onProgress('adopt', 'Adopting untracked skill (no manifest entry found)')
      const adoptResult = await adoptUntrackedSkillEntry(
        skillName,
        skillName,
        potentialPath,
        manifestKey,
        manifest
      )
      if ('adoptionError' in adoptResult) {
        // Only if adoption itself fails does the command error — naming the
        // skill, the path, and the manifest it tried to write (ADR-139
        // point 1's stated failure contract).
        return { success: false, skillName, message: adoptResult.adoptionError }
      }
      skillEntry = adoptResult.entry
      adopted = adoptResult.adopted
    }

    const installPath = skillEntry.installPath
    const seen = await inspectForRemoval(installPath)
    if ('refusal' in seen) return { success: false, skillName, message: seen.refusal }

    if (!force) {
      onProgress('check', 'Checking for modifications')
      const modified = await checkForModifications(installPath, skillEntry.installedAt)
      if (modified) {
        return {
          success: false,
          skillName,
          message:
            'Skill "' +
            skillName +
            '" has been modified since installation. Use force=true to remove anyway.',
          warning: 'Local modifications will be lost if you force uninstall.',
        }
      }
    }

    onProgress('remove', 'Removing skill directory')
    // SMI-6529 round 15 (cross-model review, Critical): remove only the entry
    // checked above. Anything another program put there since is left in
    // place, and so is the manifest entry, so the user can retry.
    if (seen.stat !== null) {
      const removal = await removeIfSame(installPath, seen.stat)
      if (!removal.removed) {
        return {
          success: false,
          skillName,
          message:
            'Skill "' +
            skillName +
            '" was not removed: ' +
            installPath +
            ' ' +
            removal.reason +
            '.',
        }
      }
    }

    try {
      skillDependencyRepo.clearAll(skillEntry.id)
    } catch {
      // Table may not exist pre-migration
    }

    onProgress('manifest', 'Updating manifest')
    // SMI-6007: route the final mutation through updateSafely() (lock +
    // fresh re-read + save) instead of saving the `manifestData` snapshot
    // loaded above. That snapshot can be stale by the time we get here —
    // filesystem cleanup and the dependency-repo clear happened in between —
    // so saving it directly could clobber an *unrelated* manifest entry
    // written by a concurrent install/uninstall in that window. This closes
    // that lost-update hazard for entries other than this one.
    //
    // Scope: this does NOT make the full uninstall sequence (lookup ->
    // filesystem cleanup -> manifest mutation) atomic. A concurrent
    // operation racing on the SAME key (e.g. a reinstall of this exact
    // skill while its uninstall is mid-flight) can still leave disk and
    // manifest inconsistent — only the unrelated-entry data loss is fixed
    // here, not full transactional safety across the whole method.
    //
    // Round 16 (cross-model review): the record is dropped only while it still
    // describes the skill just removed. A concurrent install of the same name
    // rewrites this key, and an unconditional delete would lose that install's
    // record. And a manifest write that fails after the folder is gone is
    // reported for what it is, rather than surfacing as a bare lock error.
    let claimedByAnotherInstall = false
    try {
      await manifest.updateSafely((current) => {
        const entry = current.installedSkills[manifestKey]
        const describesWhatWasRemoved =
          entry === undefined ||
          (entry.installPath === undefined
            ? entry.id === skillEntry.id
            : path.resolve(entry.installPath) === path.resolve(installPath))
        if (!describesWhatWasRemoved) {
          claimedByAnotherInstall = true
          return current
        }
        const next: typeof current = { ...current, installedSkills: { ...current.installedSkills } }
        delete next.installedSkills[manifestKey]
        return next
      })
    } catch (error) {
      return {
        success: false,
        skillName,
        removedPath: installPath,
        message:
          'Skill "' +
          skillName +
          '" was removed from ' +
          installPath +
          ', but its record in ' +
          manifest.path +
          ' could not be updated (' +
          (error instanceof Error ? error.message : String(error)) +
          '). Run the same remove again to clear the record.',
      }
    }

    onProgress('done', 'Uninstall complete')
    // Round 16 (both reviewers): away from a fan-out destination nothing swept
    // what a failed removal parked, so it was named once and never again.
    const warnings = [
      ...(adopted
        ? [
            'This skill had no manifest entry (untracked) — it was adopted from disk state before removal.',
          ]
        : []),
      ...(claimedByAnotherInstall
        ? [
            'Another install claimed this name while this one was being removed, so that record was left alone.',
          ]
        : []),
      ...(await listParkedLeftovers(installPath)).map(parkedLeftoverWarning),
    ]
    return {
      success: true,
      skillName,
      message: 'Skill "' + skillName + '" has been uninstalled successfully.',
      removedPath: installPath,
      ...(warnings.length > 0 && { warning: warnings.join(' ') }),
    }
  } catch (error) {
    return {
      success: false,
      skillName,
      message: error instanceof Error ? error.message : 'Unknown error during uninstall',
    }
  }
}
