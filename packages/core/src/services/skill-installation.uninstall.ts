/**
 * @fileoverview `performUninstall` — manifest-aware skill removal, including
 *   ADR-139 (SMI-6274 Wave 4)'s untracked-skill adoption.
 * @module @skillsmith/core/services/skill-installation.uninstall
 *
 * Split out of `skill-installation.helpers.ts` to stay under the 500-line
 * standard, per the `skill-installation.io.ts` sibling-split convention; round
 * 25 split `.uninstall.helpers.ts` out again for the same reason, round 7
 * split `.removal-identity.ts` off the guard module, and the ADR-171 § 5
 * retraction resolution moved `buildAdoptedManifestEntry`/
 * `adoptUntrackedSkillEntry`/`updateManifestTolerantly` into
 * `.uninstall.helpers.ts` for the same reason again — re-exported below so
 * `@skillsmith/core`'s public export surface (`exports/services.install.ts`)
 * is unaffected. One internal consumer (`skill-installation.service.ts`); not
 * part of the public export surface itself.
 */

import * as fs from 'fs/promises'
import * as path from 'path'

import { removeIfSame } from '../install/remove-if-same.js'

import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'
import type { ProgressCallback, UninstallResult } from './skill-installation.types.js'
import { checkForModifications } from './skill-installation.io.js'
import {
  checkExactEntryName,
  checkRemovalTarget,
  checkRemovableSkillName,
} from './skill-installation.removal-guard.js'
import {
  checkNotTrackedElsewhere,
  identityChanged,
  type DirIdentity,
} from './skill-installation.removal-identity.js'
import { manifestKeyFor } from './skill-installation.helpers.js'
import type { ManifestManager } from './skill-manifest.js'
import { loadManifestLenient, ManifestUnwritableError } from './skill-manifest.read-state.js'
import type { SkillManifest } from './skill-installation.types.js'
import { CANONICAL_CLIENT, type ClientId } from '../install/paths.js'
import {
  adoptUntrackedSkillEntry,
  buildAdoptedManifestEntry,
  inspectForRemoval,
  notify,
  parkedWarnings,
  sameRecord,
} from './skill-installation.uninstall.helpers.js'

