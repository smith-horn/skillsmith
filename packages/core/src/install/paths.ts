/**
 * SMI-4578: Multi-client install paths.
 *
 * Single source of truth for the per-agent skill directory table. The CLI
 * `--client` flag, the MCP `SKILLSMITH_CLIENT` env var, and every reader of
 * `~/.claude/skills` route through the helpers below so the canonical path is
 * defined in exactly one place.
 *
 * @module @skillsmith/core/install/paths
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

// Verified 2026-04-30 against vendor docs:
//   - Claude Code: code.claude.com/docs/en/skills
//   - Cursor:      cursor.com/docs/skills
//   - Copilot:     code.visualstudio.com/docs/copilot/customization/agent-skills
//   - Codex:       developers.openai.com/codex/skills (reads ONLY ~/.agents/skills — no separate codex ID)
//   - Windsurf:    docs.windsurf.com/windsurf/cascade/skills
export type ClientId = 'claude-code' | 'cursor' | 'copilot' | 'windsurf' | 'agents'

export const CLIENT_NATIVE_PATHS: Record<ClientId, string> = {
  'claude-code': join(homedir(), '.claude', 'skills'),
  cursor: join(homedir(), '.cursor', 'skills'),
  copilot: join(homedir(), '.copilot', 'skills'),
  windsurf: join(homedir(), '.codeium', 'windsurf', 'skills'),
  agents: join(homedir(), '.agents', 'skills'),
}

export const CANONICAL_CLIENT: ClientId = 'claude-code'

export const CLIENT_IDS: ReadonlyArray<ClientId> = Object.freeze([
  'claude-code',
  'cursor',
  'copilot',
  'windsurf',
  'agents',
])

export function getCanonicalInstallPath(): string {
  return CLIENT_NATIVE_PATHS[CANONICAL_CLIENT]
}

export function getInstallPath(client: ClientId = CANONICAL_CLIENT): string {
  return CLIENT_NATIVE_PATHS[client]
}

export function assertClientId(value: unknown): asserts value is ClientId {
  if (typeof value !== 'string' || !CLIENT_IDS.includes(value as ClientId)) {
    throw new Error(
      `Invalid client '${String(value)}'. Valid: ${CLIENT_IDS.join(', ')}. ` +
        `For Codex, pass --client agents (the path is shared via the open-standard cross-agent convention).`
    )
  }
}

export function resolveClientId(raw: string | undefined): ClientId {
  if (raw === undefined || raw === '') return CANONICAL_CLIENT
  assertClientId(raw)
  return raw
}
