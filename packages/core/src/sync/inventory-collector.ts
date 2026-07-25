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
 * - Realpath-memoizes the expensive SKILL.md read/parse/hash ACROSS harnesses
 *   (a symlinked alias is parsed only once), but does NOT drop the emitted
 *   entry for it — one row is still emitted per harness, since the same skill
 *   independently installed (or symlink-aliased) under two harnesses must
 *   remain two distinct rows (the `device_skills` PK is `(harness, skill_id)`).
 *   A shared `Set<realpath>` here used to also skip the push whenever the
 *   SAME realpath recurred under a DIFFERENT harness, collapsing legitimate
 *   cross-harness membership (GH #1912 / SMI-5717). The fix keys the
 *   memoization cache by realpath alone (safe — it's for parse-cost reuse
 *   only) but keys emitted-row tracking by `(harness, realpath)` (so a
 *   within-harness alias still collapses to one row, while a cross-harness
 *   one does not).
 *
 * @module @skillsmith/core/sync/inventory-collector
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { SkillParser } from '../indexer/SkillParser.js'
import { CLIENT_IDS, CLIENT_NATIVE_PATHS, type ClientId } from '../install/paths.js'
import type { InventorySkillEntry } from './inventory-types.js'
import { sha256Hex } from '../journal/hash.js'

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
 * Read `<skillDir>/SKILL.md` and derive the realpath-INVARIANT inventory
 * fields — i.e. only what's derivable from file content, safe to memoize by
 * realpath across harnesses (see {@link collectHarness}).
 *
 * - `content_hash` is the sha256 hex digest of the raw SKILL.md content. Wave 5
 *   validates that this hashing stays drift-aligned with the indexer's hashing.
 * - `skillId` is the parsed `id` front-matter field, falling back to the parsed
 *   `name`, or `null` when neither is present (same precedence as the CLI
 *   scanner). It is intentionally NOT defaulted to a directory name here: two
 *   harnesses can observe the SAME realpath under DIFFERENT directory names
 *   (e.g. a symlink renamed on the far end), so the directory-name fallback
 *   must be applied per-harness by the caller using ITS OWN dirent name, never
 *   cached — caching it here would let whichever harness populated the cache
 *   first silently overwrite the other harness's directory-derived id
 *   (GH #1912 / SMI-5717).
 * - `author`, `license`, `repository` are self-asserted values from the SKILL.md
 *   front-matter (SMI-5442 Wave 3). They are `null` when absent or unparseable.
 */
async function readSkillFields(skillDir: string): Promise<{
  skillId: string | null
  version: string | null
  contentHash: string | null
  author: string | null
  license: string | null
  repository: string | null
}> {
  try {
    const content = await readFile(join(skillDir, 'SKILL.md'), 'utf-8')
    const contentHash = sha256Hex(content)
    const parsed = new SkillParser().parse(content)
    if (!parsed) {
      // SKILL.md is readable but has no valid frontmatter — hash still applies.
      return {
        skillId: null,
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
      skillId: parsedId ?? parsed.name ?? null,
      version: parsed.version ?? null,
      contentHash,
      author: parsed.author ?? null,
      license: parsed.license ?? null,
      repository: parsed.repository ?? null,
    }
  } catch {
    // No readable SKILL.md — still a skill, but version/hash/provenance are unknown.
    return {
      skillId: null,
      version: null,
      contentHash: null,
      author: null,
      license: null,
      repository: null,
    }
  }
}

/**
 * Scan a single harness directory and append its skills to `entries`.
 *
 * Two independent, differently-scoped tracking structures are threaded
 * through every harness scan (GH #1912 / SMI-5717):
 *
 * - `fieldsCache` (keyed by realpath ALONE) memoizes the expensive
 *   `readSkillFields()` parse/hash so a symlinked alias observed under a
 *   later harness reuses the cached fields instead of re-reading/
 *   re-parsing/re-hashing SKILL.md.
 * - `emitted` (keyed by `` `${harness}:${realpath}` ``) tracks which
 *   (harness, realpath) pairs have already produced a row, so an entry is
 *   pushed exactly once per harness per underlying file. This preserves TWO
 *   distinct behaviors at once: (a) the same realpath observed under
 *   DIFFERENT harnesses still gets a row EACH time (cross-harness membership
 *   — this is the bug this fix restores), and (b) multiple aliases to the
 *   SAME realpath WITHIN one harness's own directory still collapse to a
 *   single row for that harness (this dedup was already correct and must
 *   not regress). A single shared Set here used to conflate both cases,
 *   collapsing (a) as if it were (b).
 */
async function collectHarness(
  harness: ClientId,
  entries: InventorySkillEntry[],
  fieldsCache: Map<string, Awaited<ReturnType<typeof readSkillFields>>>,
  emitted: Set<string>
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

    const realDir = await safeRealpath(entryPath)

    // Emit at most once per (harness, realpath): collapses multiple aliases
    // to the same target WITHIN this harness, but — unlike the pre-fix
    // behavior — never collapses the same realpath observed under a
    // DIFFERENT harness, since the key includes `harness`.
    const emittedKey = `${harness}:${realDir}`
    if (emitted.has(emittedKey)) continue
    emitted.add(emittedKey)

    // Realpath memoization ACROSS harnesses: the expensive SKILL.md
    // read/parse/hash is performed only once per underlying file.
    let fields = fieldsCache.get(realDir)
    if (!fields) {
      fields = await readSkillFields(entryPath)
      fieldsCache.set(realDir, fields)
    }
    const { skillId, version, contentHash, author, license, repository } = fields
    entries.push({
      harness,
      // skillId falls back to THIS dirent's own name — never cached (see
      // readSkillFields()'s docstring) — so a shared realpath with a
      // different directory name under another harness doesn't leak in.
      skill_id: skillId ?? dirent.name,
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
 * @returns One entry per (harness, skill). `readSkillFields()` is memoized by
 *   realpath across harnesses to avoid redundant parsing, but every harness
 *   that observes the skill still gets its own row (GH #1912 / SMI-5717).
 * @see SMI-5392
 */
export async function collectDeviceSkills(): Promise<InventorySkillEntry[]> {
  const entries: InventorySkillEntry[] = []
  const fieldsCache = new Map<string, Awaited<ReturnType<typeof readSkillFields>>>()
  const emitted = new Set<string>()
  for (const harness of CLIENT_IDS) {
    await collectHarness(harness, entries, fieldsCache, emitted)
  }
  return entries
}
