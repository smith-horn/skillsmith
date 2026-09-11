/**
 * @fileoverview Pre-write install-target safety guard.
 * @module @skillsmith/core/services/skill-installation.target-guard
 * @see SMI-6529 Wave A0
 *
 * On a real user machine, `skillsmith update --all` overwrote uncommitted
 * local work in git-cloned skill directories and wrote into the wrong
 * directory (a target named after the upstream repo, not the directory
 * being updated). `checkInstallTarget()` is the single pre-write gate every
 * `install()`/`installFromContent()` call runs BEFORE any content fetch or
 * disk write — it never mutates anything itself, only inspects the
 * filesystem and the manifest and reports whether the write may proceed.
 *
 * Rules are evaluated in order; the first that fails wins:
 *   (pre) A matching manifest entry's `installPath` must be a usable, real
 *       absolute path — a missing or non-absolute value refuses rather than
 *       reaching `path.resolve()`/`fs.realpath()` (SMI-6529 L17).
 *   (a) `expectedInstallPath` (set by `update`) must match `installPath`
 *       exactly, AND must exist on disk — `force` does NOT override this.
 *   (b) `installPath` missing (ENOENT) -> fresh install, nothing else to
 *       check, UNLESS the manifest key it will occupy already has an entry
 *       whose recorded path is a live conflict (SMI-6529 M8) — see below.
 *       Any other `lstat` error is rethrown (fail closed).
 *   (c) `installPath` must be a directory, or a symlink that resolves to a
 *       directory inside `skillsDir`.
 *   (d) Filesystem-only git-working-tree check (never spawns git): a `.git`
 *       entry (file or directory) at `installPath` or any ancestor up to and
 *       including `skillsDir` refuses the write — `force` does NOT override
 *       this. Walks BOTH the lexical ancestor chain and (SMI-6529 H1) the
 *       REALPATH ancestor chain, since a symlinked `installPath` can resolve
 *       into a git clone whose ancestry `path.dirname()` on the symlink's own
 *       lexical string never crosses into.
 *   (e) The manifest must already track this exact path (by realpath) —
 *       an untracked pre-existing directory is refused — `force` does NOT
 *       override this either. Even a path-matching entry refuses if it is
 *       itself untracked by Skillsmith's trust model (`provenance:'local'`
 *       or `source:'unknown'` — ADR-139 adoption or a user's local
 *       assertion) — `force` does NOT override this either.
 *   (f) Tracked + matching path: existing `ALREADY_INSTALLED` behavior
 *       (refuse without `force`, proceed with it).
 */

import * as fs from 'fs/promises'
import type { Stats } from 'fs'
import * as path from 'path'
import type { InstallErrorCode, SkillManifestEntry } from './skill-installation.types.js'

export type InstallTargetFailureCode = Extract<
  InstallErrorCode,
  | 'INSTALL_TARGET_MISMATCH'
  | 'INSTALL_TARGET_NOT_DIRECTORY'
  | 'INSTALL_TARGET_GIT_WORKTREE'
  | 'INSTALL_TARGET_UNTRACKED'
  | 'ALREADY_INSTALLED'
>

export interface CheckInstallTargetParams {
  installPath: string
  skillsDir: string
  /** The manifest entry at the computed manifest key, or undefined when untracked. */
  manifestEntry: SkillManifestEntry | undefined
  force: boolean
  /** Set by `update` — see {@link InstallOptions.expectedInstallPath}'s own doc comment. */
  expectedInstallPath?: string
}

export type CheckInstallTargetResult =
  | { ok: true; preExisted: boolean }
  | { ok: false; code: InstallTargetFailureCode; error: string; tips?: string[] }

/** `fs.realpath`, falling back to a lexical `path.resolve` when the path can't be resolved
 * (e.g. it doesn't exist, or a component was removed mid-check) — never throws. */
