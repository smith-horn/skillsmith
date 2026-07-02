/**
 * Curated agent tool profile — SMI-5456 Wave 1 Step 2
 *
 * The full MCP surface (~45 registered tools) blows client tool budgets
 * (Cursor warns ~40; VS Code shares a 128-tool budget across all servers).
 * Setting `SKILLSMITH_TOOL_PROFILE=agent` narrows the `ListTools` response
 * to a curated ~15-tool profile sized for the portable agent pack. Unset,
 * or any value other than `'agent'`, is a no-op: full surface, zero
 * behavior change — this is the default for every existing install.
 *
 * Listing-only: this module never touches `CallTool` dispatch. A client
 * that already knows an out-of-profile tool name can still call it; tier
 * and license gating (`middleware/license.ts` / `middleware/quota.ts`) are
 * unchanged and still enforced there.
 *
 * @see docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md
 * @see SMI-5456
 */

/** Env var that activates the curated agent profile. */
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
 * `undo_apply` does NOT exist yet — it ships in SMI-5470 (Wave 1 Step 3,
 * the change-journal + undo tool). It is listed here now so this constant
 * doesn't need a second edit when that tool lands. {@link filterToolsForAgentProfile}
 * intersects this list against the tools actually passed in at call time,
 * so a not-yet-registered name is silently inert rather than an error.
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
  'undo_apply', // SMI-5470 — not yet registered; inert until it ships.
]

const AGENT_TOOL_PROFILE_NAME_SET: ReadonlySet<string> = new Set(AGENT_TOOL_PROFILE_NAMES)

/**
 * Whether the curated agent profile is active for this read of the env var.
 *
 * Read directly at point-of-use rather than cached at module load, matching
 * the existing convention for one-shot env checks elsewhere in this package
 * (e.g. `index.ts`'s `SKILLSMITH_AUTO_UPDATE_CHECK` / `SKILLSMITH_SKIP_SKILL_INSTALL`
 * checks, `context.ts`'s `SKILLSMITH_TELEMETRY_ENABLED` check). A fresh read
 * also means tests can flip the env var between cases without any module-reset
 * machinery, and — since `ListTools` can in principle be re-invoked within a
 * long-lived stdio session — a value change takes effect on the next listing
 * without a server restart.
 *
 * @param env - Injectable for tests; defaults to `process.env`.
 */
export function isAgentToolProfileActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_TOOL_PROFILE_ENV_VAR] === AGENT_TOOL_PROFILE_VALUE
}

/**
 * Filter a tool-listing array down to the curated agent profile when active.
 *
 * No-op (returns a shallow copy of `tools`, unfiltered) when the profile is
 * not active — this is the default for unset or any non-`'agent'` value, so
 * every existing install sees exactly today's full surface.
 *
 * @param tools - Tool definitions as returned by the `ListTools` handler's
 *   source array. Only `name` is read; any richer tool-definition shape works.
 * @param env - Injectable for tests; defaults to `process.env`.
 */
export function filterToolsForAgentProfile<T extends { name: string }>(
  tools: readonly T[],
  env: NodeJS.ProcessEnv = process.env
): T[] {
  if (!isAgentToolProfileActive(env)) return [...tools]
  return tools.filter((tool) => AGENT_TOOL_PROFILE_NAME_SET.has(tool.name))
}
