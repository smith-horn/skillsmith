/**
 * Entry-value builders for `sklx agent install` (SMI-5456 Wave 1 Step 5).
 *
 * Pure functions producing the exact MCP-server registration value + the
 * Codex TOML blocks the installer merges in. Separated from the
 * orchestrator so the "what do we install" shape is independently testable
 * from "where do we write it".
 *
 * @module @skillsmith/core/install/agent-pack-installer.entry
 */

import { execFileSync } from 'node:child_process'

import {
  AGENT_TOOL_PROFILE_ENV_VAR,
  AGENT_TOOL_PROFILE_VALUE,
} from '../services/agent-tool-profile.js'

/**
 * The `skillsmith` MCP server registration value for `mcpServers`-convention
 * harnesses (claude-code, copilot, windsurf; hermes uses the same field
 * names under YAML). OpenCode does NOT use this shape — see
 * {@link buildOpenCodeMcpEntryValue}. Cursor ALSO does not use this shape —
 * see {@link buildCursorMcpEntryValue} (SMI-6279 Wave 9): two independent
 * live UAT passes proved the `npx`/`args` form here ENOENTs inside Cursor's
 * bundled Node (GH#2368 C-01), which is why the website/CLI-template docs
 * snippet was corrected to a resolved-binary-path form back in SMI-5893
 * Wave 11 — this function stayed on the broken form for every OTHER
 * harness it's still correct for, so it is deliberately left unchanged here.
 */
export function buildAgentMcpEntryValue(): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', '@skillsmith/mcp-server'],
    env: {
      [AGENT_TOOL_PROFILE_ENV_VAR]: AGENT_TOOL_PROFILE_VALUE,
    },
  }
}

/**
 * JSON key Cursor's MCP entry is installed under (SMI-6279 Wave 9).
 *
 * Every OTHER `mcpServers`-convention harness still uses the literal
 * `'skillsmith'` key (hardcoded as `mergeJsonMcpEntry`'s default `entryKey`
 * — deliberately NOT changed here, out of scope for this fix). Cursor is
 * the one client with a human-facing docs snippet
 * (`packages/website/src/lib/mcp-client-snippets.ts` /
 * `packages/cli/src/templates/mcp-server.template.snippets.ts`) that tells a
 * user to hand-paste an entry under the PACKAGE-scoped key
 * `@skillsmith/mcp-server` instead — a mismatch that let a user who both
 * pasted the docs snippet AND ran `sklx agent install` end up with two
 * different server entries coexisting in the same `mcp.json`, neither ever
 * recognized as "the other's" by the installer's own conflict-detection
 * (which matches purely on key). Aligning the installer's key to the docs
 * snippet's key here means a docs-paste and an `agent install` reconcile as
 * ONE entry: either recognized as ours and updated in place, or correctly
 * detected as foreign (conflict) and left alone — never silently
 * duplicated. See `agent-pack-installer.cursor-mcp.ts` for the write path
 * (including the legacy-key cleanup for a pre-fix install that still has
 * the old `'skillsmith'`-keyed entry) and `version-check.ts`'s
 * `checkCursorMcpArtifact` for the read-side (`skillsmith diagnose`) use.
 */
export const CURSOR_MCP_ENTRY_KEY = '@skillsmith/mcp-server'

/**
 * The JSON key every pre-SMI-6279 `sklx agent install` run wrote Cursor's
 * MCP entry under — kept as a named constant (not a bare literal) so the
 * legacy-key cleanup step and the `diagnose` staleness check can both point
 * at the exact same "this is the OLD key" definition instead of drifting.
 */
export const LEGACY_MCP_ENTRY_KEY = 'skillsmith'

/**
 * Placeholder command text shown when {@link resolveSkillsmithMcpBinPath}
 * can't resolve a real path — byte-identical to the human-facing
 * instruction already shipped in the website/CLI-template Cursor snippets
 * (SMI-5893 Wave 11), so a user who runs `agent install` before the resolve
 * step succeeds sees the exact same next action the docs already describe.
 */
export const CURSOR_MCP_COMMAND_PLACEHOLDER =
  '<paste output of: which skillsmith-mcp (macOS/Linux) or where skillsmith-mcp (Windows)>'

/**
 * Bound on {@link resolveSkillsmithMcpBinPath}'s `which`/`where` call
 * (code-review finding, GPT-5.6-Sol / SMI-6279: the call previously had no
 * `timeout`, so a hung or substituted `which`/`where` executable could block
 * `agent install` indefinitely). This is a local PATH lookup, not a network
 * call — 3s is generous headroom, not a tight budget. `execFileSync` throws
 * `ETIMEDOUT` when this elapses, which the existing blanket `catch` below
 * already turns into the same "not found" fallback as a missing binary — no
 * separate timeout-handling branch needed.
 */
const BIN_RESOLVE_TIMEOUT_MS = 3000

/**
 * Resolve the on-disk path of the globally-installed `skillsmith-mcp`
 * binary by shelling out to the exact command the docs already tell a
 * human to run by hand — `which` on macOS/Linux, `where` on Windows
 * (SMI-6279 Wave 9).
 *
 * There is no reliable programmatic equivalent that doesn't shell out:
 * `@skillsmith/mcp-server` is a SEPARATE npm package from `@skillsmith/cli`
 * (the package this code runs inside of) and is commonly NOT installed yet
 * when `agent install` runs — it is a peer install the docs tell the user
 * to do themselves (`npm install -g @skillsmith/mcp-server`). Node module
 * resolution (`require.resolve`) only finds an already-installed package's
 * importable entry point, not a DIFFERENT package's globally-linked `bin`
 * symlink, and `process.execPath` is the Node binary running THIS process,
 * not `skillsmith-mcp`'s location — neither is a substitute. `which`/`where`
 * against the global npm bin directory (already on PATH for any shell the
 * user installed from) is the SAME resolution the docs snippet instructs a
 * human to do; this automates exactly that step rather than inventing a new
 * one.
 *
 * Never throws and never hangs — returns `undefined` when the binary isn't
 * found (an `agent install` run commonly happens BEFORE
 * `@skillsmith/mcp-server` is installed; that is an expected outcome here,
 * not an exceptional one) or when the lookup exceeds
 * {@link BIN_RESOLVE_TIMEOUT_MS}.
 */