async function resolveRealOrFallback(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * SMI-6529 #16 (round 4): distinguishes a REAL `.git` hit from a fail-closed
 * "couldn't tell" — a plain boolean collapsed both into `true`, so an EACCES
 * on the lstat itself was reported to the user as "is a git working tree,"
 * which is simply false (we never actually saw a `.git` entry, we just
 * couldn't check). L16's fail-closed REFUSAL is unchanged; only the message
 * built from it now names the real reason.
 */
type GitEntryCheck = 'found' | 'absent' | { errorCode: string }

async function pathHasGitEntry(dir: string): Promise<GitEntryCheck> {
  try {
    // lstat (not stat): a `.git` FILE (worktree pointer) or directory both count,
    // and we don't want a `.git` symlink silently resolved away.
    await fs.lstat(path.join(dir, '.git'))
    return 'found'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    // SMI-6529 L16: fail CLOSED — an lstat error we can't interpret as
    // "definitely absent" (EACCES, EIO, an unreadable ancestor, etc.) must
    // never silently read as "no .git here." The CALLER still refuses the
    // write (same as a real hit) so it never guesses wrong in the data-loss
    // direction — but the message says which is which (#16).
    return { errorCode: code ?? 'UNKNOWN' }
  }
}

/** The outcome of walking for a `.git` entry: a real hit, a fail-closed
 * "couldn't verify" at some ancestor, or nothing found (return `null`). */
export type GitWalkResult =
  | { kind: 'found'; path: string }
  | { kind: 'error'; path: string; errorCode: string }

/** Walk from `startAbs` up through `stopAtAbs` (inclusive), returning the first
 * directory with a `.git` entry (or the first unverifiable one), or `null` if
 * none is found before `stopAtAbs`. */
async function walkForGitEntry(startAbs: string, stopAtAbs: string): Promise<GitWalkResult | null> {
  let current = startAbs
  // Bound the walk: every real caller builds installPath as a descendant of
  // skillsDir (so this always terminates via the `current === stopAtAbs`
  // check below), but a future caller that doesn't must never loop forever.
  for (let i = 0; i < 64; i++) {
    const check = await pathHasGitEntry(current)
    if (check === 'found') return { kind: 'found', path: current }
    if (typeof check === 'object')
      return { kind: 'error', path: current, errorCode: check.errorCode }
    if (current === stopAtAbs) return null
    const parent = path.dirname(current)
    if (parent === current) return null // filesystem root — stopAtAbs was never an ancestor
    current = parent
  }
  return null
}

/**
 * Walk from `installPath` up through its ancestors, inclusive of both
 * `installPath` and `skillsDir` (never above `skillsDir`), checking each
 * level for a `.git` entry. Filesystem-only — never spawns `git`. Returns the
 * directory the `.git` entry was found in (for SMI-6529 L13's tailored tip),
 * or `null` if none was found.
 *
 * SMI-6529 H1: a symlinked `installPath` (e.g. a fan-out symlink, or one
 * planted by an attacker) can resolve into a git clone living elsewhere
 * inside `skillsDir` — walking the LEXICAL chain alone misses this, because
 * `path.dirname()` on the symlink's own path string jumps straight to the
 * symlink's own lexical parent, never through the target it points at (only
 * the FINAL path segment of any one `fs` call is exempt from symlink
 * resolution; the "climb to parent" step here works on the string alone).
 * Concretely: `skillsDir/pdf` -> `skillsDir/clone/docs/pdf` where `clone` (not
 * `skillsDir/pdf`'s own lexical parent) has `.git` — only a walk starting from
 * `installPath`'s REALPATH ever visits `clone`. Bounded by `skillsDir`'s own
 * realpath (never climbs above it) — safe because rule (c) has already
 * proven a symlinked `installPath`'s realpath resolves inside (real)
 * `skillsDir` before this ever runs.
 */
async function hasGitAncestorBetween(
  installPath: string,
  skillsDir: string
): Promise<GitWalkResult | null> {
  const resolvedSkillsDir = path.resolve(skillsDir)
  const resolvedInstall = path.resolve(installPath)
  const lexicalHit = await walkForGitEntry(resolvedInstall, resolvedSkillsDir)
  if (lexicalHit) return lexicalHit

  const realInstall = await resolveRealOrFallback(installPath)
  if (realInstall === resolvedInstall) return null // no symlink involved — already covered above
  const realSkillsDir = await resolveRealOrFallback(skillsDir)
  return walkForGitEntry(realInstall, realSkillsDir)
}

/** Rule (c): `installPath` is a usable directory, either directly or via a symlink
 * that resolves to a directory inside `skillsDir`. */
async function isUsableDirectory(
  installPath: string,
  skillsDir: string,
  stats: Stats
): Promise<boolean> {
  if (stats.isDirectory()) return true
  if (!stats.isSymbolicLink()) return false
  try {
    const followed = await fs.stat(installPath)
    if (!followed.isDirectory()) return false
    // SMI-4758: resolve BOTH sides through the identical helper (never a raw
    // fs.realpath on one side and a fallback-guarded resolve on the other) —
    // asymmetric methodology is exactly the bug class this comparison must
    // avoid, not merely a lint-satisfying detail.
    const real = await resolveRealOrFallback(installPath)
    const resolvedSkillsDir = await resolveRealOrFallback(skillsDir)
    return real === resolvedSkillsDir || real.startsWith(resolvedSkillsDir + path.sep)
  } catch {
    return false // broken symlink or unreadable target
  }
}

/**
 * SMI-6529 L17: a manifest entry's `installPath` is typed as required but
 * "runtime JSON may omit it" (see `SkillManifestEntry.installPath`'s own doc
 * comment). Every rule below that reads it (rule (e)'s tracked-path
 * comparison, and (b)'s M8 stale-vs-live check) needs it to be a real
 * absolute path — otherwise it would reach `path.resolve()`/`fs.realpath()`
 * and either throw a raw TypeError (on `undefined`) or silently resolve
 * against `process.cwd()` (on a relative string) instead of surfacing a
 * clear, structured refusal.
 */
function hasUsableInstallPath(
  entry: SkillManifestEntry
): entry is SkillManifestEntry & { installPath: string } {
  return typeof entry.installPath === 'string' && path.isAbsolute(entry.installPath)
}

/** SMI-6529 M8: does `p` still exist on disk? Fails CLOSED on an unexpected
 * lstat error (EACCES, etc.) — treated as "still there" so the caller refuses
 * rather than guessing a manifest conflict away. */
async function pathStillExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    return true
  }
}

