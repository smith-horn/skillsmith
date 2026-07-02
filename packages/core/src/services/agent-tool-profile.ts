/**
 * Curated agent tool profile — canonical home (SMI-5456 Wave 1 Step 5, QD-1).
 *
 * These three constants were originally defined in
 * `@skillsmith/mcp-server`'s `middleware/toolProfile.ts` (Step 2). Step 5's
 * `sklx agent install` needs to call `generateAgentPack({ toolProfile })`
 * with the SAME list the mcp-server's generation script uses, so the
 * installer produces byte-identical artifacts to the committed pack
 * (determinism is the drift guard — see `agent-pack.assets.test.ts`).
 * Relocating here lets `@skillsmith/cli` depend on `@skillsmith/core` only
 * (already a runtime-shaped dependency) instead of pulling in
 * `@skillsmith/mcp-server` (a devDependency that bundles the full MCP SDK +
 * server bootstrap) just to read a string array.
 *
 * `packages/mcp-server/src/middleware/toolProfile.ts` now imports + re-exports
 * these three constants so every existing import path (including the
 * generation script and `agent-pack.assets.test.ts`) keeps working unchanged.
 * `isAgentToolProfileActive` / `filterToolsForAgentProfile` stay in
 * mcp-server — they operate on `ListTools` output + `process.env`, which is
 * mcp-server-specific runtime behavior, not shared constant data.
 *
 * DEVIATION FROM THE QD-1 SPEC: the plan's queen decision named the target
 * location as `packages/core/src/services/agent-pack/` (e.g. `types.ts` or a
 * small `constants.ts`). That directory was locked for a concurrent
 * governance audit for the duration of this Step-5 implementation (worker
 * S4), so this module lives as a SIBLING file instead
 * (`services/agent-tool-profile.ts`, not `services/agent-pack/*.ts`) to avoid
 * touching the locked path. Functionally this is identical to the spec'd
 * location — same package, same import surface via `@skillsmith/core`. A
 * follow-up should fold this file into `services/agent-pack/` proper once the
 * lock lifts, purely as a file-move (no behavior change).
 *
 * @module @skillsmith/core/services/agent-tool-profile
 * @see docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md
 */

/** Env var that activates the curated agent profile (mcp-server ListTools filter). */
export const AGENT_TOOL_PROFILE_ENV_VAR = 'SKILLSMITH_TOOL_PROFILE'

/** The only value of {@link AGENT_TOOL_PROFILE_ENV_VAR} that activates the profile. */
export const AGENT_TOOL_PROFILE_VALUE = 'agent'

/**
 * Membership list for the curated agent profile.
 *
 * The first 15 names were verified against actual `tools/*.ts`
 * registrations on 2026-07-01 via:
 *
 *   grep -rhoE "name: '[a-z_]+'" packages/mcp-server/src/tools/ \
 *     --include='*.ts' | grep -v test | sort -u
 *
 * `undo_apply` shipped in SMI-5470 (Wave 1 Step 3, the change-journal + undo
 * tool). This list is the single source of truth consumed by BOTH
 * `generateAgentPack` call sites: the mcp-server build-time generation script
 * (`packages/mcp-server/scripts/generate-agent-pack.ts`, via the re-export in
 * `middleware/toolProfile.ts`) and the CLI installer
 * (`packages/cli/src/commands/agent.action.ts`, via this module directly).
 * Determinism of `generateAgentPack` is what guarantees both call sites
 * produce byte-identical output from the same input.
 */
export const AGENT_TOOL_PROFILE_NAMES: readonly string[] = [
  'search',
  'get_skill',
  'install_skill',
  'uninstall_skill',
  'skill_recommend',
  'skill_validate',
  'skill_compare',
  'skill_outdated',
  'skill_updates',
  'skill_diff',
  'skill_pack_audit',
  'skill_inventory_audit',
  'apply_namespace_rename',
  'apply_recommended_edit',
  'skill_audit',
  'undo_apply',
]
