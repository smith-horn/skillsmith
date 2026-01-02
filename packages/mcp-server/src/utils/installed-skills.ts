/**
 * @fileoverview Utility for auto-detecting installed skills from ~/.claude/skills/
 * @module @skillsmith/mcp-server/utils/installed-skills
 * @see SMI-906: Auto-detect installed skills from ~/.claude/skills/
 *
 * Scans the user's skills directory and extracts skill IDs from SKILL.md files.
 * Falls back to folder name if no SKILL.md or no ID found in frontmatter.
 *
 * @example
 * const skills = await getInstalledSkills();
 * // Returns: ["docker", "linear", "varlock"]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Default skills directory path
 */
const DEFAULT_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')

/**
 * Result from parsing a SKILL.md file
 */
interface SkillMdParsed {
  /** Skill ID from name field */
  id: string | null
  /** Skill name from name field */
  name: string | null
  /** Skill description from description field */
  description: string | null
}

/**
 * Parse SKILL.md frontmatter to extract skill metadata.
 *
 * Extracts the `name` field from YAML frontmatter in SKILL.md files.
 * Frontmatter is delimited by `---` lines at the start of the file.
 *
 * @param content - Content of the SKILL.md file
 * @returns Parsed skill metadata, or null values if parsing fails
 *
 * @example
 * const content = `---
 * name: docker
 * description: Docker skill
 * ---
 * # Docker Skill`;
 * parseSkillMd(content); // { id: "docker", name: "docker", description: "Docker skill" }
 */
export function parseSkillMd(content: string): SkillMdParsed {
  const result: SkillMdParsed = {
    id: null,
    name: null,
    description: null,
  }

  // Check for frontmatter (starts with ---)
  if (!content.startsWith('---')) {
    return result
  }

  // Find the closing --- delimiter
  const secondDelimiterIndex = content.indexOf('---', 3)
  if (secondDelimiterIndex === -1) {
    return result
  }

  // Extract frontmatter content
  const frontmatter = content.substring(3, secondDelimiterIndex).trim()

  // Parse YAML-like frontmatter (simple key: value parsing)
  const lines = frontmatter.split('\n')
  for (const line of lines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.substring(0, colonIndex).trim().toLowerCase()
    const value = line.substring(colonIndex + 1).trim()

    if (key === 'name' && value) {
      result.name = value
      result.id = value // Use name as the skill ID
    } else if (key === 'description' && value) {
      result.description = value
    }
  }

  return result
}

/**
 * Get the skill ID from a skill directory.
 *
 * Looks for SKILL.md in the directory and extracts the ID from frontmatter.
 * Falls back to the directory name if no SKILL.md or no ID found.
 *
 * @param skillDir - Path to the skill directory
 * @param dirName - Name of the directory (used as fallback)
 * @returns Skill ID
 */
export function getSkillIdFromDir(skillDir: string, dirName: string): string {
  const skillMdPath = path.join(skillDir, 'SKILL.md')

  try {
    if (fs.existsSync(skillMdPath)) {
      const content = fs.readFileSync(skillMdPath, 'utf-8')
      const parsed = parseSkillMd(content)
      if (parsed.id) {
        return parsed.id
      }
    }
  } catch (error) {
    console.warn(
      '[installed-skills] Failed to parse SKILL.md:',
      skillMdPath,
      error instanceof Error ? error.message : String(error)
    )
  }

  return dirName
}

/**
 * Auto-detect installed skills from ~/.claude/skills/ directory.
 *
 * Scans the skills directory for subdirectories containing SKILL.md files.
 * Extracts the skill ID from the `name` field in SKILL.md frontmatter.
 * Falls back to directory name if no SKILL.md or no name field found.
 *
 * @param skillsDir - Optional custom skills directory path (defaults to ~/.claude/skills/)
 * @returns Promise resolving to array of skill IDs
 *
 * @example
 * const skills = await getInstalledSkills();
 * // Returns: ["docker", "linear", "varlock"]
 *
 * @example
 * // With custom directory
 * const skills = await getInstalledSkills('/path/to/custom/skills');
 */
