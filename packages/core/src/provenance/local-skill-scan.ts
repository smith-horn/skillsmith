/**
 * @fileoverview Enumerate locally-installed skill directories for recovery.
 * @module @skillsmith/core/provenance/local-skill-scan
 * @see SMI-5407
 *
 * Enumeration guard: directories only; names not starting with `.` (skips
 * `.backups/`); non-backup dirs must contain SKILL.md; dirs matching
 * `<base>.backup-YYYYMMDD-*` are listed but flagged `isBackup` (not scanned).
 */

import type { Dirent } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'

import { SkillParser } from '../indexer/SkillParser.js'

/** Matches a backup directory suffix, e.g. `linear.backup-20260419-124019`. */
const BACKUP_DIR_RE = /\.backup-\d{8}-/

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

    if (BACKUP_DIR_RE.test(name)) {
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
