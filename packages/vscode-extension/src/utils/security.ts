/**
 * Security utilities for the Skillsmith VS Code extension
 */

/**
 * Escapes HTML entities to prevent XSS attacks
 * @param unsafe - The string that may contain HTML entities
 * @returns The escaped string safe for HTML interpolation
 */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Validates a skill ID to prevent path traversal attacks
 * Only allows alphanumeric characters, hyphens, and underscores
 * @param skillId - The skill ID to validate
 * @returns true if the skill ID is safe, false otherwise
 */
export function isValidSkillId(skillId: string): boolean {
  // Must be non-empty
  if (!skillId || skillId.trim().length === 0) {
    return false
  }

  // Only allow safe characters: alphanumeric, hyphens, underscores
  const safePattern = /^[a-zA-Z0-9_-]+$/
  if (!safePattern.test(skillId)) {
    return false
  }

  // Prevent reserved names
  const reservedNames = ['.', '..', 'con', 'prn', 'aux', 'nul']
  if (reservedNames.includes(skillId.toLowerCase())) {
    return false
  }

  // Reasonable length limit
  if (skillId.length > 128) {
    return false
  }

  return true
}

/**
 * Sanitizes a skill ID by removing unsafe characters
 * @param skillId - The skill ID to sanitize
 * @returns The sanitized skill ID
 */
export function sanitizeSkillId(skillId: string): string {
  return skillId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128)
}
