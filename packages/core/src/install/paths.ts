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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Verified 2026-04-30 against vendor docs:
//   - Claude Code: code.claude.com/docs/en/skills
//   - Cursor:      cursor.com/docs/skills
//   - Copilot:     code.visualstudio.com/docs/copilot/customization/agent-skills
//   - Codex:       developers.openai.com/codex/skills (reads ONLY ~/.agents/skills — no separate codex ID)
//   - Windsurf:    docs.windsurf.com/windsurf/cascade/skills
//
// SMI-5456 Wave 1 Step 5 additions, verified 2026-07-01 against the Step-0
// spike report (docs/internal/product/prd-skillsmith-agent.md §3.1 + spike
// report §(b)/§(c)):
//   - OpenCode: ~/.config/opencode/skills — opencode.ai/docs (XDG-config-style
//     root distinct from the `~/.<tool>` pattern used above; NOT re-verified
//     live in this step, carried forward from the Step-5 task brief pending
//     Step-6 L2a/L3 harness-simulation confirmation).
//   - Hermes:   ~/.hermes/skills — spike report §(b), well-verified (3
//     independent official doc pages agree): "the primary directory and
//     source of truth" for bundled/hub/agent-created skills, respects
//     $HERMES_HOME override. Hermes has no session-start hook equivalent
//     (spike-verified absent) — the installer must not claim hook/nudge
//     support for this harness.
export type ClientId =
  | 'claude-code'
  | 'cursor'
  | 'copilot'
  | 'windsurf'
  | 'agents'
  | 'opencode'
  | 'hermes'

export const CLIENT_NATIVE_PATHS: Record<ClientId, string> = {
  'claude-code': join(homedir(), '.claude', 'skills'),
  cursor: join(homedir(), '.cursor', 'skills'),
  copilot: join(homedir(), '.copilot', 'skills'),
  windsurf: join(homedir(), '.codeium', 'windsurf', 'skills'),
  agents: join(homedir(), '.agents', 'skills'),
  opencode: join(homedir(), '.config', 'opencode', 'skills'),
  hermes: join(homedir(), '.hermes', 'skills'),
}

export const CANONICAL_CLIENT: ClientId = 'claude-code'

export const CLIENT_IDS: ReadonlyArray<ClientId> = Object.freeze([
  'claude-code',
  'cursor',
  'copilot',
  'windsurf',
  'agents',
  'opencode',
  'hermes',
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

/**
 * Resolve the active client from `SKILLSMITH_CLIENT` (or any explicit
 * override). Returns the matching install path. Computed at call time so
 * a process that mutates `SKILLSMITH_CLIENT` at runtime sees the new
 * value — used by the MCP server to pick `~/.cursor/skills/` etc.
 */
export function resolveClientPath(override?: string | undefined): string {
  const raw = override !== undefined ? override : process.env['SKILLSMITH_CLIENT']
  return getInstallPath(resolveClientId(raw))
}

/**
 * Returns the filesystem presence status of every known harness.
 *
 * A harness is considered "present" when its skill directory exists on disk.
 * This lets the cross-harness inventory (SMI-5390) report a harness as
 * "installed but zero skills" rather than omitting it entirely.
 *
 * Synchronous and O(CLIENT_IDS.length) — safe to call on the startup path.
 *
 * @see SMI-5390
 */
export function enumerateHarnessPresence(): Array<{
  harness: ClientId
  present: boolean
  path: string
}> {
  return CLIENT_IDS.map((harness) => {
    const harnessPath = CLIENT_NATIVE_PATHS[harness]
    return {
      harness,
      present: existsSync(harnessPath),
      path: harnessPath,
    }
  })
}
