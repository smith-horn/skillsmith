/**
 * SMI-2713: Extracted from manage.ts — helpers for reading installed skills
 * from the global and local ~/.claude/skills directories.
 */

import { readdir, readFile, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import {
  SkillParser,
  createDatabase,
  SkillVersionRepository,
  type TrustTier,
} from '@skillsmith/core'
import { DEFAULT_DB_PATH } from '../config.js'

export interface InstalledSkill {
  name: string
  path: string
  version: string | null
  trustTier: TrustTier
  installDate: string
  hasUpdates: boolean
}

/**
 * SMI-1630: Search both global and local skill directories
 *
 * Global: ~/.claude/skills/
 * Local: ${process.cwd()}/.claude/skills/
 *
 * Local skills take precedence over global skills with the same name.
 */
const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')

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
 * @param skillsDir Directory to scan for installed skills
 * @param dbPath    Optional path to the Skillsmith SQLite database
 */
export async function getSkillsFromDirectory(
  skillsDir: string,
  dbPath?: string
): Promise<InstalledSkill[]> {
  const skills: InstalledSkill[] = []

  // Open the version repository if a db path was provided
  let versionRepo: SkillVersionRepository | null = null
  let dbConn: ReturnType<typeof createDatabase> | null = null
  if (dbPath) {
    try {
      dbConn = createDatabase(dbPath)
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
 * Get list of installed skills from both global (~/.claude/skills) and
 * local (.claude/skills) directories.
 *
 * SMI-1630: Local skills take precedence over global skills with the same name.
 *
 * @param dbPath Optional path to the Skillsmith SQLite database for update detection
 */
export async function getInstalledSkills(dbPath?: string): Promise<InstalledSkill[]> {
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH
  // Get skills from both directories
  const [globalSkills, localSkills] = await Promise.all([
    getSkillsFromDirectory(GLOBAL_SKILLS_DIR, resolvedDbPath),
    getSkillsFromDirectory(getLocalSkillsDir(), resolvedDbPath),
  ])

  // Create a map for deduplication, local skills take precedence
  const skillMap = new Map<string, InstalledSkill>()

  // Add global skills first
  for (const skill of globalSkills) {
    skillMap.set(skill.name, skill)
  }

  // Add local skills (overwrites global skills with same name)
  for (const skill of localSkills) {
    skillMap.set(skill.name, skill)
  }

  return Array.from(skillMap.values())
}
