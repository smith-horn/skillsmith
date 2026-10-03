/**
 * @fileoverview Helpers for `performUninstall`: what it found before removing,
 *   progress reporting that cannot change the outcome, record comparison, the
 *   parked-leftover warnings, and untracked-skill adoption (ADR-139 / ADR-171
 *   § 5 retraction, SMI-6732/SMI-6733).
 * @module @skillsmith/core/services/skill-installation.uninstall.helpers
 *
 * Split out of `skill-installation.uninstall.ts` in SMI-6529 round 25, when
 * that file reached 504 lines against the 500-line standard — the same
 * sibling-split convention as `skill-installation.io.ts`. `buildAdoptedManifestEntry`
 * and `adoptUntrackedSkillEntry` joined this file for the same reason (ADR-171
 * § 5 retraction resolution): adding the ordering fix to
 * `skill-installation.uninstall.ts` in place would have pushed it back over
 * the limit. Both are re-exported from `skill-installation.uninstall.ts` (and
 * from there, `@skillsmith/core`'s public export surface) so their move
 * changes no import path outside this pair of files.
 *
 * SMI-6733 Phase 1: the tolerant-write primitive that used to live here as a
 * standalone `updateManifestTolerantly()` helper is now
 * {@link ManifestManager.updateSafely}'s own `{ tolerant: true }` option
 * (`skill-manifest.ts`) — a dependency-injection fix. The standalone helper
 * took `manifest.path` and called `manifest.save()` directly, so it wrote
 * "around" whatever `ManifestManager`-shaped object a caller injected;
 * `adoptUntrackedSkillEntry`'s own write never went through an injected
 * double's `updateSafely()`, which meant a test double built to intercept
 * that call — to assert on what it receives, or to throw — was silently
 * routed around it.
 */

import type { BigIntStats } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'

import { checkGitAtRoot } from '../install/fan-out.overwrite.js'
import { listParkedLeftovers, parkedLeftoverWarning } from '../install/remove-if-same.js'
import { hashContent } from './skill-installation.helpers.js'
import { installedSkillsOf, type ManifestManager } from './skill-manifest.js'
import { ManifestUnwritableError } from './skill-manifest.read-state.js'
import type { ProgressCallback, SkillManifestEntry } from './skill-installation.types.js'

/**
 * {@link adoptUntrackedSkillEntry}'s optional sixth argument.
 *
 * `tolerateDegradedRead` (default `false`) authorizes adoption's manifest
 * WRITE to proceed over a manifest that failed ADR-171's read classification
 * — `corrupt`, `unreadable` or `version_unsupported` — substituting an empty
 * document for whatever that file still recorded. See
 * {@link adoptUntrackedSkillEntry}'s doc comment for why the default refuses
 * and which call site passes what.
 */
export interface AdoptUntrackedSkillOptions {
  tolerateDegradedRead?: boolean
}

/**
 * {@link adoptUntrackedSkillEntry}'s three outcomes. The middle one is new in
 * SMI-6733 and is the reason this is a named type rather than an inline
 * union: "the write was REFUSED because the manifest could not be read, and
 * nothing was written" is neither a success nor the same thing as "the write
 * was ATTEMPTED and failed", and collapsing it into either loses information
 * the caller needs.
 *
 * - `{ entry, adopted }` — the entry is now in the manifest, either because
 *   this call wrote it (`adopted: true`) or because a concurrent writer got
 *   a real one there first (`adopted: false`).
 * - `{ entry, adopted: false, adoptionRefusal }` — the manifest failed
 *   ADR-171's read classification and `tolerateDegradedRead` was not set, so
 *   nothing was written and the file is byte-identical. `entry` is the
 *   reconstructed record that WOULD have been adopted, returned so a caller
 *   whose more specific checks still need an entry can run them before
 *   deciding what to report; it is NOT persisted, and a caller that treats
 *   this as success will report a skill as tracked when it is not.
 * - `{ adoptionError }` — the write was attempted and failed (a lock
 *   timeout, an I/O error). ADR-139 point 1's failure contract.
 */
export type AdoptUntrackedSkillResult =
  | { entry: SkillManifestEntry; adopted: boolean }
  | { entry: SkillManifestEntry; adopted: false; adoptionRefusal: string }
  | { adoptionError: string }

