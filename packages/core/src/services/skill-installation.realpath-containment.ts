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
 * bug a third time then; `isUsableDirectory` is the one caller of
 * {@link isRealpathInside} today.
 *
 * `update-target.probe.ts` no longer calls `isRealpathInside` at all — a
 * LATER round found that even a correct realpath-containment precondition
 * check, run once before a separate lexically-bounded walk, does not bound
 * that walk (see `update-target.probe.git-ancestor.ts`'s fileoverview for
 * the full history). The probe's own walk asserts containment internally
 * instead, using only the leaf primitive here, {@link resolveRealOrFallback}
 * — precondition-free by construction, so sharing IT never reopens the
 * caller-must-prove-a-precondition shape that motivated this file's split in
 * the first place.
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
 * The containment comparison itself, on paths a caller has ALREADY resolved.
 *
 * Split out from {@link isRealpathInside} so a caller that has resolved both
 * endpoints for its own reasons — `update-target.probe.git-ancestor.ts` walks
 * the resolved chain, so re-resolving would be a wasted `realpath` round-trip
 * per call — can reuse the comparison instead of re-typing it. It was re-typed
 * once, and one hand-copy of this rule is exactly how SMI-6532 got its
 * half-a-conjunction defect; a second copy is the same hazard whether it is
 * half the rule or all of it. One copy, two entry points.
 *
 * Takes resolved paths on trust, which is why it is NOT exported as the
 * general answer — {@link isRealpathInside} is. Pure and synchronous: no I/O,
 * so it cannot fail and has nothing to fail closed about.
 */
export function isResolvedPathInside(realTarget: string, realRoot: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)
}

/**
 * Does `target`'s realpath sit at or inside `root`'s realpath? Resolves BOTH
 * sides through the identical {@link resolveRealOrFallback} helper — never a
 * raw `fs.realpath` on one side and a fallback-guarded resolve on the other
 * (SMI-4758) — asymmetric resolution is itself the bug class this comparison
 * exists to avoid, not merely a lint-satisfying detail.
 */
export async function isRealpathInside(target: string, root: string): Promise<boolean> {
  return isResolvedPathInside(
    await resolveRealOrFallback(target),
    await resolveRealOrFallback(root)
  )
}
