/**
 * @fileoverview Shared realpath-containment predicate.
 * @module @skillsmith/core/services/skill-installation.realpath-containment
 * @see SMI-6532 (round following A0.6) — extracted so this comparison is
 *   written and tested exactly once.
 *
 * `skill-installation.target-guard.ts`'s rule (c) (`isUsableDirectory`) is a
 * CONJUNCTION: a symlinked install target is usable only when it follows to a
 * directory AND that directory's realpath resolves inside `skillsDir`. A
 * prior fix to `update-target.probe.ts`'s `checkPresence` reimplemented only
 * the FIRST half of that conjunction (follows to a directory) and called
 * `hasGitAncestorBetween` anyway — a function whose own doc comment states
 * the SECOND half (realpath containment) as a precondition it assumes, not
 * one it verifies. Copying the missing half inline would have left two
 * hand-maintained copies of one rule, inviting the exact same split-in-half
 * bug a third time. This module is the single copy: both `isUsableDirectory`
 * and the probe call it, instead of each recomputing the comparison.
 */

import * as fs from 'fs/promises'
import * as path from 'path'

/** `fs.realpath`, falling back to a lexical `path.resolve` when the path can't be resolved
 * (e.g. it doesn't exist, or a component was removed mid-check) — never throws. */
export async function resolveRealOrFallback(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * Does `target`'s realpath sit at or inside `root`'s realpath? Resolves BOTH
 * sides through the identical {@link resolveRealOrFallback} helper — never a
 * raw `fs.realpath` on one side and a fallback-guarded resolve on the other
 * (SMI-4758) — asymmetric resolution is itself the bug class this comparison
 * exists to avoid, not merely a lint-satisfying detail.
 */
export async function isRealpathInside(target: string, root: string): Promise<boolean> {
  const realTarget = await resolveRealOrFallback(target)
  const realRoot = await resolveRealOrFallback(root)
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)
}
