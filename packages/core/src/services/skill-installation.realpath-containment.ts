/**
 * @fileoverview Shared realpath-containment predicate.
 * @module @skillsmith/core/services/skill-installation.realpath-containment
 * @see SMI-6532 (round following A0.6) — extracted so the realpath-
 *   containment-for-`isUsableDirectory` rule specifically is written and
 *   tested once, here, rather than hand-copied at its one call site. NARROWER
 *   THAN IT SOUNDS: the underlying `x === r || x.startsWith(r + path.sep)`
 *   comparison SHAPE is a repo-wide idiom, not unique to this module or this
 *   rule — it appears independently, for different subjects, in at least a
 *   dozen other spots across `packages/core/src` (e.g. the lexical AND
 *   realpath containment checks `skill-installation.target-guard.ts`'s own
 *   rule N5 hand-computes inline, and the write-set containment check in
 *   `update-target.probe.ts`). This module consolidates only the ONE rule
 *   named above; it does not claim — and was never meant to claim — that the
 *   general shape has exactly one occurrence in the codebase.
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
 *
 * `realRoot` is normalized to end with exactly one trailing separator before
 * the prefix comparison, rather than unconditionally appending one — at a
 * filesystem root (`realRoot === '/'` on POSIX, `'C:\\'` on Windows,
 * `path.sep` already trailing), unconditionally appending a SECOND separator
 * produced `'//'`/`'C:\\\\'`, which no real descendant path starts with, so
 * `isResolvedPathInside('/child', '/')` returned `false` — a directory
 * genuinely inside the root judged NOT contained. Conservative (refuses
 * rather than permits) but wrong, and both of this predicate's callers
 * (`isUsableDirectory` rule (c) and `probeGitAncestor`) depend on it. See
 * this module's test file for the root-positive control this fixes and the
 * sibling-prefix negative control it must not regress
 * (`skill-installation.target-guard.test.ts`'s `skills` vs `skills-evil`).
 */
export function isResolvedPathInside(realTarget: string, realRoot: string): boolean {
  if (realTarget === realRoot) return true
  const rootWithTrailingSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  return realTarget.startsWith(rootWithTrailingSep)
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
