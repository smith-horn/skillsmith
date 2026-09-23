/**
 * @fileoverview Enumerate locally-installed skill directories for recovery.
 * @module @skillsmith/core/provenance/local-skill-scan
 * @see SMI-5407
 * @see SMI-6532 A2 §4.2 — `isBackupDir` exported for the update eligibility
 *   gate's classifier (`update-target-gate.ts` row 2, not in this file).
 *
 * Enumeration guard: directories only; names not starting with `.` (skips
 * `.backups/`, which `install.backup-gc.ts` owns under a different, already-
 * dotdir-excluded convention); non-backup dirs must contain SKILL.md; dirs
 * matching `isBackupDir()` are listed but flagged `isBackup` (not scanned).
 */

import type { Dirent } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'

import { SkillParser } from '../indexer/SkillParser.js'

/**
 * Does `name` look like a Skillsmith-generated backup directory (sibling to
 * the skill it backs up, e.g. `linear.backup-20260419-124019`)?
 *
 * Two live naming shapes exist, both under `.backup-`:
 *   - `<base>.backup-YYYYMMDD-HHMMSS` (the documented/common shape).
 *   - `<base>.backup-${Date.now()}` (`ActivationManager.ts:329` — a bare
 *     13-digit epoch-ms suffix, no internal hyphen).
 * A third convention (`install.backup-gc.ts`'s
 * `.backups/<skillName>/<timestamp>_<reason>/`) lives under the `.backups`
 * DOTDIR, which the caller's `name.startsWith('.')` guard already excludes
 * before this predicate ever runs — it is not a sibling shape and is out of
 * scope here.
 *
 * The mechanism, not either literal instance: `.backup-` followed by one or
 * more digit-groups separated by single hyphens, anchored at the end of the
 * name. `\d+(-\d+)*$` covers both shapes above (and any other
 * digits-and-hyphens timestamp suffix a future writer might use) without
 * hardcoding a digit count.
 *
 * FAILURE DIRECTION (deliberate): this errs toward matching too much
 * (false positive) rather than too little (false negative).
 *   - False positive — a real skill happens to be named
 *     `<name>.backup-<digits>` — misclassifies it as `backup-dir`.
 *     Classification stops at §4.3 row 2, and §4.5 prints backup dirs ONLY
 *     as a count, so the skill is never auto-updated AND never named in the
 *     plan output — a worse cost than being listed under a skip reason, and
 *     stated that way deliberately. Still, nothing is written anywhere it
 *     shouldn't be. Recoverable (rename the
 *     skill, or update it manually) and, in practice, vanishingly unlikely —
 *     backup directory names are Skillsmith-generated, not user-chosen.
 *   - False negative — an actual backup directory (esp. the undocumented
 *     13-digit `Date.now()` shape) is NOT flagged — it is enumerated as an
 *     ordinary skill. Fed into the update gate, nothing before row 2 rules
 *     it out on its own, so it can reach later rows and, on a manifest-key
 *     coincidence, become a genuine WRITE TARGET: Skillsmith overwriting the
 *     very backup that exists as the last-resort recovery for a failed
 *     update. That is a data-safety hazard, not merely an inconvenience.
 * Given that asymmetry, broadening the match (this predicate, replacing the
 * narrower `/\.backup-\d{8}-/`) is the correct direction: it trades a rare,
 * cheap, recoverable false positive for closing a real false-negative that
 * let a live backup directory slip through undetected (the bug this
 * predicate exists to fix).
 */
export function isBackupDir(name: string): boolean {
  return /\.backup-\d+(-\d+)*$/.test(name)
}

/** One enumerated skill directory. */
export interface LocalSkillEntry {
  /** Directory basename. */
  skillName: string
  /** Absolute path to the skill directory. */
  dir: string
  /** Absolute path to `<dir>/SKILL.md`. */
  skillMdPath: string
  /** SKILL.md content, or null when a backup (not scanned) or unreadable. */
  skillMd: string | null
  /** `name` from SKILL.md frontmatter, or null. */
  frontmatterName: string | null
  /** `author` from SKILL.md frontmatter, or null. */
  frontmatterAuthor: string | null
  /** True when the directory is a `*.backup-*` snapshot. */
  isBackup: boolean
}

const parser = new SkillParser({ requireName: false })

/** Parse a SKILL.md's frontmatter name/author defensively. */
function readFrontmatter(content: string): { name: string | null; author: string | null } {
  const fm = parser.extractFrontmatter(content)
  const name = typeof fm?.name === 'string' && fm.name.trim() ? fm.name.trim() : null
  const author = typeof fm?.author === 'string' && fm.author.trim() ? fm.author.trim() : null
  return { name, author }
}

/**
 * Enumerate skill directories under `skillsRoot`.
 *
 * Backup directories are returned with `isBackup: true` and `skillMd: null`
 * (still listed, never scanned). Non-backup directories without a readable
 * SKILL.md are excluded. Returns `[]` when the root is absent.
 */
export async function scanLocalSkills(skillsRoot: string): Promise<LocalSkillEntry[]> {
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: LocalSkillEntry[] = []

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const name = dirent.name
    if (name.startsWith('.')) continue // skips `.backups/` and other dotdirs

    const dir = path.join(skillsRoot, name)
    const skillMdPath = path.join(dir, 'SKILL.md')

    if (isBackupDir(name)) {
      entries.push({
        skillName: name,
        dir,
        skillMdPath,
        skillMd: null,
        frontmatterName: null,
        frontmatterAuthor: null,
        isBackup: true,
      })
      continue
    }

    let skillMd: string
    try {
      skillMd = await fs.readFile(skillMdPath, 'utf-8')
    } catch {
      continue // non-backup dir without a readable SKILL.md is excluded
    }

    const { name: fmName, author: fmAuthor } = readFrontmatter(skillMd)
    entries.push({
      skillName: name,
      dir,
      skillMdPath,
      skillMd,
      frontmatterName: fmName,
      frontmatterAuthor: fmAuthor,
      isBackup: false,
    })
  }

  return entries
}
