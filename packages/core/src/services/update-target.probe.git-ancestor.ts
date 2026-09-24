/**
 * @fileoverview The probe's OWN bounded git-ancestor walk (SMI-6532, round
 * following A0.6).
 * @module @skillsmith/core/services/update-target.probe.git-ancestor
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.2
 *
 * THIS DEVIATES FROM THE PLAN. `update-safety-and-source-resolution.md` §4.2
 * says "Git detection reuses A0's walk (`hasGitAncestorBetween`, exported
 * unchanged)." Three consecutive review rounds found a defect in that reuse:
 *   1. `checkPresence` (`update-target.probe.ts`) fabricated `ENOTDIR` for a
 *      symlinked directory by `lstat`ing instead of `stat`ing it.
 *      Fixed by following the symlink — but the fix implemented only HALF of
 *      `isUsableDirectory` rule (c)'s conjunction (follows-to-a-directory),
 *      never the second half (realpath containment), so:
 *   2. a symlink whose REALPATH escaped `skillsDir` made
 *      `hasGitAncestorBetween`'s walk stop condition unreachable, and it
 *      climbed ancestors until its own 64-iteration cap or the filesystem
 *      root — reachable through the shipped `fan-out.ts:224-226` relative-
 *      symlink install shape, not a hypothetical. Fixed by checking
 *      `isRealpathInside(dir, skillsDir)` as a PRECONDITION before ever
 *      calling `hasGitAncestorBetween` — but:
 *   3. that precondition proved the wrong thing. `hasGitAncestorBetween` runs
 *      TWO passes; its FIRST pass is bounded by a LEXICAL
 *      `path.resolve(skillsDir)`, never a realpath. A target whose REALPATH
 *      is contained but whose LEXICAL path is not (a symlinked ANCESTOR
 *      component, not the target itself — `isRealpathInside` only proves the
 *      former) sails through the precondition and then runs an effectively
 *      unbounded lexical pass 1, which can report a `.git` outside the real
 *      skills root as a legitimate ancestor (measured), silently scan
 *      arbitrarily far up the real filesystem with no `.git` to show for it
 *      (measured), or — for a deeply nested target — hit the 64-iteration
 *      cap and report a bare `none`: a conclusive-sounding answer for a
 *      search that never reached the boundary it claims to have searched
 *      (measured).
 *
 * THE COMMON CAUSE across all three findings is the same one:
 * `hasGitAncestorBetween` states its own safety as a PRECONDITION THE CALLER
 * MUST PROVE ("rule (c) has already proven a symlinked `installPath`'s
 * realpath resolves inside (real) `skillsDir` before this ever runs" — its
 * own doc comment, `skill-installation.target-guard.ts`). Every round, a
 * caller proved a slightly wrong thing. So this probe stops giving a caller
 * something to prove: {@link probeGitAncestor} resolves BOTH endpoints
 * through realpath FIRST, asserts containment INTERNALLY — never assumed of
 * whoever calls it — and walks ONLY the resolved realpath chain. There is no
 * lexical pass here at all, so there is no lexical-vs-real gap for a
 * symlinked ancestor to open.
 *
 * `hasGitAncestorBetween` is UNCHANGED and stays exported from
 * `skill-installation.target-guard.ts` — it remains A0's own install-time
 * pre-write gate, and `checkInstallTarget` rule (d) still calls it with
 * exactly the precondition it has always required (rule (c) proves
 * containment first, in that same function, for that same call). This module
 * does NOT share a walk with it, on purpose: sharing a walk whose safety
 * depends on a caller-proved precondition is the arrangement that produced
 * all three findings above. Two explicit walks, each asserting its own
 * invariants internally, is the intended shape here — a future "helpful"
 * merge of the two back into one shared walk would reopen the same defect
 * class this file exists to close.
 *
 * `resolveRealOrFallback` (`skill-installation.realpath-containment.ts`) IS
 * still shared with A0 — it is a precondition-free leaf primitive (try
 * `fs.realpath`, fall back to `path.resolve`; nothing about its own
 * correctness depends on what a caller has or hasn't already checked), the
 * opposite hazard shape from `hasGitAncestorBetween`. `isRealpathInside`
 * (same module) is *also* precondition-free and correct, and this module
 * deliberately does NOT call it: it internally re-resolves both endpoints,
 * and this walk already needs the resolved `dir`/`skillsDir` values for its
 * own iteration bounds, so calling it would mean resolving each endpoint
 * twice. The one-line comparison below is exactly `isRealpathInside`'s own
 * body, applied to the already-resolved values.
 */

import * as fs from 'fs/promises'
import * as path from 'path'

import {
  resolveRealOrFallback,
  isResolvedPathInside,
} from './skill-installation.realpath-containment.js'
import { errnoOf, sanitizeError, type ProbeError } from './update-target.probe.types.js'

/** Matches `skill-installation.target-guard.ts`'s own `walkForGitEntry` cap —
 * not shared as a constant (that walk stays fully independent; see this
 * module's fileoverview), but there is exactly one reasonable bound for "how
 * many ancestors is too many," and it is this one. */
const GIT_WALK_MAX_DEPTH = 64

