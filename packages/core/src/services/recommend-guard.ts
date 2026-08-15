/**
 * @fileoverview Shared empty-derived-stack guard for skill recommendations.
 * @module @skillsmith/core/services/recommend-guard
 * @see SMI-5896 (Wave 3, discovery-tool consistency): CLI `recommend` and MCP
 *   `skill_recommend` each derive a technology "stack" client-side — CLI from
 *   codebase analysis (`buildStackFromAnalysis`), MCP from installed skills +
 *   project context keywords — and either can legitimately derive `[]` (a
 *   non-Node stack, an all-devDeps project, or an unsupported language). The
 *   `skills-recommend` edge function hard-rejects an empty `stack` with a 400
 *   (defense in depth, intentionally unchanged by this fix — see the plan's
 *   Wave 3 Step 2 "decided contract").
 *
 *   Both callers now detect the empty-stack case BEFORE calling the API
 *   instead of letting the guaranteed-400 round trip happen and reacting to
 *   the failure after the fact — this is the one guidance string they both
 *   surface, so it can't drift between CLI and MCP wording the way the two
 *   tools' pre-fix behavior already had (a hard `process.exit(1)` crash on
 *   CLI vs a silently-swallowed warning on MCP for the exact same input
 *   shape).
 */

/**
 * Guidance shown when no technology stack could be derived for
 * recommendations. Written to read naturally from both a terminal (CLI) and
 * an MCP tool response consumed by a calling agent — neither surface names
 * its own flag here, since the same string serves both.
 */
export function buildEmptyStackGuidance(): string {
  return (
    'No technology stack could be derived for recommendations — this usually ' +
    'means a non-Node project, a stack with no production dependencies, or an ' +
    'unsupported language, not a backend or registry problem. Provide project ' +
    'context (a short description of the project or its tooling) or an ' +
    'explicit list of installed/currently-used skills, then try again.'
  )
}

/**
 * SMI-5893 (Wave 7 Step 2): shared "auto-detected" footer fragment for CLI
 * `recommend` (`recommend.helpers.ts`) and MCP `skill_recommend`
 * (`recommend.format.ts`)'s formatted output — both previously hardcoded
 * "(auto-detected from ~/.claude/skills/)" regardless of which client's
 * directory was actually scanned.
 *
 * **Corrected per plan review — `getInstallPath(client)` is not directly
 * usable here**, unlike the Wave 1 pattern `list`'s footer reuses (Wave 7
 * Step 1): neither call site threads a resolved `ClientId` through to this
 * text today (CLI's `getInstalledSkills()` always scans the canonical
 * install path; MCP's resolves whatever `SKILLSMITH_CLIENT` happens to be
 * set to at call time) — there is no single client value shared by both
 * surfaces to plug into `getInstallPath()`. Rather than hardcode one path
 * (wrong for any non-canonical/non-default client) or invent two divergent
 * per-surface resolution rules, both surfaces describe the detection
 * generically via this one shared helper instead.
 */
export function getRecommendAutoDetectedFooterText(): string {
  return 'auto-detected from your installed skills across all clients'
}
