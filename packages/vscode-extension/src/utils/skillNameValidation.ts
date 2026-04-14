// AUTO-GENERATED from packages/cli/src/utils/skill-name.ts (SMI-4194).
// DO NOT EDIT BY HAND. Regenerate with:
//   node scripts/sync-skill-name-validation.mjs
// audit:standards enforces drift between this copy and the CLI source.
// The VS Code extension cannot import @skillsmith/cli per ADR-113; this
// codegen preserves parity without creating a runtime dependency.

export const VALID_SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/

export function validateSkillName(name: string): true | string {
  if (!name.trim()) return 'Skill name is required'
  if (!VALID_SKILL_NAME_RE.test(name)) {
    return 'Skill name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (e.g. my-skill)'
  }
  return true
}
