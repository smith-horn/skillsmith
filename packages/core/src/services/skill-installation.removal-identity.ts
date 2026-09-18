/**
 * @module @skillsmith/core/services/skill-installation.removal-identity
 * @see SMI-6732
 *
 * WHICH DIRECTORY IS THIS? A different question from "may this name be
 * removed", which is `skill-installation.removal-guard.ts`'s job, and the
 * reason this is a separate module rather than more of that one.
 *
 * Rounds 2-6 each closed one SPELLING through which a name could reach a
 * directory past that directory's own manifest record -- `./x`, `seg/..`, a
 * trailing slash, a dot-prefix, a case alias, a normalization alias. Every fix
 * was a new string rule, and every following round found a new string. The
 * answer is to stop comparing strings: `dev`/`ino` is what the kernel itself
 * uses to decide whether two names are one directory, and it cannot be aliased
 * by case, normalization, encoding, or a spelling nobody has invented yet.
 */

import * as fs from 'node:fs/promises'

/** A directory as the KERNEL identifies it — immune to every spelling of its name. */
export type DirIdentity = { dev: number; ino: number }

/**
 * IS THIS DIRECTORY ALREADY TRACKED UNDER SOME OTHER NAME? Asked on the adoption
 * path, immediately before a directory would be adopted as untracked.
 *
 * Round 6 (pre-merge gate, F-A) — the same mechanism as `checkExactEntryName`,
 * entered from the opposite side. That function anchors on the DISK spelling, so
 * it is satisfied whenever the caller typed what the filesystem stores. It says
 * nothing about the case where the MANIFEST holds the alias instead. Measured on
 * APFS, `force` NOT set:
 *
 *   disk `myskill` (modified now) / manifest key `MySkill` (installedAt 2020)
 *     uninstall("MySkill") -> refused, "modified since installation"  dir survives
 *     uninstall("myskill") -> "uninstalled successfully"              DIR DELETED
 *
 *   disk NFD `café` / manifest key NFC `café`  -- identical outcome
 *
 * The honest spelling is correctly gated and the disk spelling destroys the work.
 *
 * WHY IDENTITY RATHER THAN A SIXTH STRING RULE. Five rounds closed five string
 * vectors of ONE mechanism -- a name reaching a directory past that directory's
 * own record: `./x` and `x/.` (round 2), `seg/..` and a trailing slash (round 3),
 * a dot-prefix (round 4), case and Unicode normalization (round 5), and now the
 * manifest-side alias. Every one was a new way for two strings to name one
 * directory, so every string rule is a patch on the instance a reviewer happened
 * to name. `dev`/`ino` is what the kernel uses to decide identity: it cannot be
 * aliased by case, by normalization, by encoding, or by any spelling not yet
 * invented. This closes the class.
 *
 * Symlinks compare by `lstat`, deliberately: two symlinks pointing at one target
 * are two distinct directory entries and must stay independently removable --
 * an existing tested behaviour.
 *
 * An entry whose `installPath` cannot be `lstat`ed is skipped rather than
 * refused: a record pointing at something absent cannot be the directory we are
 * standing on, and refusing on it would make one stale record block every
 * adoption in the tree.
 *
 * Shares `checkExactEntryName`'s result shape so the call site treats both the
 * same way.
 */
export async function checkNotTrackedElsewhere(
  potentialPath: string,
  skillName: string,
  installedSkills: unknown
): Promise<{ ok: true; identity: DirIdentity | null } | { ok: false; message: string }> {
  if (typeof installedSkills !== 'object' || installedSkills === null) {
    return { ok: true, identity: null }
  }
  let target: Awaited<ReturnType<typeof fs.lstat>>
  try {
    target = await fs.lstat(potentialPath)
  } catch (err) {
    // Round 7 (F1): ONLY ENOENT is absence. The first version treated every
    // error as "nothing here", which is fail-OPEN under a transient fault --
    // measured: an EACCES that cleared before `inspectForRemoval`'s own lstat
    // (the very next call on the same path) let a tracked, modified skill be
    // adopted and deleted WITHOUT `force`, reported as success. "A later guard
    // catches it" held only for a PERSISTENT fault. This is the convention
    // `checkExactEntryName` above already states; this function had drifted
    // from it.
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return { ok: true, identity: null }
    const detail = code ?? (err instanceof Error ? err.message : String(err))
    return {
      ok: false,
      message:
        `Could not tell whether "${skillName}" is already tracked under another name: ` +
        `${potentialPath} could not be checked (${detail}). Nothing was removed.`,
    }
  }
  for (const [key, entry] of Object.entries(installedSkills as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const recorded = (entry as { installPath?: unknown }).installPath
    if (typeof recorded !== 'string' || recorded.length === 0) continue
    let seen: Awaited<ReturnType<typeof fs.lstat>>
    try {
      seen = await fs.lstat(recorded)
    } catch (err) {
      // Same rule, other side: a record whose path is GONE cannot be this
      // directory, so skip it. Any other error means we could not tell, and
      // skipping it would silently narrow the scan the guard depends on.
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
      return {
        ok: false,
        message:
          `Could not tell whether "${skillName}" is already tracked under another name: ` +
          `the record "${key}" points at a path that could not be checked. Nothing was removed.`,
      }
    }
    if (seen.dev !== target.dev || seen.ino !== target.ino) continue
    return {
      ok: false,
      message:
        `Skill "${skillName}" was not removed: that directory is already tracked under the ` +
        `name "${key}". Remove it under that name, so that its modification check applies. ` +
        `Nothing was removed.`,
    }
  }
  return { ok: true, identity: { dev: target.dev, ino: target.ino } }
}

/**
 * Round 7 (F2): the identity the guard saw, so a later step can prove it is
 * still acting on THAT directory.
 *
 * The round-6 commit claimed a mid-window swap "yields a refusal, because
 * `removeIfSame` compares identity at delete time". **That was false.** The
 * identity `removeIfSame` compares is captured by the SECOND `inspectForRemoval`,
 * *after* adoption; the guard's own reading was compared to nothing. Measured: a
 * concurrent rename during the guard's scan put a tracked, modified skill where
 * an untracked one had been, and it was deleted with "uninstalled successfully".
 *
 * So the identity is threaded forward instead. `null` means the guard never
 * established one (no manifest object, or the path was absent), in which case
 * there is nothing to contradict and the later check is skipped.
 *
 * @returns a refusal message when the directory changed under us, else null
 */
export function identityChanged(
  before: DirIdentity | null,
  after: { dev: number; ino: number } | null,
  skillName: string
): string | null {
  if (before === null || after === null) return null
  if (after.dev === before.dev && after.ino === before.ino) return null
  return (
    `Skill "${skillName}" was not removed: ${skillName} was replaced by a different ` +
    `directory while it was being checked, so what would have been deleted is not what ` +
    `was inspected. Nothing was removed; try again.`
  )
}