/**
 * Three-state git-ancestor result the PUBLIC probe outcome
 * (`ProbeOk.gitAncestor` in `update-target.probe.ts`) carries — `found` and
 * `none` both mean the walk RAN and reached a conclusive answer bounded at
 * the real skills root; `undetermined` means it did NOT reach one, for a
 * reason named on the value itself. There is no bare `null` anywhere in this
 * shape — an undetermined walk is never silently read as "no git repo found"
 * (`none`), the exact permissive-value-from-an-undetermined-state shape
 * `update-target.probe.ts`'s own fileoverview (THE CENTRAL PROPERTY) says
 * this whole probe exists to remove.
 *
 * `escapes-root`: the target's realpath does not resolve inside the skills
 * root's realpath. The walk never starts — this is what replaced round 2's
 * `isRealpathInside` PRECONDITION check; it is asserted HERE, internally,
 * before any walk, rather than trusted of whoever calls {@link probeGitAncestor}.
 * `depth-cap`: the walk reached {@link GIT_WALK_MAX_DEPTH} ancestors without
 * reaching the (already-confirmed-contained) real skills root — reported as
 * undetermined, never as a permissive `none` for the unsearched remainder.
 */
export type ProbeGitAncestor =
  | { kind: 'found'; path: string }
  | { kind: 'none' }
  | { kind: 'undetermined'; reason: 'escapes-root' }
  | { kind: 'undetermined'; reason: 'depth-cap' }

/** Superset of {@link ProbeGitAncestor}, returned only by this module's own
 * internals — adds the ONE exit `probeUpdateTarget` (`update-target.probe.ts`)
 * intercepts and converts into the probe's own `probe-failed` outcome rather
 * than ever placing on `ok.gitAncestor`: a real `lstat` failure during the
 * walk is a METADATA error (`update-target.probe.ts`'s own fileoverview,
 * "METADATA vs READ/HASH ERRORS"), the same bucket every other directory-
 * level `lstat` in this probe already falls into — not a new, different kind
 * of "undetermined." */
export type GitAncestorWalkOutcome =
  | ProbeGitAncestor
  | { kind: 'undetermined'; reason: 'stat-error'; error: ProbeError }

/** Does `dir` itself have a `.git` entry? `lstat`, not `stat` — a `.git`
 * FILE (worktree pointer) or directory both count, and a `.git` SYMLINK must
 * never be silently resolved away. Errors are sanitized against `dir` (the
 * directory being checked), never the joined `.git` path — this probe always
 * reports the path it asked about, never one read back off an exception. */
async function hasGitEntryAt(dir: string): Promise<'found' | 'absent' | { error: ProbeError }> {
  try {
    await fs.lstat(path.join(dir, '.git'))
    return 'found'
  } catch (err) {
    const code = errnoOf(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    return { error: sanitizeError(dir, err) }
  }
}

/**
 * Walk `realDir` up to `realRoot` (inclusive) — both already realpath-
 * resolved by {@link probeGitAncestor}. This function does no resolution of
 * its own and follows no symlinks: a canonical (realpath'd) string's own
 * ancestors, taken by plain `path.dirname`, are themselves canonical, so a
 * lexical climb over an already-real path IS the real-path climb — there is
 * no second, separate "realpath pass" the way `hasGitAncestorBetween` has
 * one, because there is no first, lexical pass for it to differ from.
 *
 * Bounded by `realRoot`: {@link probeGitAncestor} has already proven
 * `realDir` is `realRoot` or a descendant of it before this ever runs, so
 * `current === realRoot` is always reached before the filesystem root — the
 * `parent === current` branch below is therefore unreachable given that
 * precondition, and exists only as a defensive terminator so a future caller
 * that reaches this function some other way can never loop forever.
 */
async function walkGitAncestor(realDir: string, realRoot: string): Promise<GitAncestorWalkOutcome> {
  let current = realDir
  for (let i = 0; i < GIT_WALK_MAX_DEPTH; i++) {
    const check = await hasGitEntryAt(current)
    if (check === 'found') return { kind: 'found', path: current }
    if (typeof check === 'object') {
      return { kind: 'undetermined', reason: 'stat-error', error: check.error }
    }
    if (current === realRoot) return { kind: 'none' }
    const parent = path.dirname(current)
    // Unreachable given probeGitAncestor's own containment proof — see this
    // function's doc comment. `none`, not a distinct reason, because if this
    // is ever reached the walk DID conclusively reach the filesystem root
    // without finding a `.git`; it just did so somewhere a precondition says
    // it never should.
    if (parent === current) return { kind: 'none' }
    current = parent
  }
  return { kind: 'undetermined', reason: 'depth-cap' }
}

/**
 * Report whether a `.git` exists at or above `dir` and at or below
 * `skillsDir` — bounded, real-path-only, with containment asserted HERE
 * rather than trusted of the caller. See this module's fileoverview for the
 * full history of why this function exists instead of reusing A0's
 * `hasGitAncestorBetween`.
 */
export async function probeGitAncestor(
  dir: string,
  skillsDir: string
): Promise<GitAncestorWalkOutcome> {
  const realDir = await resolveRealOrFallback(dir)
  const realRoot = await resolveRealOrFallback(skillsDir)
  // The SAME comparison rule `isUsableDirectory` rule (c) uses, not a second
  // copy of it — the synchronous form, because both endpoints are already
  // resolved here and `isRealpathInside` would re-resolve them. One hand-copy
  // of this rule is how SMI-6532 got its half-a-conjunction defect; a full
  // copy is the same hazard.
  if (!isResolvedPathInside(realDir, realRoot)) {
    return { kind: 'undetermined', reason: 'escapes-root' }
  }
  return walkGitAncestor(realDir, realRoot)
}
