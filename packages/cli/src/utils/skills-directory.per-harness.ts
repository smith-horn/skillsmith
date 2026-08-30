/**
 * SMI-5390: per-harness/skill inventory scan, feeding the cross-harness
 * inventory builder. Extracted from `skills-directory.ts` (ADR-139 /
 * SMI-6274 Wave 4) to stay under the 500-line standard once that file grew
 * scope-aware — re-exported from `skills-directory.ts` so existing call
 * sites keep importing from that module unmodified.
 */

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { SkillParser } from '@skillsmith/core'
import type { ClientId } from '@skillsmith/core/install'
import { getSkillsFromDirectory, safeRealpath } from './skills-directory.js'
import { buildScanTargets } from './skills-directory.scan-targets.js'

/**
 * Per-harness/skill entry produced by {@link getInstalledSkillsPerHarness}.
 * Feeds the cross-harness inventory builder (SMI-5390).
 *
 * `contentHash` is the sha256 hex digest of the skill's raw SKILL.md
 * content — used by the inventory service for registry drift detection.
 * It is `null` when SKILL.md is absent or unreadable.
 */
export interface HarnessSkillEntry {
  /** Which harness directory the skill was found under. */
  harness: ClientId | 'local'
  /**
   * Skill identifier: the `id` front-matter field when present (conventionally
   * `author/name`), falling back to the `name` field, then the directory name.
   */
  skillId: string
  /** Installed version string, or `null` if absent. */
  version: string | null
  /** sha256 hex digest of SKILL.md content; `null` if unreadable. */
  contentHash: string | null
  /** Absolute path to the skill directory. */
  path: string
  /** Author claim from SKILL.md front-matter — self-asserted (SMI-5442). */
  author: string | null
  /** License claim from SKILL.md front-matter — self-asserted (SMI-5442). */
  license: string | null
  /** Repository URL claim from SKILL.md front-matter — self-asserted (SMI-5442). */
  repository: string | null
}

/**
 * Reads `<skillPath>/SKILL.md`, returns its sha256 hex content hash, the `id`
 * front-matter field, and the three provenance fields (author/license/repository).
 * All fields are `null` on any read/parse error. (SMI-5442)
 * @internal
 */
async function readSkillMd(skillPath: string): Promise<{
  contentHash: string | null
  skillId: string | null
  author: string | null
  license: string | null
  repository: string | null
}> {
  try {
    const content = await readFile(join(skillPath, 'SKILL.md'), 'utf-8')
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')
    const parser = new SkillParser()
    const parsed = parser.parse(content)
    const parsedAny = parsed as unknown as Record<string, unknown>
    const skillId = (parsedAny['id'] as string | undefined) ?? null
    return {
      contentHash,
      skillId,
      author: parsed?.author ?? null,
      license: parsed?.license ?? null,
      repository: parsed?.repository ?? null,
    }
  } catch {
    return { contentHash: null, skillId: null, author: null, license: null, repository: null }
  }
}

/**
 * Returns one {@link HarnessSkillEntry} per (harness × skill) observed on
 * disk.
 *
 * Unlike `getInstalledSkills()` (`skills-directory.ts`), this function:
 * - Does **not** deduplicate by skill name — the same skill present under two
 *   distinct harness directories appears as two rows (different `path`).
 * - Does **not** deduplicate by realpath ACROSS harnesses — a symlinked alias
 *   such as `~/.agents/skills/foo` → `~/.claude/skills/foo` still appears as
 *   two rows, one per harness, because cross-harness membership must be
 *   preserved. Realpath is used only to MEMOIZE the expensive
 *   `readSkillMd()` read/parse/hash: the underlying file is read once and
 *   the result reused for every harness that shares the realpath. A
 *   previous version used a bare realpath `Set` to drop the second row
 *   entirely, which silently collapsed legitimate cross-harness installs and
 *   contradicted this very docstring (GH #1912 / SMI-5717).
 * - DOES still deduplicate multiple aliases to the same realpath WITHIN a
 *   single harness's own directory (e.g. two symlinks in one harness's
 *   skills dir pointing at the same target) — that collapsing is correct and
 *   distinct from the cross-harness case above; it is preserved via a
 *   `(harness, realpath)` composite key rather than realpath alone.
 * - Enriches each entry with a sha256 `contentHash` computed from the
 *   SKILL.md content, for registry drift detection.
 *
 * Scan order (which harness's cached fields "win" on a memoization hit is
 * irrelevant since fields are realpath-identical either way): local (repo) >
 * claude-code > cursor > copilot > windsurf > agents, then (ADR-139,
 * SMI-6274 Wave 4) any other client's workspace directory found above `cwd`
 * — shares `buildScanTargets()` with `getInstalledSkills()` so the two scans
 * cannot drift on which directories are covered.
 *
 * @see SMI-5390
 */
export async function getInstalledSkillsPerHarness(): Promise<HarnessSkillEntry[]> {
  const targets = buildScanTargets(process.cwd())
  const lists = await Promise.all(
    targets.map((t) => getSkillsFromDirectory(t.dir, undefined, t.installedVia, t.scope))
  )
  const ordered = lists.flat()

  // Two independent, differently-scoped tracking structures (GH #1912 /
  // SMI-5717) — mirrors the core collector's design in
  // `packages/core/src/sync/inventory-collector.ts`:
  //
  // - `fieldsCache` (keyed by realpath ALONE) memoizes the expensive
  //   readSkillMd() read/parse/hash so a symlinked alias reuses cached
  //   fields instead of re-parsing.
  // - `emitted` (keyed by `${harness}:${realpath}`) tracks which
  //   (harness, realpath) pairs already produced a row, so a row is pushed
  //   exactly once per harness per underlying file: the same realpath under
  //   a DIFFERENT harness still gets its own row, while multiple aliases to
  //   the same realpath WITHIN one harness still collapse to one row for
  //   that harness. A single shared Set here used to conflate both cases.
  const fieldsCache = new Map<string, Awaited<ReturnType<typeof readSkillMd>>>()
  const emitted = new Set<string>()
  const out: HarnessSkillEntry[] = []
  for (const skill of ordered) {
    const rp = await safeRealpath(skill.path)

    const emittedKey = `${skill.installedVia}:${rp}`
    if (emitted.has(emittedKey)) continue
    emitted.add(emittedKey)

    let fields = fieldsCache.get(rp)
    if (!fields) {
      fields = await readSkillMd(skill.path)
      fieldsCache.set(rp, fields)
    }
    const { contentHash, skillId: parsedId, author, license, repository } = fields
    out.push({
      harness: skill.installedVia,
      skillId: parsedId ?? skill.name,
      version: skill.version,
      contentHash,
      path: skill.path,
      author,
      license,
      repository,
    })
  }
  return out
}
