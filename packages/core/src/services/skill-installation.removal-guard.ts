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

import * as path from 'node:path'
import { resolveRealOrFallback } from './skill-installation.target-guard.js'

/** Why a removal was refused. Always names the offending path. */
export type RemovalTargetCheck = { ok: true; resolved: string } | { ok: false; reason: string }

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
    return {
      ok: false,
      reason:
        `the manifest entry has no usable installPath (got ${installPath === null ? 'null' : typeof installPath}), ` +
        `so there is nothing safe to remove. Run \`skillsmith doctor\` to repair the manifest entry.`,
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
  const parent = path.dirname(path.resolve(installPath))
  const base = path.basename(path.resolve(installPath))
  const realParent = await resolveRealOrFallback(parent)
  const root = await resolveRealOrFallback(skillsDir)

  // SHAPE S3 FIRST, so the user gets the message that actually explains it.
  // Ordering matters here, not just correctness: the parent check below also
  // refuses this path (the root's parent is outside the root), but it would say
  // "installPath is outside the skills directory" about a path that IS the
  // skills directory -- true by the rule, useless to read. Checking by value
  // first names the real problem.
  const resolvedEntry = path.join(realParent, base)
  if (resolvedEntry === root) {
    return {
      ok: false,
      reason:
        `the manifest entry's installPath resolves to the skills directory itself (${root}). ` +
        `Removing it would delete every installed skill, so nothing was removed.`,
    }
  }

  const parentIsRootOrInside = realParent === root || realParent.startsWith(root + path.sep)
  if (!parentIsRootOrInside) {
    return {
      ok: false,
      reason:
        `the manifest entry's installPath resolves into ${realParent}, which is outside the ` +
        `skills directory (${root}). Nothing was removed.`,
    }
  }

  return { ok: true, resolved: resolvedEntry }
}
