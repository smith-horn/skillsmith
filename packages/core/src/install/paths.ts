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
//
// Grok Build addition, verified 2026-07-14:
//   - Grok Build: ~/.grok/skills — xAI's official developer docs (the
//     "Skills, Plugins & Marketplaces" page under docs.x.ai's build/features
//     section), corroborated by independent third-party sources. Grok Build
//     also reads the shared ~/.agents/skills path for AGENTS.md-style
//     cross-agent compatibility, but that's already covered by the existing
//     `agents` ClientId, so no separate handling is needed for it here.
export type ClientId =
  | 'claude-code'
  | 'cursor'
  | 'copilot'
  | 'windsurf'
  | 'agents'
  | 'opencode'
  | 'hermes'
  | 'grok'

export const CLIENT_NATIVE_PATHS: Record<ClientId, string> = {
  'claude-code': join(homedir(), '.claude', 'skills'),
  cursor: join(homedir(), '.cursor', 'skills'),
  copilot: join(homedir(), '.copilot', 'skills'),
  windsurf: join(homedir(), '.codeium', 'windsurf', 'skills'),
  agents: join(homedir(), '.agents', 'skills'),
  opencode: join(homedir(), '.config', 'opencode', 'skills'),
  hermes: join(homedir(), '.hermes', 'skills'),
  grok: join(homedir(), '.grok', 'skills'),
}

export const CANONICAL_CLIENT: ClientId = 'claude-code'

/**
 * SMI-5894 (Wave 1 Step 5): human-readable label per client, used by
 * post-install tips/guidance so the messaging names the actual install
 * target (e.g. "mention it in Cursor:") instead of unconditionally saying
 * "Claude Code" regardless of `SKILLSMITH_CLIENT`/`--client`. Lives here
 * (not in the CLI's `CLIENT_SNIPPETS` table) so both `@skillsmith/core`
 * (shared install/uninstall tip generation) and any MCP-side caller can use
 * it without introducing a core -> cli dependency.
 */
export const CLIENT_DISPLAY_LABELS: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  windsurf: 'Windsurf',
  agents: 'your agent',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  grok: 'Grok Build',
}

