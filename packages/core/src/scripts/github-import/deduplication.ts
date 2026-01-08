/**
 * SMI-860: Deduplication for imported skills
 */

import { createHash } from 'crypto'
import { ImportedSkill } from './types.js'

/**
 * Deduplicates skills by repository URL, keeping the most recently updated version.
 *
 * @param skills - Array of skills that may contain duplicates
 * @returns Object containing unique skills and duplicate count
 */
export function deduplicateSkills(skills: ImportedSkill[]): {
  unique: ImportedSkill[]
  duplicateCount: number
} {
  const seen = new Map<string, ImportedSkill>()

  for (const skill of skills) {
    // Normalize key by repo URL
    const key = createHash('md5').update(skill.repo_url.toLowerCase()).digest('hex')

    const existing = seen.get(key)
    if (existing) {
      // Keep the more recently updated version
      if (new Date(skill.updated_at) > new Date(existing.updated_at)) {
        seen.set(key, skill)
      }
    } else {
      seen.set(key, skill)
    }
  }

  const unique = Array.from(seen.values())
  return {
    unique,
    duplicateCount: skills.length - unique.length,
  }
}
