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

import {
  AGENT_TOOL_PROFILE_ENV_VAR,
  AGENT_TOOL_PROFILE_VALUE,
} from '../services/agent-tool-profile.js'

/**
 * The `skillsmith` MCP server registration value for `mcpServers`-convention
 * harnesses (claude-code, cursor, copilot, windsurf; hermes uses the same
 * field names under YAML). OpenCode does NOT use this shape — see
 * {@link buildOpenCodeMcpEntryValue}.
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
