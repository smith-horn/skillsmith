/**
 * @module @skillsmith/core/services/skill-installation.removal-guard
 * @see SMI-6732
 *
 * MAY THIS PATH BE DELETED? A separate question from "may this path be
 * installed to", and until SMI-6732 nothing asked it.
 *
 * `performUninstall` read `installPath` straight out of manifest JSON and
 * handed it to `removeIfSame`. Measured, all with `force: true`, all returning
 * `success: true, "uninstalled successfully"`:
 *
 *   installPath = a sibling folder outside skillsDir   -> folder deleted
 *   installPath = "rel-target" (relative)              -> cwd/rel-target deleted
 *   installPath = skillsDir itself                     -> the whole skills root deleted
 *
 * The manifest is not a trusted input. The workspace-scoped one lives at
 * `<workspaceRoot>/.skillsmith/manifest.json` (`workspace-scope.ts`), inside the
 * project tree and not gitignored, so a cloned repository can carry an entry
 * naming any path on the machine. `SkillManifestEntry.installPath`'s own doc
 * comment already warns that runtime JSON may not match the declared type.
 *
 * WHY THIS IS NOT `checkInstallTarget`. That function answers the install
 * question and carries rules — git-worktree refusal, pre-existence, manifest
 * cross-checks — that are wrong or actively harmful on the removal path. Two
 * questions, two entry points, one shared resolution helper.
 *
 * WHY IT IS NOT A REUSE OF THE INSTALL-SIDE CONTAINMENT PREDICATE EITHER.
 * `isDirectoryOrDirSymlinkWithin` realpaths the ENTRY and accepts
 * `real === resolvedSkillsDir`. Both halves are wrong here:
 *
 *   - Realpathing the entry would refuse a symlinked skill directory, which is
 *     a normal development workflow and an existing tested behaviour. Removing
 *     a symlink removes the link, not its target, so it is safe.
 *   - Accepting equality with the root would permit shape S3 -- deleting the
 *     skills root, and every skill in it.
 *
 * So this checks the entry's PARENT through realpath and requires the entry to
 * be one segment inside a directory we own. See the comment at the check itself.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { resolveRealOrFallback } from './skill-installation.target-guard.js'

/**
 * Whether `s` reaches the filesystem as itself. Node encodes a path string as
 * UTF-8 and substitutes U+FFFD for an unpaired surrogate on the way, so such a
 * string names a DIFFERENT entry from the one it spells. Measured (round 5, F3):
 * removing a lone U+D800 deleted a directory named U+FFFD, on BOTH macOS and
 * Linux, through the tracked path as well as adoption.
 *
 * That is the same second string this file exists to refuse -- produced by the
 * encoder rather than by `path.resolve`. `String.prototype.isWellFormed` is the
 * same test but is ES2024, and this package compiles against ES2022.
 */
function survivesEncoding(s: string): boolean {
  return Buffer.from(s, 'utf8').toString('utf8') === s
}

/**
 * Why a removal was refused. Always names the offending path.
 *
 * m1: deliberately carries NO resolved path. An earlier version returned one and
 * the caller went on using the raw `installPath` anyway, which implies a
 * canonicalisation guarantee the code does not give -- the window between this
 * guard's realpath and the later `removeIfSame` cannot be closed without `*at`
 * syscalls, so a path resolved here is not necessarily the path removed.
 */
export type RemovalTargetCheck = { ok: true } | { ok: false; reason: string }

/**
 * MAY THIS NAME BE REMOVED? The caller-supplied name, before it is joined to
 * anything or used to look anything up.
 *
 * Two rules, and they close different holes.
 *
 * PATH SPELLINGS. `path.join(skillsDir, skillName)` normalizes while
 * `manifestKeyFor` keys on the raw string, so `./other-skill`,
 * `other-skill/.` and `x/../other-skill` reach a TRACKED skill's directory
 * without finding its entry -- adoption then runs, backdates `installedAt` so
 * the modification gate sees nothing, and deletes without `force`, where the
 * honest spelling is correctly refused.
 *
 * DOT-PREFIXED NAMES. Measured: `uninstall('.git')` with force NOT set returned
 * `success: true, "uninstalled successfully"` and deleted a git-versioned skills
 * directory's entire history. This file already refuses a target that HAS `.git`
 * at its root (ADR-155, git owns it) -- and accepted a target that IS `.git`.
 * The same principle, one level off.
 *
 * A dot-prefixed entry is never a skill: every enumerator skips them, so such a
 * directory is invisible to install, list and audit. Refusing to remove one
 * costs nothing that was reachable anyway, and `apply_manifest_reconcile`
 * remains available for a stale record.
 */
