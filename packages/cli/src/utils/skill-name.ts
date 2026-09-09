/**
 * Shared skill name validation utilities.
 *
 * Relocated to @skillsmith/core (SMI-6472) — @skillsmith/core is now
 * the canonical source. This file remains as a re-export so existing CLI
 * import paths (`../utils/skill-name.js`, `../../utils/skill-name.js`)
 * continue to resolve without touching every call site.
 *
 * Imports from the narrow `@skillsmith/core/utils/skill-name` subpath, not
 * the package barrel (`@skillsmith/core`) — this file previously had zero
 * dependencies, and CLI commands importing it (e.g. `create.ts`) don't
 * expect to transitively pull in the rest of core's surface (e.g.
 * `skill-installation.io.ts` -> `safe-fs.ts`'s `fs/promises` needs), which
 * broke `packages/cli/tests/create.test.ts`'s narrow `fs/promises` mock.
 */
export { VALID_SKILL_NAME_RE, validateSkillName } from '@skillsmith/core/utils/skill-name'
