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
  // is splitting the canonical one -- and re-resolving would reintroduce the
  // second string this guard exists to avoid having.
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