export const CLIENT_IDS: ReadonlyArray<ClientId> = Object.freeze([
  'claude-code',
  'cursor',
  'copilot',
  'windsurf',
  'agents',
  'opencode',
  'hermes',
  'grok',
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

/**
 * SMI-5980 (Wave 3): where a per-skill companion-subagent file is written for
 * a given `ClientId`.
 *
 * **Deliberately NOT derived from `AGENT_SHIM_TARGETS`** (agent-harness-targets.ts).
 * That table encodes complete, singular shim-file targets (fixed filenames like
 * `skillsmith-agent.md`, `null` entries for some tools) for a *different*
 * command (`sklx agent install`'s one-time named-agent shim), keyed by the
 * narrower `HarnessId` enum (5 members) rather than `ClientId` (8 members).
 * This is a new, purpose-built map for the per-skill companion-subagent file
 * that `SkillInstallationService.install()` / `sklx author subagent` can
 * generate for ANY installed skill, one file per skill, not a single fixed
 * shim.
 *
 * `fileMode: 'flat'` is the only mode today — one file directly inside `dir`,
 * named by substituting `{name}` in `filenamePattern`. A later wave (SMI-5982
 * / Antigravity) is expected to add a `'directory-package'` mode for a
 * `<name>/agent.md` layout — extend the union then; don't widen it
 * speculatively now.
 */
export interface CompanionAgentTarget {
  dir: string
  fileMode: 'flat'
  filenamePattern: string
}

/**
 * Populated conservatively per the SMI-5980 plan review, to fix the
 * hardcoding/architecture bug (making this resolvable per client at all)
 * WITHOUT inventing new, unverified per-client directory values:
 *
 * - `claude-code`: today's actual confirmed hardcoded value
 *   (`~/.claude/agents/<skillName>-specialist.md`) — this must exactly match
 *   pre-Wave-3 behavior (`skill-installation.io.ts`'s prior
 *   `path.join(os.homedir(), '.claude', 'agents')` literal and
 *   `author/utils.ts`'s prior `ensureAgentsDirectory()` default).
 * - `copilot`: `AGENT_SHIM_TARGETS.copilot` (agent-harness-targets.ts) has a
 *   real, non-null entry for the SAME underlying tool —
 *   `~/.copilot/agents/skillsmith-agent.agent.md`. Its DIRECTORY
 *   (`~/.copilot/agents/`) is cited here as independent evidence of
 *   Copilot's own agents-dir convention; the FILENAME is not reused —
 *   `skillsmith-agent.agent.md` is that table's own singular-shim naming for
 *   a different command, unrelated to this map's per-skill
 *   `<name>-specialist.md` naming.
 * - `opencode`: `AGENT_SHIM_TARGETS.opencode` likewise has a real, non-null
 *   entry — `~/.config/opencode/agents/skillsmith-agent.md` (plural
 *   `agents/`, Step-6 verified against opencode.ai/docs/agents/ per that
 *   table's own header comment). Its DIRECTORY
 *   (`~/.config/opencode/agents/`) is cited here as independent evidence of
 *   OpenCode's own agents-dir convention, filename likewise not reused.
 * - `cursor`: `AGENT_SHIM_TARGETS.cursor` is `null` — NOT a directory value,
 *   just documentation that Cursor 2.4+ reads `.claude/agents/` natively
 *   (per that table's own comment). That happens to coincide with the
 *   default below, but it is not being "cited as evidence" for a distinct
 *   value — cursor defaults like any client with no independent evidence.
 * - `windsurf`, `agents`, `hermes`, `grok`: none of these are even members
 *   of the narrower `HarnessId` enum `AGENT_SHIM_TARGETS` is keyed on, so
 *   there is no table entry to consult either way. Every one of these
 *   defaults to today's actual behavior — the same `~/.claude/agents/`
 *   value every client gets today.
 *
 * Exported for the next wave (SMI-5982, Antigravity) to import and extend
 * with a real `antigravity` `ClientId` member once that `ClientId` exists.
 */
export const COMPANION_AGENT_TARGETS: Record<ClientId, CompanionAgentTarget> = {
  'claude-code': {
    dir: join(homedir(), '.claude', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}-specialist.md',
  },
  cursor: {
    // AGENT_SHIM_TARGETS.cursor is null (no distinct value) — defaults like
    // every client with no independent evidence. See doc comment above.
    dir: join(homedir(), '.claude', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}-specialist.md',
  },
  copilot: {
    // Directory cited from AGENT_SHIM_TARGETS.copilot (agent-harness-targets.ts)
    // as independent evidence of Copilot's own agents-dir convention.
    // Filename pattern is this map's own naming, not copied from that table.
    dir: join(homedir(), '.copilot', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}-specialist.md',
  },
  windsurf: {
    // No AGENT_SHIM_TARGETS entry exists for windsurf (not a HarnessId
    // member) — defaults to today's actual behavior.
    dir: join(homedir(), '.claude', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}-specialist.md',
  },
  agents: {
    // No AGENT_SHIM_TARGETS entry exists for `agents` (not a HarnessId
    // member) — defaults to today's actual behavior.
    dir: join(homedir(), '.claude', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}-specialist.md',
  },
  opencode: {
    // Directory cited from AGENT_SHIM_TARGETS.opencode (agent-harness-targets.ts)
    // as independent evidence of OpenCode's own agents-dir convention.
    // Filename pattern is this map's own naming, not copied from that table.
    dir: join(homedir(), '.config', 'opencode', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}-specialist.md',
  },
  hermes: {
    // No AGENT_SHIM_TARGETS entry exists for hermes (not a HarnessId
    // member) — defaults to today's actual behavior.
    dir: join(homedir(), '.claude', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}-specialist.md',
  },
  grok: {
    // No AGENT_SHIM_TARGETS entry exists for grok (not a HarnessId member)
    // — defaults to today's actual behavior.
    dir: join(homedir(), '.claude', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}-specialist.md',
  },
}

/** Resolve the companion-agent target descriptor for `client` (default: canonical). */
export function getCompanionAgentTarget(client: ClientId = CANONICAL_CLIENT): CompanionAgentTarget {
  return COMPANION_AGENT_TARGETS[client]
}

/** Resolve just the companion-agent output directory for `client` (default: canonical). */
export function resolveCompanionAgentDir(client: ClientId = CANONICAL_CLIENT): string {
  return getCompanionAgentTarget(client).dir
}

/**
 * Resolve the full on-disk companion-subagent file path for `client` +
 * `skillName` (default client: canonical / `claude-code`).
 */
export function resolveCompanionAgentPath(
  skillName: string,
  client: ClientId = CANONICAL_CLIENT
): string {
  const target = getCompanionAgentTarget(client)
  const filename = target.filenamePattern.replace('{name}', skillName)
  return join(target.dir, filename)
}
