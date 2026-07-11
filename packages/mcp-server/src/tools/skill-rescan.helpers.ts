/**
 * @fileoverview Helpers for the skill_rescan MCP tool -- dependency backfill.
 * @module @skillsmith/mcp-server/tools/skill-rescan.helpers
 * @see SMI-5645: `skill_rescan` never backfilled `skill_dependencies` for
 *   skills installed before the SMI-5639 dependency-persistence fix shipped
 *   (`@skillsmith/mcp-server@0.7.1`). Skills installed before that release
 *   have zero `skill_dependencies` rows and, absent this backfill, always
 *   would.
 *
 * Split from skill-rescan.ts to stay under the repo's 500-line file-size
 * gate (`audit:standards`), following the established `foo.ts`/`foo.helpers.ts`
 * split convention used elsewhere in this directory (e.g. install.helpers.ts,
 * validate.helpers.ts).
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import type { SkillDependencyRepository } from '@skillsmith/core'
import {
  extractDepIntel,
  persistDependencies,
} from '@skillsmith/core/services/skill-installation-helpers'

/**
 * Discover installed skill directories under ~/.claude/skills/.
 *
 * Skills are installed as either:
 *   - ~/.claude/skills/{skillName}/SKILL.md
 *   - ~/.claude/skills/{author}/{skillName}/SKILL.md
 *
 * Returns an array of { name, skillMdPath } objects.
 *
 * Moved here from skill-rescan.ts (SMI-5645) purely to keep that file under
 * the 500-line file-size gate -- no behavior change.
 */
export async function discoverInstalledSkills(
  skillsDir: string
): Promise<Array<{ name: string; skillMdPath: string }>> {
  const results: Array<{ name: string; skillMdPath: string }> = []

  let entries: string[]
  try {
    entries = await fs.readdir(skillsDir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry)
    const stat = await fs.stat(entryPath).catch(() => null)
    if (!stat?.isDirectory()) continue

    // Check for SKILL.md directly in this directory
    const directSkillMd = join(entryPath, 'SKILL.md')
    const directExists = await fs
      .access(directSkillMd)
      .then(() => true)
      .catch(() => false)

    if (directExists) {
      results.push({ name: entry, skillMdPath: directSkillMd })
      continue
    }

    // Check for author/skill-name subdirectories
    const subEntries = await fs.readdir(entryPath).catch(() => [] as string[])
    for (const subEntry of subEntries) {
      const subPath = join(entryPath, subEntry)
      const subStat = await fs.stat(subPath).catch(() => null)
      if (!subStat?.isDirectory()) continue

      const nestedSkillMd = join(subPath, 'SKILL.md')
      const nestedExists = await fs
        .access(nestedSkillMd)
        .then(() => true)
        .catch(() => false)

      if (nestedExists) {
        results.push({
          name: `${entry}/${subEntry}`,
          skillMdPath: nestedSkillMd,
        })
      }
    }
  }

  return results
}

/**
 * Backfill `skill_dependencies` rows for one installed skill by re-running
 * the SAME extraction+persistence pipeline SMI-5639 added at install time
 * (`extractDepIntel()` + `persistDependencies()`,
 * `packages/core/src/services/skill-installation.helpers.ts`), against the
 * skill's SKILL.md content as read by the caller.
 *
 * ## Design decision: reflects CURRENT SKILL.md, not historical install-time state
 *
 * There is no historical snapshot of a skill's SKILL.md as it existed at
 * original-install time -- capturing that is precisely the gap SMI-5645
 * exists to close. This function therefore necessarily reads whatever
 * content the caller currently has on disk, not a reconstruction of what
 * would have been extracted at install time. **This is intentional,
 * best-effort behavior, not a bug**: if a skill's SKILL.md was edited (or
 * deleted and reinstalled with different content) between original install
 * and this rescan, the backfilled rows reflect the file's CURRENT content.
 * Callers surfacing the returned count (see `dependenciesBackfilled` /
 * `totalDependenciesBackfilled` on `SkillRescanEntry`/`SkillRescanResponse`)
 * must not present it as if it reconstructed original-install-time
 * dependency data.
 *
 * ## Idempotency
 *
 * `persistDependencies` upserts on (skill_id, dep_type, dep_target,
 * dep_source), so calling this repeatedly against the same skillId/content
 * does not accumulate duplicate `skill_dependencies` rows -- the returned
 * count reflects the size of the CURRENTLY-extracted dependency set on every
 * call, not a cumulative "new since last run" delta. A skill rescanned 10
 * times in a row reports the same non-zero count every time while the
 * underlying table holds a constant row count.
 *
 * ## Failure containment
 *
 * Best-effort: any error (malformed content, DB error, missing table) is
 * swallowed and reported as zero dependencies backfilled -- mirroring the
 * install-time call site's own best-effort `try`/`catch` around
 * `persistDependencies` (`skill-installation.service.ts`, ~lines 374-380) so
 * a dependency-extraction failure for one skill never fails the security
 * rescan itself, for that skill or any other.
 *
 * @param repo    Dependency repository to persist into. When undefined (no
 *                DB-backed context available to the caller), returns 0
 *                without attempting extraction -- mirrors `quarantineRepo`'s
 *                existing optional/backward-compatible pattern in this tool.
 * @param skillId Canonical identity key for the scanned skill. skill_rescan
 *                has no manifest access and operates purely off the
 *                filesystem, so this is the tool's own local identity key
 *                (`local/${canonicalName}`, matching the quarantine key
 *                already used elsewhere in this tool) -- NOT necessarily the
 *                original registry `owner/repo` skillId used at install
 *                time, which this tool cannot recover from disk alone.
 * @param content Currently-installed SKILL.md content (already read from
 *                disk by the caller; this function performs no I/O).
 * @returns Number of dependency rows written (inserted or upserted) for this
 *          skill during this call. 0 on error, missing repo, or when no
 *          dependencies are detected.
 */
export function backfillSkillDependencies(
  repo: SkillDependencyRepository | undefined,
  skillId: string,
  content: string
): number {
  if (!repo) return 0
  try {
    const depIntel = extractDepIntel(content)
    return persistDependencies(repo, skillId, content, depIntel.dep_declared)
  } catch {
    // Best-effort -- a dependency-extraction/persistence failure must never
    // fail the security rescan itself (mirrors the install-time try/catch).
    return 0
  }
}