// ADR-171 § 5 retraction resolution: re-exported so nothing outside this pair
// of files (`exports/services.install.ts`'s barrel re-export in particular)
// has to know these moved to `.uninstall.helpers.ts`.
export { adoptUntrackedSkillEntry, buildAdoptedManifestEntry }

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

  // Round 28 (pre-merge gate, PR-07): a progress listener that throws must not
  // change the outcome, but it must not vanish either. Every notify below
  // records into this one array, and every exit that reports warnings carries
  // it.
  const listenerProblems: string[] = []
  // Round 29 (pre-merge gate, confirmation pass): `notify` fires before every
  // exit below, so EVERY exit has to carry what the listener did — not just
  // the ones that already had a warning to give. The previous round covered
  // the reporting exits only, which left a listener failure vanishing on the
  // refusal, not-installed, adoption-failure and outer-error paths.
  const listenerWarning = (): { warning?: string } =>
    listenerProblems.length > 0 ? { warning: listenerProblems.join(' ') } : {}
  try {
    // Both "may this NAME be removed" rules live in the guard module alongside
    // "may this PATH be removed" -- see `checkRemovableSkillName`. Checked HERE,
    // before the manifest is loaded and before adoption, because a refusal must
    // write nothing: the git-working-tree check below states that same invariant.
    const nameOk = checkRemovableSkillName(skillName)
    if (!nameOk.ok) {
      return {
        success: false,
        skillName,
        message: `Skill "${skillName}" was not removed: ${nameOk.reason}`,
        ...listenerWarning(),
      }
    }

    notify(onProgress, listenerProblems, 'manifest', 'Loading manifest')
    // ADR-171 § 5 retraction resolution, Part A: this read must never throw
    // here. Every identity/containment check below -- name, exact-entry,
    // not-tracked-elsewhere, path containment, and the post-adoption swap
    // check -- has to get a chance to run and produce its OWN, more specific
    // refusal before a degraded manifest read is allowed to turn into one:
    // "this directory was swapped out from under you" is more actionable
    // than "your manifest is corrupt", and when both are true the former is
    // what the caller needs to hear.
    //
    // Still routed through `manifest.load()` FIRST (not straight to
    // `loadManifestLenient`) -- round 5/F1's getter tests spy on
    // `ManifestManager.prototype.load` to hand `performUninstall` a
    // once-readable entry, and a direct `loadManifestLenient(manifest.path)`
    // call would bypass that spy entirely, reading the real (unrelated) file
    // on disk instead. Only when `manifest.load()` itself throws ADR-171's
    // `ManifestUnwritableError` do we fall back to the lenient wrapper, which
    // never throws; `manifestDegradedWarning` is then non-null (the three
    // states `loadManifestForWrite` refuses on: corrupt / unreadable /
    // version_unsupported). Part B, below -- after every identity check above
    // has run -- is where a non-null warning actually becomes a refusal,
    // gated on `force`. Any OTHER thrown error is a genuine bug, not a
    // classified read state, and still propagates to the outer catch exactly
    // as it always has.
    let manifestData: SkillManifest
    let manifestDegradedWarning: string | null = null
    try {
      manifestData = await manifest.load()
    } catch (err) {
      if (!(err instanceof ManifestUnwritableError)) throw err
      const lenient = await loadManifestLenient(manifest.path)
      manifestData = lenient.manifest
      manifestDegradedWarning = lenient.warning
    }
    let skillEntry = manifestData.installedSkills[manifestKey]
    let adopted = false
    let adoptedIdentity: DirIdentity | null = null

    if (!skillEntry) {
      const potentialPath = path.join(skillsDir, skillName)
      try {
        await fs.access(potentialPath)
      } catch (err) {
        // Round 25 (cross-model review): only absence means "not installed".
        // EACCES or EIO means we could not tell, and saying "not installed"
        // sends the user away from a skill that is still on disk. Round 26
        // (cross-model review): an error carrying no `code` at all is also
        // "could not tell", and the previous guard let it fall through to "not
        // installed" — the same false absence, one step further out. Only
        // ENOENT is absence now, and the thrown value is read null-safely.
        const code = (err as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOENT') {
          const detail = code ?? (err instanceof Error ? err.message : String(err))
          return {
            success: false,
            skillName,
            message:
              `Could not tell whether "${skillName}" is installed: ${potentialPath} could not be ` +
              `checked (${detail}). Nothing was removed.`,
            ...listenerWarning(),
          }
        }
        return {
          success: false,
          skillName,
          message: 'Skill "' + skillName + '" is not installed.',
          ...listenerWarning(),
        }
      }
      // Two halves of ONE rule: a name must not reach a directory past that
      // directory's own record, because adoption then backdates `installedAt` and
      // deletes without the modification check. F2 catches the CALLER holding the
      // alias, F-A the MANIFEST, by inode identity rather than a sixth string
      // rule. Both refuse before `potentialPath` is inspected or recorded.
      const exact = await checkExactEntryName(skillsDir, skillName)
      if (!exact.ok) {
        return { success: false, skillName, message: exact.message, ...listenerWarning() }
      }
      const elsewhere = await checkNotTrackedElsewhere(
        potentialPath,
        skillName,
        manifestData.installedSkills
      )
      if (!elsewhere.ok) {
        return { success: false, skillName, message: elsewhere.message, ...listenerWarning() }
      }
      adoptedIdentity = elsewhere.identity
      // SMI-6529 round 15: refuse a git working tree before adopting it, so a
      // refusal writes nothing to the manifest.
      const early = await inspectForRemoval(potentialPath)
      if ('refusal' in early) {
        return { success: false, skillName, message: early.refusal, ...listenerWarning() }
      }

      // ADR-139: a skill on disk with no manifest entry is ADOPTED rather than
      // requiring force just to remove it. Routed through the race-safe shared
      // {@link adoptUntrackedSkillEntry}, whose docblock carries the rationale.
      notify(
        onProgress,
        listenerProblems,
        'adopt',
        'Adopting untracked skill (no manifest entry found)'
      )
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
        return {
          success: false,
          skillName,
          message: adoptResult.adoptionError,
          ...listenerWarning(),
        }
      }
      skillEntry = adoptResult.entry
      adopted = adoptResult.adopted
    }

    // SMI-6732: the manifest is not a trusted input. Until this check the
    // uninstall path deleted whatever `installPath` named -- a folder outside
    // the skills dir, a RELATIVE path resolved against process.cwd(), or the
    // skills root itself -- and reported "uninstalled successfully" each time.
    // The absoluteness and containment rules already existed in
    // `skill-installation.target-guard.ts` for the WRITE path and were never
    // called here. `removeIfSame` cannot stand in for them: it verifies
    // IDENTITY ("I deleted the thing I inspected"), not AUTHORITY ("I was
    // allowed to delete it"), and knows nothing about `skillsDir`.
    // READ ONCE (round 5, F1). This and the read that fed `inspectForRemoval`
    // were two separate property accesses, so the guard validated read 1 while
    // the delete used read 2. Measured: a getter returning a benign path then a
    // hostile one deleted outside the tree, and returning the root deleted every
    // installed skill -- "uninstalled successfully" both times, force or not.
    // Unreachable from shipped callers (both parse their own manifest JSON),
    // which is why it survived five rounds. The hazard is the SPLIT, not the
    // caller: one read cannot disagree with itself.
    const installPath = skillEntry.installPath
    const allowed = await checkRemovalTarget(installPath, skillsDir)
    if (!allowed.ok) {
      return {
        success: false,
        skillName,
        message: `Skill "${skillName}" was not removed: ${allowed.reason}`,
        ...listenerWarning(),
      }
    }

    const seen = await inspectForRemoval(installPath)
    if ('refusal' in seen) {
      return { success: false, skillName, message: seen.refusal, ...listenerWarning() }
    }
    // Round 7 (F2): prove this is still the directory the guard identified.
    // `removeIfSame` anchors on `seen.stat`, which is read HERE -- after
    // adoption -- so a swap before this point was invisible to everything.
    const swapped = identityChanged(adoptedIdentity, seen.stat, skillName)
    if (swapped !== null) {
      return { success: false, skillName, message: swapped, ...listenerWarning() }
    }

    if (!force) {
      // ADR-171 § 5 retraction resolution, Part B: every identity/containment
      // check above has already had its chance to produce a MORE SPECIFIC
      // refusal (Part A) -- none did, or we would already have returned.
      // Without `force`, a manifest read this client could not verify still
      // refuses here, per ADR-171: proceeding to remove anything on the
      // strength of a degraded read is exactly what `force` exists to
      // authorize explicitly. This never fires when the read was `ok` or
      // `missing` (`manifestDegradedWarning` is `null` on both).
      if (manifestDegradedWarning !== null) {
        return {
          success: false,
          skillName,
          message:
            `Skill "${skillName}" was not removed: ${manifestDegradedWarning} Use force=true to ` +
            `remove anyway.`,
          ...listenerWarning(),
        }
      }
      notify(onProgress, listenerProblems, 'check', 'Checking for modifications')
      const modified = await checkForModifications(installPath, skillEntry.installedAt)
      if (modified) {
        return {
          success: false,
          skillName,
          message:
            'Skill "' +
            skillName +
            '" has been modified since installation. Use force=true to remove anyway.',
          warning: ['Local modifications will be lost if you force uninstall.', ...listenerProblems]
            .join(' ')
            .trim(),
        }
      }
    }

    notify(onProgress, listenerProblems, 'remove', 'Removing skill directory')
    // SMI-6529 round 15 (cross-model review, Critical): remove only the entry
    // checked above. Anything another program put there since is left in
    // place, and so is the manifest entry, so the user can retry.
    if (seen.stat !== null) {
      const removal = await removeIfSame(installPath, seen.stat)
      if (!removal.removed) {
        const parked = [...(await parkedWarnings(installPath)), ...listenerProblems]
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
          ...(parked.length > 0 && { warning: parked.join(' ') }),
        }
      }
    }

    try {
      skillDependencyRepo.clearAll(skillEntry.id)
    } catch {
      // Table may not exist pre-migration
    }

    notify(onProgress, listenerProblems, 'manifest', 'Updating manifest')
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
        // Round 17 (cross-model review): a reinstall can land at the SAME
        // path, so the path alone does not identify the generation just
        // removed — and comparing paths alone also keeps a stale record
        // forever whenever the spelling differs (a case-insensitive volume, a
        // symlinked parent). Round 18: the whole record identifies it.
        const describesWhatWasRemoved = entry === undefined || sameRecord(entry, skillEntry)
        if (!describesWhatWasRemoved) {
          claimedByAnotherInstall = true
          return current
        }
        const next: typeof current = { ...current, installedSkills: { ...current.installedSkills } }
        delete next.installedSkills[manifestKey]
        return next
      })
    } catch (error) {
      const parked = [...(await parkedWarnings(installPath)), ...listenerProblems]
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
          '). Its folder is already gone; run the same remove again once that file is writable, ' +
          'which acts on whatever that record names at the time.',
        ...(parked.length > 0 && { warning: parked.join(' ') }),
      }
    }

    notify(onProgress, listenerProblems, 'done', 'Uninstall complete')
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
      ...(await parkedWarnings(installPath)),
      ...listenerProblems,
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
      ...listenerWarning(),
    }
  }
}
