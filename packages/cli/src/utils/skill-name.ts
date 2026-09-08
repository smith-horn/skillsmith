/**
 * Shared skill name validation utilities.
 *
 * Relocated to @skillsmith/core (SMI-6472) — @skillsmith/core is now
 * the canonical source. This file remains as a re-export so existing CLI
 * import paths (`../utils/skill-name.js`, `../../utils/skill-name.js`)
 * continue to resolve without touching every call site.
 */
export { VALID_SKILL_NAME_RE, validateSkillName } from '@skillsmith/core'
