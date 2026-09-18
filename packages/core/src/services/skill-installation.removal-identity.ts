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
 *
 * Round 8: `dev`/`ino` alone is not sound everywhere either -- see
 * {@link DirIdentity} and {@link identityChanged} for the two gaps it closes.
 */

import * as fs from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'

/**
 * A directory as the KERNEL identifies it -- immune to every spelling of its
 * name.
 *
 * Round 8 (C1): `dev`/`ino` are read as `bigint` (`fs.lstat(path, {bigint:
 * true})`), never `number`. Node's non-bigint `Stats` reports `st_ino` as a
 * JS `double` (`static_cast<double>` in `FillStatsArray`), which has already
 * lost precision above 2^53 -- measured:
 * `Number((35n<<48n)|90356n) === Number((35n<<48n)|90357n)` is `true`. On
 * NTFS, whose 8-byte file reference packs a 16-bit MFT reuse-sequence into
 * its top bits, 32 reuses of one MFT record crosses that boundary, and
 * nodejs/node#12115 reports two real, distinct files sharing `ino`
 * 9851624184963316 live. A `number`-typed comparison would silently treat
 * two different files as one; widening a value already read as a `number`
 * back to `BigInt` cannot recover the lost bits, so every comparison has to
 * be done in `bigint` from the start.
 *
 * Round 8 (C4): `birthtimeNs` guards a second, unrelated gap. ext4 reuses a
 * freed inode number immediately -- measured: 400 same-name mkdir/rmdir
 * cycles on ext4 container `/tmp` produced only 2 distinct `st_ino` values,
 * versus 400 on APFS -- so `dev`/`ino` alone cannot tell a directory from its
 * own just-recreated replacement on that filesystem. See
 * {@link identityChanged} for how the two fields are combined, and where the
 * comparison degrades when a filesystem doesn't report a birthtime at all.
 */
export type DirIdentity = { dev: bigint; ino: bigint; birthtimeNs: bigint }

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
 * to name. `dev`/`ino` closes the SPELLING class -- it cannot be aliased by
 * case, by normalization, by encoding, or by any spelling not yet invented.
 *
 * It is not, though, identity the way the kernel holds it in memory: `st_ino`
 * is an EXPORTED number, and filesystems differ in what they export. ext4
 * recycles a freed inode number immediately; NTFS's 8-byte file reference
 * loses precision once widened to the `number` a non-bigint `fs.Stats`
 * reports it as; some filesystems (network mounts, FUSE) synthesise `st_ino`
 * outright and offer no such guarantee at all. Round 8 closes the first two
 * of those -- `birthtimeNs` (see {@link identityChanged}) for the first,
 * reading both sides as `bigint` (see {@link DirIdentity}) for the second --
 * leaving the third with no general fix here.
 *
 * Symlinks compare by `lstat`, deliberately: two symlinks pointing at one
 * target are two distinct directory entries and must stay independently
 * removable -- an existing tested behaviour.
 *
 * An entry whose `installPath` cannot be `lstat`ed because it is simply GONE
 * (ENOENT) is skipped: a stale record cannot be the directory we are
 * standing on, and refusing on every stale record would block every
 * adoption in the tree behind whichever one happened to go stale first. Any
 * OTHER `lstat` failure -- permission denied, an unreadable parent, an I/O
 * error -- is refused instead: we cannot tell what a record we cannot check
 * points at, and skipping it would silently narrow the very scan this guard
 * exists to run. (`apply_manifest_reconcile`'s `drop_entry` action makes the
 * opposite choice for a stat failure on ITS OWN target, deliberately -- see
 * the cross-reference comment on `assertDropTargetNoLongerResolves`,
 * `apply-manifest-reconcile.helpers.ts`.)
 *
 * Shares `checkExactEntryName`'s result shape so the call site treats both the
 * same way.
 */