export async function checkInstallTarget(
  params: CheckInstallTargetParams
): Promise<CheckInstallTargetResult> {
  const { installPath, skillsDir, manifestEntry, force, expectedInstallPath } = params

  // (pre) SMI-6529 L17 — see hasUsableInstallPath's doc comment.
  if (manifestEntry !== undefined && !hasUsableInstallPath(manifestEntry)) {
    return {
      ok: false,
      code: 'INSTALL_TARGET_UNTRACKED',
      error:
        'Manifest entry for "' +
        path.basename(installPath) +
        '" has a missing or invalid installPath; refusing to trust it.',
      tips: ['Repair the manifest entry: apply_manifest_reconcile'],
    }
  }

  // (a) `update` records the exact directory it diffed against — refuse to
  // write anywhere else, even under force. SMI-4758/F6: resolve BOTH sides
  // through the identical helper (never a raw path.resolve on one side and a
  // realpath'd value on the other) — a symlinked path spelling (macOS
  // /var -> /private/var) must never produce a false mismatch.
  if (expectedInstallPath !== undefined) {
    const resolvedExpected = await resolveRealOrFallback(expectedInstallPath)
    const resolvedInstall = await resolveRealOrFallback(installPath)
    if (resolvedExpected !== resolvedInstall) {
      return {
        ok: false,
        code: 'INSTALL_TARGET_MISMATCH',
        error:
          'Update would write to "' +
          installPath +
          '", but the skill being updated lives at "' +
          expectedInstallPath +
          '"; refusing.',
      }
    }
    // SMI-6529 M5: the path MATCHES, but if it doesn't exist on disk at all,
    // `update` is not "reinstalling the directory it compared against" — it
    // would silently CREATE a brand-new directory at a path whose skill was
    // deleted or moved after the diff ran. Refuse explicitly instead of
    // falling through to rule (b)'s fresh-ENOENT "ok" path, which exists for
    // a genuinely NEW install, not an update.
    if (!(await pathStillExists(expectedInstallPath))) {
      return {
        ok: false,
        code: 'INSTALL_TARGET_MISMATCH',
        error:
          'Update target "' +
          expectedInstallPath +
          '" no longer exists on disk; refusing to create a new directory there.',
      }
    }
  }

  // (b)
  let stats: Stats
  try {
    stats = await fs.lstat(installPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // SMI-6529 M8: a fresh (recomputed) install path is only safe to treat
      // as a brand-new install when the manifest key it will occupy is
      // either unclaimed or points at a directory that's ALSO gone (the
      // round-1 F8-documented stale-entry case). If the SAME manifest key's
      // entry still points at a DIFFERENT directory that (a) still exists on
      // disk, or (b) is marked provenance:'local' (a user assertion that
      // must never be silently superseded, regardless of whether its
      // recorded directory still exists), this is a real conflict — refuse
      // rather than silently adopting the key for an unrelated new install.
      if (manifestEntry) {
        if (manifestEntry.provenance === 'local') {
          return {
            ok: false,
            code: 'INSTALL_TARGET_UNTRACKED',
            error:
              'Manifest entry for "' +
              path.basename(installPath) +
              '" is marked local / not installed by Skillsmith; refusing to reuse it for a new install.',
            tips: [
              'If this is actually a registry skill, relink it first: apply_manifest_reconcile (action: relink)',
            ],
          }
        }
        if (await pathStillExists(manifestEntry.installPath)) {
          return {
            ok: false,
            code: 'INSTALL_TARGET_MISMATCH',
            error:
              'Manifest entry for "' +
              path.basename(installPath) +
              '" already points at "' +
              manifestEntry.installPath +
              '", which still exists; refusing to install at a different path under the same tracked name.',
          }
        }
        // Stale entry: recorded path is gone and not marked local — the
        // documented round-1 (F8) behavior — proceed as a fresh install,
        // reusing this manifest key.
      }
      return { ok: true, preExisted: false }
    }
    throw err // fail closed — do not guess at an unexpected lstat error
  }

  // (c)
  if (!(await isUsableDirectory(installPath, skillsDir, stats))) {
    return {
      ok: false,
      code: 'INSTALL_TARGET_NOT_DIRECTORY',
      error: 'Install target "' + installPath + '" exists but is not a directory.',
    }
  }

  // SMI-6529 N5 (round 4): containment — a CALLER (e.g. a pre-flight that
  // computed `installPath` from a different client's manifest entry than the
  // `skillsDir` it passed) could hand this function an `installPath` that
  // isn't actually inside `skillsDir` at all. Without this check, rule (d)'s
  // ancestor walk below never meets `skillsDir` and silently climbs all the
  // way to the filesystem root. Valid if EITHER the lexical OR the realpath
  // comparison holds — matching rule (c)'s own permissiveness for a
  // legitimate symlink whose target resolves inside `skillsDir` even though
  // its own lexical spelling doesn't; refuse only when BOTH fail.
  const resolvedInstallForContainment = path.resolve(installPath)
  const resolvedSkillsDirForContainment = path.resolve(skillsDir)
  const lexicallyContained =
    resolvedInstallForContainment === resolvedSkillsDirForContainment ||
    resolvedInstallForContainment.startsWith(resolvedSkillsDirForContainment + path.sep)
  if (!lexicallyContained) {
    const realInstallForContainment = await resolveRealOrFallback(installPath)
    const realSkillsDirForContainment = await resolveRealOrFallback(skillsDir)
    const reallyContained =
      realInstallForContainment === realSkillsDirForContainment ||
      realInstallForContainment.startsWith(realSkillsDirForContainment + path.sep)
    if (!reallyContained) {
      // Round 5: MISMATCH, not NOT_DIRECTORY — the target may well be a
      // directory; what's wrong is that it isn't where installs belong.
      return {
        ok: false,
        code: 'INSTALL_TARGET_MISMATCH',
        error:
          'Install target "' +
          installPath +
          '" is not inside skills directory "' +
          skillsDir +
          '"; refusing.',
      }
    }
  }

  // (d) Filesystem-only — never spawns git. `force` does NOT override this.
  const gitHit = await hasGitAncestorBetween(installPath, skillsDir)
  if (gitHit) {
    // SMI-6529 #16 (round 4): a fail-closed "couldn't verify" (EACCES, etc.)
    // gets an ACCURATE message naming the real reason, never the false claim
    // that a git working tree was actually found — L16's refusal itself is
    // unchanged (same code, still refuses).
    if (gitHit.kind === 'error') {
      return {
        ok: false,
        code: 'INSTALL_TARGET_GIT_WORKTREE',
        error:
          'Could not check "' +
          gitHit.path +
          '" for a git repository: ' +
          gitHit.errorCode +
          '. Refusing to proceed.',
      }
    }
    // SMI-6529 L13: tailor the message/tip depending on whether `.git` was
    // found AT installPath itself vs. an ancestor (or skillsDir) — naming
    // the actual git root makes the remediation command runnable as-is
    // instead of pointed at a directory that isn't really the clone root.
    const resolvedInstall = path.resolve(installPath)
    const realInstall = await resolveRealOrFallback(installPath)
    const atInstallItself = gitHit.path === resolvedInstall || gitHit.path === realInstall
    return {
      ok: false,
      code: 'INSTALL_TARGET_GIT_WORKTREE',
      error: atInstallItself
        ? 'Install target "' + installPath + '" is a git working tree — refusing to overwrite it.'
        : 'Install target "' +
          installPath +
          '" lives inside a git working tree rooted at "' +
          gitHit.path +
          '" — refusing to overwrite it.',
      tips: [
        atInstallItself
          ? 'This skill is a git clone. Update it with: git -C "' + installPath + '" pull --ff-only'
          : 'This skill lives inside a git clone rooted at "' +
            gitHit.path +
            '". Update it with: git -C "' +
            gitHit.path +
            '" pull --ff-only',
      ],
    }
  }

  // (e) `force` does NOT override this either.
  const realInstall = await resolveRealOrFallback(installPath)
  const realEntry = manifestEntry ? await resolveRealOrFallback(manifestEntry.installPath) : null
  if (!manifestEntry || realEntry !== realInstall) {
    return {
      ok: false,
      code: 'INSTALL_TARGET_UNTRACKED',
      error:
        'A directory already exists at "' +
        installPath +
        '" that Skillsmith didn\'t install (or the manifest entry points elsewhere); refusing to overwrite it.',
      tips: ['Move the existing directory aside, then retry', 'Or remove it, then retry'],
    }
  }

  // SMI-6529 F5 / ADR-155 §3+§5: a path-matching entry that is ITSELF
  // untracked by Skillsmith's own trust model — an ADR-139 adoption
  // (source:'unknown') or a user's explicit provenance:'local' assertion —
  // must still refuse, even though the path matches. `force` means "reinstall
  // what Skillsmith installed," not "overwrite an adopted or local skill";
  // `force` does NOT override this.
  if (manifestEntry.provenance === 'local' || manifestEntry.source === 'unknown') {
    return {
      ok: false,
      code: 'INSTALL_TARGET_UNTRACKED',
      error:
        'Skill at "' +
        installPath +
        '" is marked local / not installed by Skillsmith; refusing to overwrite it.',
      tips: [
        'If this is actually a registry skill, relink it first: apply_manifest_reconcile (action: relink)',
      ],
    }
  }

  // (f)
  if (!force) {
    return {
      ok: false,
      code: 'ALREADY_INSTALLED',
      error:
        'Skill "' +
        path.basename(installPath) +
        '" is already installed. Use force=true to reinstall.',
    }
  }
  return { ok: true, preExisted: true }
}
