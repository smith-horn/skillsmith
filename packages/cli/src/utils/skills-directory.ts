/**
 * SMI-2713: Extracted from manage.ts — helpers for reading installed skills
 * from the global and local ~/.claude/skills directories.
 */

import { readdir, readFile, realpath, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import {
  SkillParser,
  SkillVersionRepository,
  type Database,
  type TrustTier,
} from '@skillsmith/core'
import { openCliDatabase } from './open-database.js'
import {
  CANONICAL_CLIENT,
  CLIENT_IDS,
  CLIENT_NATIVE_PATHS,
  type ClientId,
} from '@skillsmith/core/install'
import { DEFAULT_DB_PATH } from '../config.js'
import { getLocalSkillsDir, getLocalSkillsDirDisplay } from './local-skills-dir.js'

// SMI-6060: re-exported for existing call sites (manage.action.ts, tests) —
// the implementation itself lives in local-skills-dir.ts (extracted from
// this file to stay under the 500-line standard).
export { getLocalSkillsDir, getLocalSkillsDirDisplay }

export interface InstalledSkill {
  name: string
  path: string
  version: string | null
  trustTier: TrustTier
  installDate: string
  hasUpdates: boolean
  /**
   * SMI-4578: which client's directory this skill was discovered under.
   * `'local'` = repo-local `./.claude/skills`. Other values are
   * `ClientId` from the multi-client install table.
   */
  installedVia: ClientId | 'local'
}

/**
 * SMI-1630 + SMI-4578: discovery scans every client directory
 * (`CLIENT_NATIVE_PATHS`) plus repo-local `./.claude/skills`. Local
 * skills take precedence over global; canonical (`claude-code`) takes
 * precedence over secondary clients. See `getInstalledSkills` below.
 */

/**
 * Return `true` when a directory entry resolves to a directory, following
 * symlinks. `withFileTypes` reports a symlinked directory as a symlink (not
 * a directory), so `entry.isDirectory()` alone silently skips a symlinked
 * INDIVIDUAL skill directory — exactly GH #1912's own repro
 * (`ln -s ~/.claude/skills/foo ~/.cursor/skills/foo`). Independent twin of
 * `resolvesToDirectory()` in `packages/core/src/sync/inventory-collector.ts`
 * (SMI-5717).
 *
 * `isSymbolicLink` is optional-invoked (`?.`) because several pre-existing
 * tests (`manage.skills-directory.test.ts` et al.) mock `fs/promises.readdir`
 * with plain `{ name, isDirectory: () => true }` objects that don't implement
 * the full `Dirent` interface — those mocks never claim to be a symlink, so
 * treating a missing method as `false` preserves their existing behavior.
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
 * Get skills from a specific directory.
 *
 * When dbPath is provided, opens the skill_versions table to determine
 * whether a newer content hash has been recorded since the skill was installed.
 * Falls back to hasUpdates: false when the database is unavailable.
 *
 * @param skillsDir   Directory to scan for installed skills
 * @param dbPath      Optional path to the Skillsmith SQLite database
 * @param installedVia SMI-4578: which client (or `'local'`) this directory
 *                    represents — propagated onto each returned skill so
 *                    callers can render "installed via Cursor" badges.
 */
export async function getSkillsFromDirectory(
  skillsDir: string,
  dbPath?: string,
  installedVia: ClientId | 'local' = CANONICAL_CLIENT
): Promise<InstalledSkill[]> {
  const skills: InstalledSkill[] = []

  // Open the version repository if a db path was provided
  let versionRepo: SkillVersionRepository | null = null
  let dbConn: Database | null = null
  if (dbPath) {
    try {
      // SMI-5139: this is a pure-read version lookup — open read-only so the
      // WASM driver does not persist (write) on close() and throw EROFS when
      // dbPath is unwritable/absent. A read-only open of an absent db throws
      // (native driver), which the catch below degrades to hasUpdates: false.
      dbConn = await openCliDatabase(dbPath, { readonly: true })
      versionRepo = new SkillVersionRepository(dbConn)
    } catch {
      // DB not available yet — fall back to hasUpdates: false
      versionRepo = null
      dbConn = null
    }
  }

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })

    for (const entry of entries) {
      // Skip dot-prefixed directories: they are harness internals, not skills.
      // Covers .backups (created by apply_recommended_edit — SMI-5440) and any
      // other dot-dir that must not appear in inventory status. (SMI-5442)
      // Checked BEFORE resolvesToDirectory() so a dot-prefixed symlinked entry
      // never pays for a stat() call it's about to discard — matches the
      // core collector's ordering in `inventory-collector.ts`'s
      // `collectHarness()` (SMI-5717).
      if (entry.name.startsWith('.')) continue

      const skillPath = join(skillsDir, entry.name)
      // GH #1912 / SMI-5717: stat-resolve symlinked entries so an individually
      // symlinked skill directory is discovered too, not just real directories.
      const isSkillDir = await resolvesToDirectory(
        skillPath,
        entry.isDirectory(),
        entry.isSymbolicLink?.() ?? false
      )
      if (isSkillDir) {
        const skillMdPath = join(skillPath, 'SKILL.md')

        try {
          const skillMdStat = await stat(skillMdPath)
          const content = await readFile(skillMdPath, 'utf-8')
          const parser = new SkillParser()
          const parsed = parser.parse(content)

          // Determine hasUpdates by comparing the current SKILL.md hash to the
          // most-recently recorded hash in skill_versions for this skill id.
          let hasUpdates = false
          if (versionRepo && parsed) {
            try {
              const parsedAny = parsed as unknown as Record<string, unknown>
              const skillId = (parsedAny['id'] as string | undefined) ?? entry.name
              const latestVersion = await versionRepo.getLatestVersion(skillId)
              if (latestVersion) {
                const currentHash = createHash('sha256').update(content, 'utf8').digest('hex')
                const storedHash =
                  (parsedAny['contentHash'] as string | undefined) ??
                  (parsedAny['originalContentHash'] as string | undefined) ??
                  ''
                // hasUpdates = latest recorded hash differs from what we have locally
                hasUpdates = storedHash !== '' && latestVersion.content_hash !== storedHash
                // If we have no stored hash, compare against current content hash
                if (!storedHash) {
                  hasUpdates = latestVersion.content_hash !== currentHash
                }
              }
            } catch {
              // Version check failed — safe to ignore, fall back to false
              hasUpdates = false
            }
          }

          skills.push({
            name: parsed?.name || entry.name,
            path: skillPath,
            version: parsed?.version || null,
            trustTier: parsed ? parser.inferTrustTier(parsed) : 'unknown',
            installDate: skillMdStat.mtime.toISOString().split('T')[0] || 'Unknown',
            hasUpdates,
            installedVia,
          })
        } catch (error) {
          // ENOENT: SKILL.md absent — treat as unknown skill.
          // EISDIR: SKILL.md is itself a directory (e.g. .backups/SKILL.md created
          // by apply_recommended_edit — SMI-5440). Treat the same as absent.
          // Re-throw permission errors and other unexpected errors.
          const errno = (error as NodeJS.ErrnoException).code
          if (errno !== 'ENOENT' && errno !== 'EISDIR') {
            throw error
          }

          // No SKILL.md, treat as unknown skill
          const dirStat = await stat(skillPath)
          skills.push({
            name: entry.name,
            path: skillPath,
            version: null,
            trustTier: 'unknown',
            installDate: dirStat.mtime.toISOString().split('T')[0] || 'Unknown',
            hasUpdates: false,
            installedVia,
          })
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  } finally {
    dbConn?.close()
  }

  return skills
}

/**
 * Resolve a path through `realpath` defensively. Returns the resolved
 * path on success, or the input path unchanged if the path is missing
 * or unreadable — dedup keying still works either way (we just won't
 * collapse symlinked aliases when the link is broken).
 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return p
  }
}

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
 * Unlike {@link getInstalledSkills}, this function:
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
 * claude-code > cursor > copilot > windsurf > agents. Inherits the SMI-4578
 * ordering.
 *
 * @see SMI-5390
 */
export async function getInstalledSkillsPerHarness(): Promise<HarnessSkillEntry[]> {
  const localScan = getSkillsFromDirectory(getLocalSkillsDir(), undefined, 'local')
  const clientScans = CLIENT_IDS.map((client) =>
    getSkillsFromDirectory(CLIENT_NATIVE_PATHS[client], undefined, client)
  )

  const [localSkills, ...clientSkillsLists] = await Promise.all([localScan, ...clientScans])

  // Same precedence order as getInstalledSkills — local first, then
  // canonical, then remaining clients.
  const ordered: InstalledSkill[] = [...localSkills]
  const canonicalIdx = CLIENT_IDS.indexOf(CANONICAL_CLIENT)
  if (canonicalIdx >= 0 && clientSkillsLists[canonicalIdx]) {
    ordered.push(...clientSkillsLists[canonicalIdx])
  }
  for (let i = 0; i < CLIENT_IDS.length; i++) {
    if (i === canonicalIdx) continue
    const list = clientSkillsLists[i]
    if (list) ordered.push(...list)
  }

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

/**
 * Get list of installed skills across every client directory.
 *
 * SMI-4578: scans the union of `CLIENT_NATIVE_PATHS` (claude-code,
 * cursor, copilot, windsurf, agents) plus repo-local
 * `./.claude/skills`. Results are deduplicated by `realpath` so a
 * symlinked `~/.agents/skills/foo` pointing at `~/.claude/skills/foo`
 * is reported once. Each entry carries `installedVia` so the caller
 * can render "installed via Cursor" badges.
 *
 * Precedence (first wins after dedup): local (repo) > claude-code >
 * cursor > copilot > windsurf > agents. This keeps the SMI-1630
 * promise that repo-local overrides global.
 *
 * @param dbPath Optional path to the Skillsmith SQLite database for
 *               update detection.
 */
/**
 * Dedup a precedence-ordered list of scan results by both skill name AND
 * resolved path. Name-keying enforces "first entry in the array wins" when
 * two directories carry independently-installed copies of the same skill.
 * Realpath-keying collapses symlinked aliases (e.g. `~/.agents/skills` ->
 * `~/.claude/skills`) so the symlinked entry doesn't appear twice when the
 * second hop has a different `installedVia` label.
 *
 * Shared by {@link getInstalledSkills} (dedupes across every client) and
 * {@link getInstalledSkillsForClient} (dedupes across just local + one
 * client) so the two functions can't drift on dedup semantics (SMI-5894).
 */
async function dedupeByNameAndPath(ordered: InstalledSkill[]): Promise<InstalledSkill[]> {
  const seenNames = new Set<string>()
  const seenPaths = new Set<string>()
  const out: InstalledSkill[] = []
  for (const skill of ordered) {
    if (seenNames.has(skill.name)) continue
    const realPath = await safeRealpath(skill.path)
    if (seenPaths.has(realPath)) continue
    seenNames.add(skill.name)
    seenPaths.add(realPath)
    out.push(skill)
  }
  return out
}

export async function getInstalledSkills(dbPath?: string): Promise<InstalledSkill[]> {
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH

  const localScan = getSkillsFromDirectory(getLocalSkillsDir(), resolvedDbPath, 'local')
  const clientScans = CLIENT_IDS.map((client) =>
    getSkillsFromDirectory(CLIENT_NATIVE_PATHS[client], resolvedDbPath, client)
  )

  const [localSkills, ...clientSkillsLists] = await Promise.all([localScan, ...clientScans])

  // Precedence order: local first, then canonical, then the rest.
  const ordered: InstalledSkill[] = [...localSkills]
  const canonicalIdx = CLIENT_IDS.indexOf(CANONICAL_CLIENT)
  if (canonicalIdx >= 0 && clientSkillsLists[canonicalIdx]) {
    ordered.push(...clientSkillsLists[canonicalIdx])
  }
  for (let i = 0; i < CLIENT_IDS.length; i++) {
    if (i === canonicalIdx) continue
    const list = clientSkillsLists[i]
    if (list) ordered.push(...list)
  }

  return dedupeByNameAndPath(ordered)
}

/**
 * SMI-5894 (Wave 1 Steps 2/3): like {@link getInstalledSkills}, but scoped
 * to a single resolved client's directory instead of scanning + deduping
 * across every client.
 *
 * Repo-local skills (`./.claude/skills`) still take precedence, matching
 * the SMI-1630 "repo-local overrides global" rule `getInstalledSkills()`
 * already applies — local skills aren't tied to any particular client's
 * harness config, so they stay in scope regardless of which client is
 * targeted.
 *
 * This is what lets `remove`/`update --client cursor` resolve unambiguously
 * to the Cursor copy of a same-named skill, instead of being silently
 * redirected to a different client's copy by {@link getInstalledSkills}'s
 * global cross-client dedup (which keeps whichever client wins precedence,
 * not necessarily the one the caller asked about).
 */
export async function getInstalledSkillsForClient(
  client: ClientId,
  dbPath?: string
): Promise<InstalledSkill[]> {
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH

  const [localSkills, clientSkills] = await Promise.all([
    getSkillsFromDirectory(getLocalSkillsDir(), resolvedDbPath, 'local'),
    getSkillsFromDirectory(CLIENT_NATIVE_PATHS[client], resolvedDbPath, client),
  ])

  return dedupeByNameAndPath([...localSkills, ...clientSkills])
}