export async function checkNotTrackedElsewhere(
  potentialPath: string,
  skillName: string,
  installedSkills: unknown
): Promise<{ ok: true; identity: DirIdentity | null } | { ok: false; message: string }> {
  let target: BigIntStats
  try {
    target = await fs.lstat(potentialPath, { bigint: true })
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
  // Round 8 (C3): a zero `ino` means identity could not be established at
  // all, not that it was established as "no matches" -- every record would
  // compare equal to it (or none would, depending on how a scan happened to
  // walk), and either way naming a record in a refusal, or proceeding as
  // untracked, would be actively misleading about what was actually checked.
  // Same convention as the ENOENT branch above: fail closed rather than guess.
  if (target.ino === 0n) {
    return {
      ok: false,
      message:
        `Could not tell whether "${skillName}" is already tracked under another name: ` +
        `identity could not be established for ${potentialPath} (its inode reports as 0). ` +
        `Nothing was removed.`,
    }
  }
  const identity: DirIdentity = {
    dev: target.dev,
    ino: target.ino,
    birthtimeNs: target.birthtimeNs,
  }
  if (typeof installedSkills !== 'object' || installedSkills === null) {
    // Round 8 (C2): `potentialPath` is already known to exist -- the caller
    // confirmed that with `fs.access` before this was ever reached -- so
    // identity CAN be established here even with no manifest object to scan.
    // Only the record scan below is skipped, since there are no records to
    // scan against. (`typeof [] === 'object'`, so an array reaches the scan
    // below same as before; only a string/number/boolean lands here --
    // `null`/`undefined` are rejected earlier, at the call site.)
    return { ok: true, identity }
  }
  for (const [key, entry] of Object.entries(installedSkills as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const recorded = (entry as { installPath?: unknown }).installPath
    if (typeof recorded !== 'string' || recorded.length === 0) continue
    let seen: BigIntStats
    try {
      seen = await fs.lstat(recorded, { bigint: true })
    } catch (err) {
      // Same rule, other side: a record whose path is GONE cannot be this
      // directory, so skip it. Any other error means we could not tell, and
      // skipping it would silently narrow the scan the guard depends on.
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') continue
      const detail = code ?? (err instanceof Error ? err.message : String(err))
      // Manifest keys are `name` or `name::client` (`manifestKeyFor`) -- the
      // client half is an implementation detail, not something a user typed,
      // so it is split out rather than printed raw.
      const recordName = key.includes('::') ? key.slice(0, key.indexOf('::')) : key
      return {
        ok: false,
        message:
          `Could not tell whether "${skillName}" is already tracked under another name: ` +
          `the record "${recordName}" points at ${recorded}, which could not be checked ` +
          `(${detail}). If that record is stale, use apply_manifest_reconcile's drop_entry ` +
          `action to remove it. Nothing was removed.`,
      }
    }
    if (seen.dev !== target.dev || seen.ino !== target.ino) continue
    return {
      ok: false,
      message:
        `Skill "${skillName}" was not removed: it is already tracked under the name "${key}" ` +
        `-- the same directory, or the same hardlinked file. Remove it under that name, so that ` +
        `its modification check applies. Nothing was removed.`,
    }
  }
  return { ok: true, identity }
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
 * Round 8 (C4): `dev`/`ino` matching is not sufficient on a filesystem that
 * reuses a freed inode number immediately (ext4 -- see {@link DirIdentity}),
 * so a THIRD check is folded in: `birthtimeNs` must also agree, but only
 * when BOTH sides report a non-zero one. `0n` means this filesystem doesn't
 * expose a birthtime at all (not universal), and the comparison degrades to
 * exactly the `dev`/`ino` check it had before -- deliberately never used in
 * `checkNotTrackedElsewhere`'s own record scan above, where two DIFFERENT
 * records legitimately naming the SAME directory share one birthtime and a
 * birthtime mismatch there would mean nothing.
 *
 * THIS NARROWS THE ext4 GAP; IT DOES NOT CLOSE IT. Stated plainly because
 * three claims on this issue have already been published stronger than what
 * was measured. A recreate that lands inside the birthtime's own resolution
 * reports an IDENTICAL `birthtimeNs`, and on ext4 that is the common case, not
 * the rare one -- measured, 200 delete/recreate cycles on container `/tmp`:
 *
 *     inode reused (dev/ino blind)    200 / 200
 *       birthtime differed (caught)    36
 *       birthtime identical (MISSED)  164   -> 18% detection
 *
 * So a directory deleted and recreated inside the guard's window is still
 * deleted roughly four times in five on ext4. The residual is bounded -- the
 * victim is a directory that appeared DURING the window, so the loss is
 * another writer's brand-new work rather than the user's tracked skill -- and
 * closing it properly needs an identity the filesystem cannot recycle (a
 * generation token recorded in the manifest, SMI-6531), not a fourth stat
 * field.
 *
 * @returns a refusal message when the directory changed under us, else null
 */
export function identityChanged(
  before: DirIdentity | null,
  after: { dev: bigint; ino: bigint; birthtimeNs: bigint } | null,
  skillName: string
): string | null {
  if (before === null || after === null) return null
  const devInoChanged = after.dev !== before.dev || after.ino !== before.ino
  const birthtimeChanged =
    before.birthtimeNs !== 0n &&
    after.birthtimeNs !== 0n &&
    before.birthtimeNs !== after.birthtimeNs
  if (!devInoChanged && !birthtimeChanged) return null
  return (
    `Skill "${skillName}" was not removed: ${skillName} was replaced by a different ` +
    `directory while it was being checked, so what would have been deleted is not what ` +
    `was inspected. Nothing was removed; try again.`
  )
}
