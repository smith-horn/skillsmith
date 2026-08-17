/**
 * SMI-6060: extracted from skills-directory.ts (which had grown past the
 * 500-line standard) — the repo-local skills directory path resolver and
 * its terminal-display counterpart, split out as their own small module.
 */

import { join, relative, sep } from 'path'

/**
 * Path segments for the repo-local skills directory (SMI-1630 — always
 * `.claude/skills`, regardless of `--client`).
 */
const LOCAL_SKILLS_DIR_SEGMENTS = ['.claude', 'skills'] as const

/**
 * Returns the local skills directory path.
 * Computed at call time to handle working directory changes.
 */
export function getLocalSkillsDir(): string {
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