export function checkRemovableSkillName(skillName: string): RemovalTargetCheck {
  if (
    skillName.length === 0 ||
    skillName === '.' ||
    skillName === '..' ||
    skillName.includes('/') ||
    skillName.includes('\\')
  ) {
    return {
      ok: false,
      reason: `a skill name must be a single directory name, not a path. Nothing was removed.`,
    }
  }
  if (skillName.startsWith('.')) {
    return {
      ok: false,
      reason:
        `"${skillName}" is a dot-prefixed directory, which is never a skill -- every enumerator ` +
        `skips them, and this one may belong to git or another tool. Nothing was removed. ` +
        `Use \`apply_manifest_reconcile\` if a stale manifest record needs clearing.`,
    }
  }
  if (!survivesEncoding(skillName)) {
    return {
      ok: false,
      reason:
        `the name contains an unpaired surrogate, so it cannot name a directory: the ` +
        `filesystem call would substitute U+FFFD and act on a different name. Nothing was removed.`,
    }
  }
  return { ok: true }
}

/**
 * IS THIS NAME AN ENTRY OF `skillsDir`, SPELLED AS THE FILESYSTEM SPELLS IT?
 * Asked only on the adoption path, after `fs.access` has established that the
 * spelling resolves to something there.
 *
 * Round 5 (pre-merge gate, F2): a case- or normalization-insensitive volume
 * (APFS, HFS+) resolves the NFD spelling (e + U+0301) onto a directory named
 * with U+00E9, and `myskill` onto `MySkill`, while `manifestKeyFor` keys on the
 * raw string. So a second spelling of a TRACKED skill misses its manifest
 * record, is adopted as untracked, has `installedAt` backdated to its newest
 * mtime, and is deleted WITHOUT `force` -- the modification gate never sees it,
 * and the real record is left behind. Measured: the honest spelling was refused
 * ("modified since installation") while the NFD spelling reported
 * "uninstalled successfully" and destroyed the user's edits.
 *
 * This is round 2's B2 exactly -- `./x`, `x/.`, `a/../x` reaching a tracked
 * directory past its own record -- reopened by the volume instead of by
 * `path.join`.
 *
 * NO SECOND STRING. Normalizing or case-folding here would produce one, and
 * this file's rule is that the raw value must already BE the canonical one. So
 * the directory is asked how the entry is actually spelled and the caller must
 * have spelled it that way. On a strict volume every alias already fails
 * `fs.access` with ENOENT, so this makes the platforms agree rather than adding
 * a macOS-only rule.
 *
 * Failure follows the convention `performUninstall` set in rounds 25/26: only
 * ENOENT is absence; anything else, including an error carrying no `code`, is
 * "could not tell", said in those words. Nothing is removed either way.
 */
export async function checkExactEntryName(
  skillsDir: string,
  skillName: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  let entries: string[]
  try {
    entries = await fs.readdir(skillsDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') {
      return { ok: false, message: `Skill "${skillName}" is not installed.` }
    }
    const detail = code ?? (err instanceof Error ? err.message : String(err))
    return {
      ok: false,
      message:
        `Could not tell whether "${skillName}" is installed: ${skillsDir} could not be ` +
        `listed (${detail}). Nothing was removed.`,
    }
  }
  if (entries.includes(skillName)) return { ok: true }
  // Round 6 (F-D): "list the directory and retry" recovers a CASE alias, because the
  // listing shows the stored case and it can be retyped. It cannot recover a
  // NORMALIZATION alias: the two spellings are visually identical and a keyboard
  // produces NFC, so an NFD-stored name is reachable only by copying the listed
  // text. On HFS+ every non-ASCII name is stored NFD, so say "copy", not "retry".
  return {
    ok: false,
    message:
      `Skill "${skillName}" was not removed: no entry in ${skillsDir} is spelled exactly ` +
      `that way, although this volume resolves the spelling to one (it matches by case or ` +
      `by Unicode normalization). Skillsmith removes a directory only under its exact name, ` +
      `so that a name cannot reach a directory past that directory's own manifest record ` +
      `and its modification check. List ${skillsDir} and COPY the name from the listing — ` +
      `retyping it may reproduce the same alias, since two spellings can look identical.`,
  }
}

