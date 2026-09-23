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
 * the skill it backs up, e.g. `linear.backup-1758600000000`)?
 *
 * The ONLY product-code writer of this sibling shape today is
 * `ActivationManager.ts:329` (`${installPath}.backup-${Date.now()}` — a
 * bare epoch-ms suffix, no internal hyphen); confirmed via an exhaustive
 * `git grep -nF '.backup-'` over tracked, non-`node_modules`, non-`.md`
 * files (38 hits, SMI-6532/SMI-6358). The `<base>.backup-YYYYMMDD-HHMMSS`
 * shape this module used as its own example is DOCUMENTED, not live: this
 * module's original regex (`/\.backup-\d{8}-/`) was built around it, but no
 * in-tree product code writes it — it appears only in three test fixtures
 * (`packages/cli/tests/e2e/utils/source-recovery-fixture.ts`,
 * `packages/mcp-server/src/__tests__/source-recovery-fixture.ts`,
 * `packages/core/tests/provenance/SourceRecoveryService.test.ts`).
 * A third convention (`install.backup-gc.ts` / `createSkillBackup()`'s
 * `.backups/<skillName>/<timestamp>_<reason>/`) lives under the `.backups`
 * DOTDIR, which the caller's `name.startsWith('.')` guard already excludes
 * before this predicate ever runs — it is not a sibling shape and is out of
 * scope here.
 *
 * The mechanism: `.backup-` immediately followed by at least one digit,
 * anywhere in `name` — deliberately unanchored, so a future writer's suffix
 * (a collision marker like ` (1)`, an extension like `.old`/`.tmp`/`.bak`,
 * or a longer digit run) still matches without this predicate needing to
 * change again.
 *
 * FAILURE DIRECTION (deliberate): this errs toward matching too much
 * (false positive) rather than too little (false negative).
 *   - False positive — a real skill happens to be named
 *     `<name>.backup-<digits...>` — misclassifies it as `backup-dir`.
 *     Classification stops at §4.3 row 2, and §4.5 prints backup dirs ONLY
 *     as a count, so the skill is never auto-updated AND never named in the
 *     plan output — a worse cost than being listed under a skip reason, and
 *     stated that way deliberately. Still, nothing is written anywhere it
 *     shouldn't be. Recoverable (rename the
 *     skill, or update it manually) and, in practice, vanishingly unlikely —
 *     backup directory names are Skillsmith-generated, not user-chosen.
 *   - False negative — an actual backup directory is NOT flagged — it is
 *     enumerated as an ordinary skill. Fed into the update gate, nothing
 *     before row 2 rules it out on its own, so it can reach later rows and,
 *     on a manifest-key coincidence, become a genuine WRITE TARGET:
 *     Skillsmith overwriting the very backup that exists as the
 *     last-resort recovery for a failed update. That is a data-safety
 *     hazard, not merely an inconvenience.
 *
 * This predicate replaces an intermediate, `$`-anchored version,
 * `/\.backup-\d+(-\d+)*$/`, whose anchor NARROWED it below even the
 * original `/\.backup-\d{8}-/` for any name carrying a suffix after the
 * digit run (a collision marker, an extension) — the exact false-negative
 * direction this predicate exists to avoid, and the opposite of what that
 * version's own docstring claimed about itself. Verified over a case table
 * (`isBackupDir` describe block, `local-skill-scan.test.ts`) that the
 * current, unanchored regex is a strict superset of BOTH prior regexes:
 * every case either predecessor matched is still matched, plus the five
 * cases the anchor had newly excluded.
 */
export function isBackupDir(name: string): boolean {
  return /\.backup-\d/.test(name)
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
