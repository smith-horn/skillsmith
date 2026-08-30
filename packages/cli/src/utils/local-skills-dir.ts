/**
 * SMI-6060: extracted from skills-directory.ts (which had grown past the
 * 500-line standard) — the repo-local skills directory path resolver and
 * its terminal-display counterpart, split out as their own small module.
 *
 * ADR-139 (SMI-6274 Wave 4): `getLocalSkillsDir()` is now a thin
 * @deprecated wrapper delegating to `claude-code` WORKSPACE resolution
 * (`findWorkspaceRoot`, marker-first / VCS-root-fallback ancestor search)
 * instead of the previous raw `join(process.cwd(), '.claude', 'skills')`.
 * This is a real bug fix, not just a rename: the old version never walked
 * up from `cwd`, so `skillsmith list` run from a repo subdirectory silently
 * missed the repo-root `.claude/skills` — exactly the SMI-1630
 * "repo-local overrides global" promise this function exists to keep.
 *
 * The fallback to the OLD raw `cwd`-joined path (when `findWorkspaceRoot`
 * finds no marker AND no ancestor `.git`) is deliberate, not a leftover:
 * this function's callers use it purely as a disk-SCAN target (a
 * nonexistent directory scans to `[]`, same as before), and callers that
 * key off "the repo-local directory is always `cwd`-anchored, never
 * global" (`getLocalSkillsDirDisplay()` in particular) must keep seeing a
 * `cwd`-relative path even outside any workspace — never the client's
 * GLOBAL path, which is a `~`-anchored, unrelated directory already shown
 * separately. New callers should prefer `resolveSkillScope()` /
 * `resolveScopedSkillsDir()` (`@skillsmith/core/install`) directly instead
 * of this wrapper.
 */

import { join, relative, sep } from 'path'
import { findWorkspaceRoot } from '@skillsmith/core/install'

/**
 * Path segments for the repo-local skills directory (SMI-1630 — always
 * `.claude/skills`, regardless of `--client`).
 */
const LOCAL_SKILLS_DIR_SEGMENTS = ['.claude', 'skills'] as const

/**
 * Returns the local skills directory path.
 * Computed at call time to handle working directory changes.
 *
 * @deprecated Prefer `resolveSkillScope({ client: 'claude-code', ... })` /
 *   `resolveScopedSkillsDir(...)` from `@skillsmith/core/install` for new
 *   code — this wrapper exists only so pre-ADR-139 callers keep working
 *   unmodified through the transition (ADR-139 point 7).
 */
export function getLocalSkillsDir(): string {
  const found = findWorkspaceRoot(process.cwd(), 'claude-code')
  if (found) {
    return join(found.root, ...LOCAL_SKILLS_DIR_SEGMENTS)
  }
  return join(process.cwd(), ...LOCAL_SKILLS_DIR_SEGMENTS)
}

/**
 * Relative-display form of the repo-local skills directory, for terminal
 * output (a `list`/`manage`/`inventory status` line, etc.) — `getLocalSkillsDir()`
 * returns an *absolute* path (joined with `process.cwd()`), correct for
 * filesystem operations but a poor fit for display (nobody wants their own
 * home-directory prefix printed in a footer).
 *
 * Derived from `getLocalSkillsDir()`'s own return value via `path.relative()`
 * (GPT-5.6-Sol review follow-up, SMI-6060) rather than independently
 * reconstructed from `LOCAL_SKILLS_DIR_SEGMENTS` — the earlier version shared
 * only the segments constant, so a future change to `getLocalSkillsDir()`'s
 * own `join()` call (not just the segments array) wouldn't have propagated
 * here, reintroducing a narrower version of the same drift class this module
 * exists to close off. `split(sep).join('/')` normalizes to forward slashes
 * for display regardless of host OS path separator.
 */
export function getLocalSkillsDirDisplay(): string {
  return `./${relative(process.cwd(), getLocalSkillsDir()).split(sep).join('/')}`
}
