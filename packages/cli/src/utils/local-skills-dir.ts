/**
 * SMI-6060: extracted from skills-directory.ts (which had grown past the
 * 500-line standard) — the repo-local skills directory path resolver and
 * its terminal-display counterpart, split out as their own small module.
 */

import { join } from 'path'

/**
 * Path segments for the repo-local skills directory (SMI-1630 — always
 * `.claude/skills`, regardless of `--client`). Single source of truth for
 * both the absolute-path resolver below and the relative-display string
 * `getLocalSkillsDirDisplay()` — previously `manage.action.ts`'s footer
 * hand-typed the literal `./.claude/skills` independently of this
 * function, so the two could silently drift if this path ever changed.
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
 * output (a `list`/`manage` footer, etc.) — `getLocalSkillsDir()` returns
 * an *absolute* path (joined with `process.cwd()`), correct for filesystem
 * operations but a poor fit for display (nobody wants their own
 * home-directory prefix printed in a footer). Derives from the same
 * `LOCAL_SKILLS_DIR_SEGMENTS` as `getLocalSkillsDir()` so this text can't
 * independently drift from the real resolved path.
 */
export function getLocalSkillsDirDisplay(): string {
  return `./${LOCAL_SKILLS_DIR_SEGMENTS.join('/')}`
}