export async function getInstalledSkills(skillsDir?: string): Promise<string[]> {
  const dir = skillsDir || DEFAULT_SKILLS_DIR

  // Check if directory exists
  if (!fs.existsSync(dir)) {
    return []
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const skillIds: string[] = []

    for (const entry of entries) {
      // Skip non-directories and hidden directories
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue
      }

      const skillDir = path.join(dir, entry.name)
      const skillId = getSkillIdFromDir(skillDir, entry.name)
      skillIds.push(skillId)
    }

    return skillIds.sort()
  } catch (error) {
    console.warn(
      '[installed-skills] Failed to read skills directory:',
      dir,
      error instanceof Error ? error.message : String(error)
    )
    return []
  }
}

/**
 * Synchronous version of getInstalledSkills for use in non-async contexts.
 *
 * @param skillsDir - Optional custom skills directory path (defaults to ~/.claude/skills/)
 * @returns Array of skill IDs
 */
export function getInstalledSkillsSync(skillsDir?: string): string[] {
  const dir = skillsDir || DEFAULT_SKILLS_DIR

  // Check if directory exists
  if (!fs.existsSync(dir)) {
    return []
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const skillIds: string[] = []

    for (const entry of entries) {
      // Skip non-directories and hidden directories
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue
      }

      const skillDir = path.join(dir, entry.name)
      const skillId = getSkillIdFromDir(skillDir, entry.name)
      skillIds.push(skillId)
    }

    return skillIds.sort()
  } catch (error) {
    console.warn(
      '[installed-skills] Failed to read skills directory:',
      dir,
      error instanceof Error ? error.message : String(error)
    )
    return []
  }
}

/**
 * Get detailed information about installed skills.
 *
 * Returns full parsed information from SKILL.md files, not just IDs.
 *
 * @param skillsDir - Optional custom skills directory path
 * @returns Array of skill information objects
 */
export interface InstalledSkillInfo {
  /** Skill ID (from name field or directory name) */
  id: string
  /** Directory name */
  directory: string
  /** Full path to skill directory */
  path: string
  /** Whether SKILL.md was found */
  hasSkillMd: boolean
  /** Description from SKILL.md if available */
  description: string | null
}

export async function getInstalledSkillsDetailed(
  skillsDir?: string
): Promise<InstalledSkillInfo[]> {
  const dir = skillsDir || DEFAULT_SKILLS_DIR

  // Check if directory exists
  if (!fs.existsSync(dir)) {
    return []
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const skills: InstalledSkillInfo[] = []

    for (const entry of entries) {
      // Skip non-directories and hidden directories
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue
      }

      const skillDir = path.join(dir, entry.name)
      const skillMdPath = path.join(skillDir, 'SKILL.md')
      let hasSkillMd = false
      let description: string | null = null
      let id = entry.name

      try {
        if (fs.existsSync(skillMdPath)) {
          hasSkillMd = true
          const content = fs.readFileSync(skillMdPath, 'utf-8')
          const parsed = parseSkillMd(content)
          if (parsed.id) {
            id = parsed.id
          }
          description = parsed.description
        }
      } catch (error) {
        console.warn(
          '[installed-skills] Failed to parse SKILL.md for detailed info:',
          skillMdPath,
          error instanceof Error ? error.message : String(error)
        )
      }

      skills.push({
        id,
        directory: entry.name,
        path: skillDir,
        hasSkillMd,
        description,
      })
    }

    return skills.sort((a, b) => a.id.localeCompare(b.id))
  } catch (error) {
    console.warn(
      '[installed-skills] Failed to get detailed skills:',
      dir,
      error instanceof Error ? error.message : String(error)
    )
    return []
  }
}
