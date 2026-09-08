/**
 * Shared skill name validation utilities.
 *
 * Used by both `skillsmith author init` and `skillsmith create` to enforce
 * a consistent, registry-safe naming convention across all scaffolding paths.
 */

/**
 * Valid skill names: lowercase letters, digits, and hyphens only.
 * Must start with a lowercase letter.
 * Matches the Skillsmith registry slug format.
 */
export const VALID_SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/

/**
 * Validate a skill name against the canonical Skillsmith naming convention.
 *
 * @returns `true` if valid, or a string error message if invalid.
 */
export function validateSkillName(name: string): true | string {
  if (!name.trim()) return 'Skill name is required'
  if (!VALID_SKILL_NAME_RE.test(name)) {
    return 'Skill name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (e.g. my-skill)'
  }
  return true
}