/**
 * Decides whether `installPath` is a path this uninstall is allowed to destroy.
 *
 * Fails CLOSED: anything that cannot be shown to be strictly inside `skillsDir`
 * is refused, including a value that is not a string at all. The caller removes
 * nothing and reports the reason.
 *
 * @param installPath the manifest's claim — deliberately typed `unknown`,
 *   because the whole point is that it arrives from JSON and may be anything
 * @param skillsDir the root this uninstall is scoped to
 */
export async function checkRemovalTarget(
  installPath: unknown,
  skillsDir: string
): Promise<RemovalTargetCheck> {
  if (typeof installPath !== 'string' || installPath.length === 0) {
    // M2: the first version pointed at `skillsmith doctor`, which does not
    // exist (grep over cli/mcp-server/core src finds no such command). The
    // install-side twin points at `apply_manifest_reconcile`, whose `drop_entry`
    // is documented for exactly this -- a stale entry whose path no longer
    // resolves. It also reported an empty string as "got string", which is true
    // and useless.
    const got =
      installPath === null
        ? 'null'
        : typeof installPath === 'string'
          ? 'an empty string'
          : typeof installPath
    return {
      ok: false,
      reason:
        `the manifest entry has no usable installPath (got ${got}), so there is nothing safe ` +
        `to remove. Repair the entry with the \`apply_manifest_reconcile\` tool ` +
        `(\`drop_entry\` removes a stale record whose install path no longer resolves).`,
    }
  }

  // Round 5 (F3, the manifest-side twin of the name rule above): a lone
  // surrogate in `installPath` reaches the filesystem as U+FFFD, so the path
  // checked here and the path removed would differ -- the same second string
  // the canonical-form check below refuses, produced by the encoder rather than
  // by `resolve`. Measured deleting a U+FFFD directory on macOS AND Linux.
  if (!survivesEncoding(installPath)) {
    return {
      ok: false,
      reason:
        `the manifest entry's installPath contains an unpaired surrogate, which the ` +
        `filesystem call would replace with U+FFFD, so the path checked and the path removed ` +
        `would differ. It is refused rather than substituted. Nothing was removed.`,
    }
  }

  // A relative path would be resolved against process.cwd() further down,
  // deleting something in whatever directory the user happened to run from.
  if (!path.isAbsolute(installPath)) {
    return {
      ok: false,
      reason:
        `the manifest entry's installPath "${installPath}" is not absolute. ` +
        `A relative path would resolve against the current directory rather than ` +
        `the skills directory, so nothing was removed.`,
    }
  }

  // WHY THE PARENT, NOT THE ENTRY. Resolving `installPath` itself through
  // realpath would refuse a SYMLINKED skill directory -- `~/.claude/skills/foo`
  // pointing at a checkout elsewhere -- which is a normal way to develop a skill
  // in place, is an existing tested behaviour ("removes a symlinked skill and
  // leaves the clone it points at alone"), and is SAFE: removing a symlink
  // removes the link, never its target.
  //
  // Lexical containment alone is not enough either. `skillsDir/p/child`, where
  // `p` is a symlink pointing outside, is lexically inside while the delete
  // lands outside.
  //
  // So: resolve the PARENT through realpath and require it to be `skillsDir` or
  // strictly inside it, and require the entry to be a single segment of that
  // parent. The entry may then be anything -- directory, symlink -- because
  // whatever it is, it lives in a directory we own.
  // CANONICAL FORM IS REQUIRED, NOT PRODUCED. This is the fix for two BLOCKING
  // bypasses found by the pre-merge gate, and it replaces a normalize-then-trust
  // design that was wrong in principle.
  //
  // The earlier version validated `path.resolve(installPath)` while
  // `performUninstall` went on to delete the RAW string. `path.resolve` is
  // LEXICAL: it collapses `seg/..` before any symlink in `seg` is resolved, and
  // it strips trailing slashes. The kernel does neither. So the guard approved
  // one path and the filesystem removed another. Both measured on macOS, both
  // `force: true`, both reporting "uninstalled successfully":
  //
  //   <skillsDir>/hop/../victim   (hop is a symlink out of the tree)
  //     guard validated  <skillsDir>/victim      -> ok
  //     kernel deleted   <realBase>/victim       -> OUTSIDE the skills dir
  //
  //   <skillsDir>/link/           (trailing slash, link -> a checkout outside)
  //     guard validated  <skillsDir>/link        -> ok
  //     lstat("<...>/link/").isSymbolicLink() === FALSE, so removal followed the
  //     link and deleted the CHECKOUT
  //
  // The second one falsifies this guard's own former design claim -- "removing a
  // symlink removes the link, never its target". With a trailing slash on macOS
  // it removes the target. That claim was the stated reason for checking the
  // parent rather than the entry, so it could not be patched around.
  //
  // An earlier comment here dismissed the resolve-vs-delete divergence as an
  // unavoidable TOCTOU *race*. It is not a race. It is deterministic and needs
  // no concurrent writer at all.
  //
  // THE FIX IS TO REMOVE THE GAP RATHER THAN TO OUT-THINK IT. A normalization
  // step creates a second string, and every such step is a chance for the
  // validated string and the deleted string to differ. So the raw value must
  // ALREADY equal its own normalization; if it does not, it is refused. There is
  // then no second string to diverge, and the path the caller deletes is
  // by construction the path this function approved.
  //
  // This over-refuses nothing: every writer records `path.join(skillsDir, name)`,
  // and `path.join` returns a normalized path.
  if (path.resolve(installPath) !== installPath) {
    return {
      ok: false,
      reason:
        `the manifest entry's installPath "${installPath}" is not in canonical form ` +
        `(it normalizes to "${path.resolve(installPath)}"). A path containing "." or ".." ` +
        `segments, a trailing slash, or a doubled separator is resolved differently by this ` +
        `check than by the filesystem, so it is refused rather than normalized. Nothing was ` +
        `removed.`,
    }
  }

  // No normalization here, deliberately. The check above has already established
  // that `installPath` equals its own `path.resolve`, so splitting the raw value
  // is splitting the canonical one. Re-adding a resolve here would be a provable
  // no-op rather than a bug -- an earlier version of this comment claimed it
  // would "reintroduce the second string", which overstates it: a mutant that
  // re-adds it survives every test, which is the signature of an equivalent
  // mutant, not of an untested hazard. It is omitted because it is dead, not
  // because it is dangerous.
  const parent = path.dirname(installPath)
  const base = path.basename(installPath)
  const realParent = await resolveRealOrFallback(parent)
  const root = await resolveRealOrFallback(skillsDir)

  // SHAPE S3 FIRST, so the user gets the message that actually explains it.
  // Ordering matters here, not just correctness: the parent check below also
  // refuses this path (the root's parent is outside the root), but it would say
  // "installPath is outside the skills directory" about a path that IS the
  // skills directory -- true by the rule, useless to read. Checking by value
  // first names the real problem.
  if (path.join(realParent, base) === root) {
    return {
      ok: false,
      reason:
        `the manifest entry's installPath resolves to the skills directory itself (${root}). ` +
        `Removing it would delete every installed skill, so nothing was removed.`,
    }
  }

  // B1 (adversarial review of the first fix): this accepted ANY depth under the
  // root, and depth is what defeats the git-worktree refusal. `checkGitAtRoot`
  // looks for `.git` at the TARGET only, never at an ancestor -- so with a
  // nested entry the manifest this guard exists to distrust could name
  // `<skillsDir>/clone-skill/src` (deleting uncommitted work) or
  // `<skillsDir>/clone-skill/.git` (deleting the history, leaving SKILL.md), and
  // both returned "uninstalled successfully". SMI-6529 round 15, defeated from
  // one segment deeper.
  //
  // Nothing legitimate nests. Every writer records `path.join(skillsDir, <one
  // segment>)`, `skillNameFromSkillId` rejects empty/`.`/`..`, `mark_local`
  // spreads the existing entry and `relink` never sets a new installPath. So the
  // parent must be the root EXACTLY.
  if (realParent !== root) {
    return {
      ok: false,
      reason:
        `the manifest entry's installPath resolves into ${realParent}, which is not directly ` +
        `inside the skills directory (${root}). Skillsmith only removes entries it installed ` +
        `there, one level down. Nothing was removed.`,
    }
  }

  return { ok: true }
}
