/**
 * Per-harness on-disk targets for the `sklx agent install` / `uninstall`
 * commands (SMI-5456 Wave 1 Step 5).
 *
 * This module is pure data (no filesystem access) — it says WHERE each
 * harness's MCP config and hook config live and in what format, so
 * `agent-config-merge*.ts` can merge into them generically and
 * `agent-pack-installer.ts` doesn't hard-code per-harness path logic inline.
 *
 * Confidence levels (documented per plan's own Validation Ladder philosophy —
 * Level 2a/3 in docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md
 * is explicitly where per-harness wire formats get confirmed against real
 * harness binaries):
 *   - claude-code, cursor, windsurf: HIGH — MCP config path/shape verified
 *     against `packages/cli/src/templates/mcp-server.template.snippets.ts`
 *     (SMI-4580, already shipped and used in docs/website).
 *   - hermes: HIGH for the skill path + YAML config shape (spike report §(b),
 *     3 independent official doc pages agree); hooks are spike-verified
 *     ABSENT (no SessionStart equivalent) — {@link AGENT_HARNESS_TARGETS}
 *     therefore carries no hook target for hermes.
 *   - codex: HIGH for the config file path (`~/.codex/config.toml`, same
 *     snippet table); MEDIUM for the exact `[hooks]` table shape (spike
 *     report §(e) confirms Codex hooks exist and cites `updatedInput` on
 *     `arguments`, not the SessionStart hook-registration TOML shape itself).
 *   - copilot: MEDIUM — targets `~/.copilot/mcp.json` (mirrors the existing
 *     `~/.copilot/skills` convention in `paths.ts`) rather than VS Code's
 *     workspace-scoped `.vscode/mcp.json`, since `sklx agent install` is a
 *     global (not per-project) command; workspace-level registration is a
 *     known Wave-1 gap (see the Step-5 worker report).
 *   - opencode: LOW-MEDIUM — `~/.config/opencode/opencode.json` under a
 *     `mcp` key is a best-effort placement pending Step-6 confirmation; the
 *     installer's merge is fail-soft (a wrong path/shape here degrades to a
 *     per-harness report warning, never a crash of the whole install).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { HarnessId } from '../services/agent-pack/index.js'

/** Harnesses that can receive an MCP server registration (all 7 targets). */
export type McpHarnessId = HarnessId | 'windsurf' | 'hermes'

/** Config-file format the merge helper must speak for a given target. */
export type ConfigFormat = 'json' | 'yaml' | 'toml-block'

/**
 * Where + how to merge the Skillsmith MCP server registration for one harness.
 *
 * `keyPath` is only meaningful for `format: 'json'` — the property path (from
 * the parsed document root) to the object the merge helper inserts
 * `skillsmith: {...}` into, creating intermediate objects as needed.
 * `format: 'toml-block'` targets ignore `keyPath` — see
 * `agent-config-merge.toml-block.ts` for the marker-delimited scheme.
 */
export interface McpConfigTarget {
  harness: McpHarnessId
  path: string
  format: ConfigFormat
  keyPath: string[]
}

/** Where to write a named-agent shim file for a harness that has one. */
export interface ShimTarget {
  harness: HarnessId
  /** Absolute file path the rendered shim content is written to verbatim. */
  path: string
}

/**
 * Where to install a hook SCRIPT and how to wire it into that harness's hook
 * config. `configFormat`/`configPath`/`keyPath` follow the same shape as
 * {@link McpConfigTarget} so hook wiring reuses the same merge helpers.
 */
export interface HookInstallTarget {
  harness: 'claude-code' | 'cursor' | 'codex'
  /** Directory the hook script itself is copied into (chmod 0755). */
  scriptDir: string
  configPath: string
  configFormat: ConfigFormat
  /** Key path to the array this hook's command entry is appended to. */
  sessionStartKeyPath: string[]
  sessionEndKeyPath: string[]
}

const home = homedir()

