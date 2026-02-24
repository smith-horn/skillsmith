/**
 * SMI-2713: Extracted from manage.ts — helpers for reading installed skills
 * from the global and local ~/.claude/skills directories.
 */

import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { SkillParser, type TrustTier } from '@skillsmith/core'

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
 * Get skills from a specific directory
 */
export async function getSkillsFromDirectory(skillsDir: string): Promise<InstalledSkill[]> {
  const skills: InstalledSkill[] = []

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

          skills.push({
            name: parsed?.name || entry.name,
            path: skillPath,
            version: parsed?.version || null,
            trustTier: parsed ? parser.inferTrustTier(parsed) : 'unknown',
            installDate: skillMdStat.mtime.toISOString().split('T')[0] || 'Unknown',
            hasUpdates: false, // Would check remote for updates
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
  }

  return skills
}

/**
 * Get list of installed skills from both global (~/.claude/skills) and
 * local (./claude/skills) directories.
 *
 * SMI-1630: Local skills take precedence over global skills with the same name.
 */
export async function getInstalledSkills(): Promise<InstalledSkill[]> {
  // Get skills from both directories
  const [globalSkills, localSkills] = await Promise.all([
    getSkillsFromDirectory(GLOBAL_SKILLS_DIR),
    getSkillsFromDirectory(getLocalSkillsDir()),
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
