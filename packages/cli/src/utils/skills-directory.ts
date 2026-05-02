/**
 * SMI-2713: Extracted from manage.ts — helpers for reading installed skills
 * from the global and local ~/.claude/skills directories.
 */

import { readdir, readFile, realpath, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import {
  SkillParser,
  createDatabaseAsync,
  initializeSchema,
  SkillVersionRepository,
  type Database,
  type TrustTier,
} from '@skillsmith/core'
import {
  CANONICAL_CLIENT,
  CLIENT_IDS,
  CLIENT_NATIVE_PATHS,
  type ClientId,
} from '@skillsmith/core/install'
import { DEFAULT_DB_PATH } from '../config.js'

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
 * Returns the local skills directory path.
 * Computed at call time to handle working directory changes.
 */
function getLocalSkillsDir(): string {
  return join(process.cwd(), '.claude', 'skills')
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
      dbConn = await createDatabaseAsync(dbPath)
      initializeSchema(dbConn)
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
      if (entry.isDirectory()) {
        const skillPath = join(skillsDir, entry.name)
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
          // Only treat ENOENT (file not found) as "no SKILL.md"
          // Re-throw permission errors and other unexpected errors
          const errno = (error as NodeJS.ErrnoException).code
          if (errno !== 'ENOENT') {
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

  // Dedup by both skill name AND resolved path. Name-keying enforces the
  // precedence rule (local > canonical > others) when two clients carry
  // independently-installed copies of the same skill. Realpath-keying
  // collapses symlinked aliases (e.g. `~/.agents/skills` → `~/.claude/skills`)
  // so the symlinked entry doesn't appear twice when the second hop has a
  // different `installedVia` label.
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