/** MCP registration targets for every harness the pack supports (PRD §3.1). */
export const AGENT_MCP_TARGETS: Readonly<Record<McpHarnessId, McpConfigTarget>> = {
  'claude-code': {
    harness: 'claude-code',
    path: join(home, '.claude', 'settings.json'),
    format: 'json',
    keyPath: ['mcpServers'],
  },
  cursor: {
    harness: 'cursor',
    path: join(home, '.cursor', 'mcp.json'),
    format: 'json',
    keyPath: ['mcpServers'],
  },
  copilot: {
    harness: 'copilot',
    path: join(home, '.copilot', 'mcp.json'),
    format: 'json',
    keyPath: ['mcpServers'],
  },
  windsurf: {
    harness: 'windsurf',
    path: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'json',
    keyPath: ['mcpServers'],
  },
  opencode: {
    harness: 'opencode',
    path: join(home, '.config', 'opencode', 'opencode.json'),
    format: 'json',
    keyPath: ['mcp'],
  },
  codex: {
    harness: 'codex',
    path: join(home, '.codex', 'config.toml'),
    format: 'toml-block',
    keyPath: [],
  },
  hermes: {
    harness: 'hermes',
    path: join(home, '.hermes', 'config.yaml'),
    format: 'yaml',
    keyPath: ['mcp_servers'],
  },
}

/**
 * Named-agent shim file targets, per {@link HarnessId} (PRD §3.1 constraint
 * 2 / architecture doc artifacts A2-A5). Cursor and (VS Code's) Copilot both
 * read `.claude/agents/*.md` natively per the constraint matrix, so they
 * share the claude-code shim file rather than getting a second copy — only
 * harnesses with their OWN native shim format get a dedicated target here.
 */
export const AGENT_SHIM_TARGETS: Readonly<Record<HarnessId, ShimTarget | null>> = {
  'claude-code': {
    harness: 'claude-code',
    path: join(home, '.claude', 'agents', 'skillsmith-agent.md'),
  },
  // Cursor 2.4+ reads `.claude/agents/` natively — no separate shim file.
  cursor: null,
  copilot: {
    harness: 'copilot',
    path: join(home, '.copilot', 'agents', 'skillsmith-agent.agent.md'),
  },
  opencode: {
    harness: 'opencode',
    // Best-effort (LOW-MEDIUM confidence, see module header) — pending
    // Step-6 confirmation of OpenCode's agent-file directory convention.
    path: join(home, '.config', 'opencode', 'agent', 'skillsmith-agent.md'),
  },
  // Codex's shim is a TOML `[agents.*]` table entry merged into
  // ~/.codex/config.toml, not a standalone file — see AGENT_MCP_TARGETS.codex
  // and agent-config-merge.toml-block.ts. No separate ShimTarget.
  codex: null,
}

/** Hook install targets — only harnesses with a real SessionStart hook (HOOK_HARNESSES). */
export const AGENT_HOOK_TARGETS: Readonly<
  Record<'claude-code' | 'cursor' | 'codex', HookInstallTarget>
> = {
  'claude-code': {
    harness: 'claude-code',
    scriptDir: join(home, '.claude', 'hooks'),
    configPath: join(home, '.claude', 'settings.json'),
    configFormat: 'json',
    sessionStartKeyPath: ['hooks', 'SessionStart'],
    sessionEndKeyPath: ['hooks', 'SessionEnd'],
  },
  cursor: {
    harness: 'cursor',
    scriptDir: join(home, '.cursor', 'hooks'),
    configPath: join(home, '.cursor', 'hooks.json'),
    configFormat: 'json',
    // Cursor's hooks.json is Claude-compatible (PRD §3.1) but is itself the
    // hooks map (no wrapping "hooks" key) — see module header confidence note.
    sessionStartKeyPath: ['SessionStart'],
    sessionEndKeyPath: ['SessionEnd'],
  },
  codex: {
    harness: 'codex',
    scriptDir: join(home, '.codex', 'hooks'),
    configPath: join(home, '.codex', 'config.toml'),
    configFormat: 'toml-block',
    sessionStartKeyPath: [],
    sessionEndKeyPath: [],
  },
}

/** Codex's `[agents.skillsmith-agent]` TOML entry lives in the same config file as its MCP registration. */
export const CODEX_CONFIG_TOML_PATH = AGENT_MCP_TARGETS.codex.path
