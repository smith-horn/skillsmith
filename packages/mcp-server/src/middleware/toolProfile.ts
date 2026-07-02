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

// SMI-5456 Wave 1 Step 5 (QD-1): the three constants below moved to
// @skillsmith/core so the CLI installer can call `generateAgentPack` without
// depending on @skillsmith/mcp-server (a devDependency that bundles the full
// MCP SDK + server bootstrap). Re-exported here so every existing import of
// `AGENT_TOOL_PROFILE_NAMES` / `AGENT_TOOL_PROFILE_ENV_VAR` /
// `AGENT_TOOL_PROFILE_VALUE` from this module (the generation script,
// `agent-pack.assets.test.ts`, this file's own test) keeps working
// unchanged. Canonical definition + doc comment: `@skillsmith/core`'s
// `services/agent-tool-profile.ts`.
import {
  AGENT_TOOL_PROFILE_ENV_VAR,
  AGENT_TOOL_PROFILE_NAMES,
  AGENT_TOOL_PROFILE_VALUE,
} from '@skillsmith/core'

// Re-export (not `export ... from`, which would not create the local
// bindings `isAgentToolProfileActive`/`filterToolsForAgentProfile` need below).
export { AGENT_TOOL_PROFILE_ENV_VAR, AGENT_TOOL_PROFILE_NAMES, AGENT_TOOL_PROFILE_VALUE }

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