/**
 * SMI-6529 round 15 (cross-model review, Critical): what uninstall found at
 * `installPath` before removing it. A folder with `.git` at its root is a git
 * working tree, which git owns (ADR-155), so it is refused with or without
 * `force`: deleting it would take unpushed commits and uncommitted edits with
 * it. A symlink or a file needs no such check, since removing it leaves what
 * it points at alone. Returns the entry's identity (null when nothing is
 * there), so the delete can confirm it is still the same entry.
 *
 * Round 8 (SMI-6732 C1): reads `{bigint: true}` -- a `number`-typed `st_ino`
 * has already lost precision above 2^53 on some filesystems (see
 * `skill-installation.removal-identity.ts`'s `DirIdentity` docblock), and
 * `performUninstall` feeds this same result into `identityChanged` and
 * `removeIfSame`'s own identity comparisons. Deliberately ONE lstat, not two
 * -- a split read between "what was inspected" and "what gets compared" was
 * the round-5 defect this guards against.
 */
export async function inspectForRemoval(
  installPath: string
): Promise<{ stat: BigIntStats | null } | { refusal: string }> {
  let stat: BigIntStats
  try {
    stat = await fs.lstat(installPath, { bigint: true })
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

/**
 * Report progress without letting a caller's listener change the outcome.
 * Round 18 (cross-model review): a listener that threw after the folder was
 * already removed reached the generic catch, which reported neither what had
 * been removed nor what was left parked.
 *
 * Round 28 (pre-merge gate, PR-07): the failure is still swallowed as far as
 * the uninstall's outcome goes — that part was deliberate and stays — but it
 * is no longer swallowed as far as the USER goes. It is pushed onto
 * `problems`, which the caller surfaces alongside its other warnings. An empty
 * catch here was the same "could not tell" silence this wave removed
 * everywhere else, in the one place that reports to the user for a living.
 */
export function notify(
  onProgress: ProgressCallback,
  problems: string[],
  ...args: Parameters<ProgressCallback>
): void {
  try {
    onProgress(...args)
  } catch (err) {
    const stage = String(args[0] ?? 'unknown')
    problems.push(
      `the progress listener threw while reporting the "${stage}" step ` +
        `(${err instanceof Error ? err.message : String(err)}); the uninstall itself was not ` +
        `affected.`
    )
  }
}

/**
 * Whether `entry` is still, field for field, the record this uninstall
 * loaded. Round 18 (cross-model review): timestamps alone are not a unique
 * generation token — two installs can share a millisecond, an older writer
 * can omit them, and a copied record keeps them — so every field has to
 * match. An install that claims the same name writes its own values, so any
 * difference means a different generation. A durable generation id belongs
 * with A1's manifest work (SMI-6531).
 */
export function sameRecord(entry: SkillManifestEntry, loaded: SkillManifestEntry): boolean {
  return stableJson(entry) === stableJson(loaded)
}

/**
 * JSON with every object's keys in a fixed order, so two records compare by
 * value. Round 19 (Opus): comparing field by field with `!==` was correct only
 * while every field is a string — one array or object field, written by a
 * newer version or another tool, would never compare equal, and the record
 * would be kept forever with a warning that says an install claimed the name.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : nested
  )
}

/**
 * Warnings naming anything an earlier removal left parked next to
 * `installPath`. Round 17 (cross-model review): every exit after the removal
 * reports these, not only the successful one.
 */
export async function parkedWarnings(installPath: string): Promise<string[]> {
  const scan = await listParkedLeftovers(installPath)
  const warnings = scan.parked.map(parkedLeftoverWarning)
  // Round 25 (cross-model review): say when the scan could not look at all.
  return scan.unreadable ? [...warnings, scan.unreadable] : warnings
}

/**
 * ADR-139 (SMI-6274 Wave 4): build a manifest entry for a skill found on
 * disk with no manifest record — "adoption." Every field is reconstructed
 * from what is directly observable on disk; fields that genuinely cannot
 * be recovered this way (the originating registry version/source) are
 * recorded as `'unknown'` rather than guessed, so a later `update` sees
 * `'unknown'` and falls through to confidence-gated source recovery
 * instead of silently trusting a wrong version (ADR-139 point 1).
 *
 * Exported (not just used by `performUninstall`) so `update`'s own
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
 * `performUninstall` (`skill-installation.uninstall.ts`, calls it directly)
 * and `getSkillDiff` (`packages/cli/src/commands/manage.update.ts`, via this
 * function's re-export at the `@skillsmith/core` package root). Round 3's
 * confirmation review found a CLI-package-local copy of this exact
 * race-safety logic (`manage.update.helpers.ts`'s now-removed
 * `adoptUntrackedSkill`) had drifted from `performUninstall`'s own
 * still-non-race-safe inline version — importing a CLI file into `core`
 * would be a layering violation, so the fix moves the ONE race-safe
 * implementation here, alongside `buildAdoptedManifestEntry`, instead
 * of maintaining two copies of the same logic.
 *
 * ADR-171 § 5 retraction: the write goes through
 * `manifest.updateSafely(updateFn, { tolerant })` — SMI-6733 Phase 1 moved
 * tolerance from a standalone helper that wrote "around" the injected
 * `ManifestManager` (calling `manifest.save()` directly, never
 * `manifest.updateSafely()`) to an OPTION on `updateSafely()` itself, so a
 * caller-injected double that intercepts `updateSafely` — to assert on what
 * it receives, or to throw — is never bypassed.
 *
 * **`tolerateDegradedRead` gates that option, and its default is `false`
 * (SMI-6733 CRITICAL 1 / CRITICAL 2).** A tolerant load substitutes an EMPTY
 * document for a manifest this process could not read, and the save that
 * follows writes that substitution over the original bytes — so an
 * unconditional `{ tolerant: true }` here silently destroyed whatever the
 * unreadable file still recorded. Measured, against a manifest whose
 * readable prefix recorded a real skill `beta` followed by trailing garbage:
 * the `beta` record was gone, the file grew from 344 to 410 bytes, and the
 * return value signalled nothing. An earlier revision of this comment called
 * that tolerance "unconditional regardless of `force`, the same relationship
 * ADR-139 already establishes, extended one step further" — that reasoning
 * does not hold, because ADR-139's decision is about not requiring `force`
 * to REMOVE an untracked skill, and says nothing about overwriting records
 * belonging to OTHER skills that this process never read.
 *
 * So the argument is explicit, and the two call sites answer it differently:
 *
 * - `performUninstall` (`skill-installation.uninstall.ts`) passes its own
 *   `force`. With `force`, the caller has explicitly authorized acting on a
 *   manifest this client could not verify — which is precisely what
 *   ADR-171 § 2's write/refuse policy reserves `force` for, and what
 *   `performUninstall`'s own Part B refusal already says in words ("Use
 *   force=true to remove anyway"). Without it, adoption refuses and the
 *   file is left byte-identical.
 * - `getSkillDiff` (`packages/cli/src/commands/manage.update.helpers.ts`)
 *   passes nothing, so it gets the default. `sklx update` has no `force`
 *   concept at all, so there is no point at which a user of that command
 *   authorizes overwriting an unreadable manifest — and it was the path on
 *   which the measurement above was taken.
 *
 * Note what is NOT gated: adoption still runs on a `missing` or `ok`
 * manifest without `force`, exactly as ADR-139 requires. Only the overwrite
 * of a manifest that failed to classify is gated.
 *
 * The `current.installedSkills[manifestKey]` check inside the callback is
 * still checked against the FRESH, lock-acquired state it's handed — never a
 * caller's own stale, unlocked read: if a real entry is already there by the
 * time the lock is held, that entry wins and the guessed one is discarded
 * entirely (never written) — a concurrent legitimate `install()` must never
 * be clobbered by a same-tick adoption's guess.
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
  manifest: ManifestManager,
  options?: AdoptUntrackedSkillOptions
): Promise<AdoptUntrackedSkillResult> {
  const adoptedEntry = await buildAdoptedManifestEntry(skillDirName, installPath)
  let resolvedEntry = adoptedEntry
  let adopted = true

  try {
    await manifest.updateSafely(
      (current) => {
        const existing = installedSkillsOf(current)[manifestKey]
        if (existing) {
          resolvedEntry = existing
          adopted = false
          return current
        }
        resolvedEntry = adoptedEntry
        adopted = true
        return {
          ...current,
          installedSkills: { ...installedSkillsOf(current), [manifestKey]: adoptedEntry },
        }
      },
      // `=== true` rather than a truthiness test: the default must be the
      // refusing one, and an `undefined` from a call site that has not been
      // updated must land there rather than anywhere else.
      { tolerant: options?.tolerateDegradedRead === true }
    )
  } catch (adoptError) {
    const detail =
      'Failed to adopt untracked skill "' +
      skillName +
      '" at ' +
      installPath +
      ' into manifest ' +
      manifest.path +
      ': ' +
      (adoptError instanceof Error ? adoptError.message : String(adoptError))
    // SMI-6733: a refusal is not an error. `ManifestUnwritableError` means the
    // strict load classified the manifest and declined to write — the file is
    // byte-identical and the reconstructed entry is still usable for the
    // caller's own more specific checks. Anything else really did fail
    // mid-write, so it keeps ADR-139 point 1's hard failure contract.
    if (adoptError instanceof ManifestUnwritableError) {
      return { entry: adoptedEntry, adopted: false, adoptionRefusal: detail }
    }
    return { adoptionError: detail }
  }

  return { entry: resolvedEntry, adopted }
}
