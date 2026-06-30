/**
 * Cross-harness skill collector (SMI-5392, umbrella SMI-5382).
 *
 * Walks every known harness skill directory (`CLIENT_NATIVE_PATHS`) and emits
 * one {@link InventorySkillEntry} per (harness, skill) observed on disk. This is
 * the shared scanner that both the CLI `inventory push` command (Wave 3) and the
 * MCP inventory tool call before handing the snapshot to {@link uploadInventory}.
 *
 * Design parity with the CLI scanner at
 * `packages/cli/src/utils/skills-directory.ts`:
 * - Uses the SAME {@link SkillParser} to resolve `skill_id` / `version`.
 * - Realpath-deduplicates ACROSS harnesses (collapses symlink aliases), but does
 *   NOT name-deduplicate — the same skill independently installed under two
 *   harnesses is two distinct rows (the `device_skills` PK is `(harness, skill_id)`).
 *
 * @module @skillsmith/core/sync/inventory-collector
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SkillParser } from '../indexer/SkillParser.js'
import { CLIENT_IDS, CLIENT_NATIVE_PATHS, type ClientId } from '../install/paths.js'
import type { InventorySkillEntry } from './inventory-types.js'

/**
 * Resolve a path through `realpath` defensively. Returns the resolved path on
 * success, or the input path unchanged when the link is broken / unreadable —
 * dedup keying still works either way (we just can't collapse a broken alias).
 */
async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Return `true` when a directory entry resolves to a directory, following
 * symlinks. `withFileTypes` reports a symlinked directory as a symlink (not a
 * directory), so symlinked aliases must be `stat`-resolved to be collected —
 * which is exactly what makes the cross-harness realpath dedup observable.
 */
async function resolvesToDirectory(
  entryPath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean
): Promise<boolean> {
  if (isDirectory) return true
  if (!isSymbolicLink) return false
  try {
    return (await stat(entryPath)).isDirectory()
  } catch {
    return false // broken symlink
  }
}

/**
 * Read `<skillDir>/SKILL.md` and derive the inventory fields.
 *
 * - `content_hash` is the sha256 hex digest of the raw SKILL.md content. Wave 5
 *   validates that this hashing stays drift-aligned with the indexer's hashing.
 * - `skill_id` is the parsed `id` front-matter field, falling back to the parsed
 *   `name`, then the directory name (same precedence as the CLI scanner).
 * - A directory with no readable SKILL.md still counts as a skill: `skill_id` is
 *   the directory name, with `version`, `content_hash`, and provenance fields `null`.
 * - `author`, `license`, `repository` are self-asserted values from the SKILL.md
 *   front-matter (SMI-5442 Wave 3). They are `null` when absent or unparseable.
 */
async function readSkillFields(
  skillDir: string,
  dirName: string
): Promise<{
  skillId: string
  version: string | null
  contentHash: string | null
  author: string | null
  license: string | null
  repository: string | null
}> {
  try {
    const content = await readFile(join(skillDir, 'SKILL.md'), 'utf-8')
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')
    const parsed = new SkillParser().parse(content)
    if (!parsed) {
      // SKILL.md is readable but has no valid frontmatter — hash still applies.
      return {
        skillId: dirName,
        version: null,
        contentHash,
        author: null,
        license: null,
        repository: null,
      }
    }
    // Match the CLI scanner: read `id` off the parsed metadata, then `name`.
    const parsedId = (parsed as unknown as Record<string, unknown>)['id'] as string | undefined
    return {
      skillId: parsedId ?? parsed.name ?? dirName,
      version: parsed.version ?? null,
      contentHash,
      author: parsed.author ?? null,
      license: parsed.license ?? null,
      repository: parsed.repository ?? null,
    }
  } catch {
    // No readable SKILL.md — still a skill, but version/hash/provenance are unknown.
    return {
      skillId: dirName,
      version: null,
      contentHash: null,
      author: null,
      license: null,
      repository: null,
    }
  }
}

/**
 * Scan a single harness directory and append its skills to `entries`,
 * deduplicating by realpath via the shared `seenRealpaths` set.
 */
async function collectHarness(
  harness: ClientId,
  entries: InventorySkillEntry[],
  seenRealpaths: Set<string>
): Promise<void> {
  const harnessDir = CLIENT_NATIVE_PATHS[harness]

  let dirents: Dirent[]
  try {
    dirents = await readdir(harnessDir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Absent harness dir is the common case (harness not installed) — skip it.
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }

  for (const dirent of dirents) {
    // Skip dot-prefixed directories: they are harness internals, not skills.
    // Covers .backups (created by apply_recommended_edit — SMI-5440) and any
    // other dot-dir that must not surface as inventory rows. (SMI-5442)
    if (dirent.name.startsWith('.')) continue

    const entryPath = join(harnessDir, dirent.name)
    if (!(await resolvesToDirectory(entryPath, dirent.isDirectory(), dirent.isSymbolicLink()))) {
      continue
    }

    // Realpath dedup ACROSS harnesses: the first harness in CLIENT_IDS order
    // wins, so a symlinked alias under a later harness is collapsed away.
    const realDir = await safeRealpath(entryPath)
    if (seenRealpaths.has(realDir)) continue
    seenRealpaths.add(realDir)

    const { skillId, version, contentHash, author, license, repository } = await readSkillFields(
      entryPath,
      dirent.name
    )
    entries.push({
      harness,
      skill_id: skillId,
      version,
      content_hash: contentHash,
      source: null,
      author,
      license,
      repository,
      pinned_version: null,
      update_policy: null,
    })
  }
}

/**
 * Collect every harness-installed skill on this device as inventory entries.
 *
 * Scans each harness in {@link CLIENT_IDS} order. Repo-local `./.claude/skills`
 * is intentionally excluded — inventory tracks harness-installed skills only, and
 * `harness` is always a {@link ClientId}, never `'local'`.
 *
 * The result is NOT truncated to `INVENTORY_LIMITS.MAX_SKILLS`. Exceeding
 * the cap is a real condition the caller / edge function must enforce (returning
 * a `too_many_skills` 400) — silently dropping skills here would corrupt the
 * server-side reconcile by making present skills look absent.
 *
 * @returns One entry per (harness, skill), realpath-deduplicated across harnesses.
 * @see SMI-5392
 */
export async function collectDeviceSkills(): Promise<InventorySkillEntry[]> {
  const entries: InventorySkillEntry[] = []
  const seenRealpaths = new Set<string>()
  for (const harness of CLIENT_IDS) {
    await collectHarness(harness, entries, seenRealpaths)
  }
  return entries
}