export function resolveSkillsmithMcpBinPath(): string | undefined {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const output = execFileSync(finder, ['skillsmith-mcp'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: BIN_RESOLVE_TIMEOUT_MS,
    })
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
  } catch {
    return undefined
  }
}

/**
 * Cursor's own MCP server registration value (SMI-6279 Wave 9) — structurally
 * different from {@link buildAgentMcpEntryValue} in two ways confirmed
 * broken by the GH#2368 V3 repro:
 *   1. `command` is a resolved binary path (or the documented paste-here
 *      placeholder when resolution fails), never `npx` — two independent
 *      live UAT passes proved `npx` ENOENTs inside Cursor's bundled Node.
 *   2. `env.SKILLSMITH_CLIENT` is always set to `'cursor'` — without it,
 *      Cursor installs silently land in the default `~/.claude/skills`
 *      instead of `~/.cursor/skills` (SMI-5894 Wave 1 Step 7).
 * `SKILLSMITH_TOOL_PROFILE` is unchanged from the generic builder — this is
 * still the curated agent-pack registration, not a general-purpose one.
 */
export function buildCursorMcpEntryValue(): Record<string, unknown> {
  const resolvedPath = resolveSkillsmithMcpBinPath()
  return {
    command: resolvedPath ?? CURSOR_MCP_COMMAND_PLACEHOLDER,
    env: {
      [AGENT_TOOL_PROFILE_ENV_VAR]: AGENT_TOOL_PROFILE_VALUE,
      SKILLSMITH_CLIENT: 'cursor',
    },
  }
}

/**
 * OpenCode's `mcp`-key entry value (Step-6 verified against
 * opencode.ai/docs/mcp-servers/): entries are typed `local|remote`,
 * `command` is an ARRAY (command + args combined), and the env-var field is
 * named `environment`, not `env`. Writing the generic mcpServers shape here
 * would produce an entry OpenCode's config schema rejects.
 */
export function buildOpenCodeMcpEntryValue(): Record<string, unknown> {
  return {
    type: 'local',
    command: ['npx', '-y', '@skillsmith/mcp-server'],
    enabled: true,
    environment: {
      [AGENT_TOOL_PROFILE_ENV_VAR]: AGENT_TOOL_PROFILE_VALUE,
    },
  }
}

/** Codex `[mcp_servers.skillsmith]` TOML block (text between our markers). */
export function buildCodexMcpTomlBlock(): string {
  return [
    '[mcp_servers.skillsmith]',
    'command = "npx"',
    'args = ["-y", "@skillsmith/mcp-server"]',
    '',
    '[mcp_servers.skillsmith.env]',
    `${AGENT_TOOL_PROFILE_ENV_VAR} = "${AGENT_TOOL_PROFILE_VALUE}"`,
  ].join('\n')
}

/** Regex matching a bare (non-marker-delimited) `[mcp_servers.skillsmith]` table header. */
export const CODEX_MCP_FOREIGN_HEADER = /^\[mcp_servers\.skillsmith(\.[a-zA-Z0-9_]+)?\]/m

/** Regex matching a bare (non-marker-delimited) `[agents.skillsmith-agent]` table header. */
export const CODEX_AGENTS_FOREIGN_HEADER = /^\[agents\.skillsmith-agent(\.[a-zA-Z0-9_]+)?\]/m

/**
 * Codex `[[hooks.SessionStart]]` TOML block (text between our markers) —
 * shape verified by the Step-6 eval worker against
 * developers.openai.com/codex/hooks: inline array-of-tables
 * `[[hooks.SessionStart]]` with a nested `[[hooks.SessionStart.hooks]]`
 * array carrying `{type, command, timeout, statusMessage}`. Only `type` +
 * `command` are emitted (timeout/statusMessage stay at Codex defaults).
 * `JSON.stringify` produces a valid TOML basic string for the absolute
 * script path — same quoting convention as `renderCodexToml` (shims.ts).
 */
export function buildCodexSessionStartHookBlock(sessionStartScriptPath: string): string {
  return [
    '[[hooks.SessionStart]]',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(sessionStartScriptPath)}`,
  ].join('\n')
}

/**
 * Regex matching a SINGLE-bracket `[hooks.SessionStart]` table header — a
 * user config that defined `hooks.SessionStart` as a plain TABLE. Appending
 * our `[[hooks.SessionStart]]` array-of-tables entry to such a file would
 * produce INVALID TOML (a key cannot be both a table and an array of
 * tables), so that is the genuine-conflict case. A foreign DOUBLE-bracket
 * `[[hooks.SessionStart]]` (the user's own hook) is deliberately NOT
 * matched: TOML permits re-opening an array of tables anywhere in the
 * document, so appending our own `[[hooks.SessionStart]]` entry alongside a
 * user's is valid and non-destructive — both hooks run.
 */
export const CODEX_HOOKS_TABLE_CONFLICT_HEADER = /^\[hooks\.SessionStart\]/m
