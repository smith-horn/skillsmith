/**
 * @fileoverview Shared skillId path-safety check for the private registry
 * @module @skillsmith/mcp-server/tools/registry-tools.skill-id
 * @see SMI-5905 final code review (Sol, GPT-5.6-Sol via NEEDLE) finding #1
 *
 * Split out of `registry-tools.ts` (510/500 lines once this check + its two `.refine()` call
 * sites landed) rather than folding into `registry-tools.content.types.ts`, which is a
 * types-only companion by its own header contract — this is runtime logic, not a type.
 */

/**
 * The bare `/^[^/]+\/[^/]+$/` author/name format check (`privateRegistryPublishInputSchema`,
 * `privateRegistryManageInputSchema`, and the identical checks duplicated in the Edge Function's
 * `access.ts` and the CLI's `registry-install.action.ts`) accepts `"."`/`".."` as either segment
 * — e.g. `"team-namespace/.."`. `installFromContent()` (`skill-installation.content.ts`) derives
 * the on-disk skill directory from the skillId's final segment, so an unvalidated `".."` collapses
 * the install path to the PARENT of the skills directory, letting a published skill overwrite a
 * file outside it — confirmed exploitable, since the same permissive pattern is also the
 * `private_registry_skills.skill_id` DB CHECK constraint, so nothing upstream of this rejects it
 * either. Every `skillId` schema in `registry-tools.ts` is `.refine()`d against this;
 * `installFromContent()` also re-validates defensively as the true last line of defense, since a
 * schema fix here does not protect a stub/test call site that bypasses Zod entirely.
 */
export function hasSafeSkillIdSegments(skillId: string): boolean {
  return skillId.split('/').every((segment) => {
    const trimmed = segment.trim()
    return trimmed.length > 0 && trimmed !== '.' && trimmed !== '..'
  })
}
