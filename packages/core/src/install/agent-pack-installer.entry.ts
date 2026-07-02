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

/** The `skillsmith` MCP server registration value written into every harness's config. */
export function buildAgentMcpEntryValue(): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', '@skillsmith/mcp-server'],
    env: {
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
