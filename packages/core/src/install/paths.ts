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
import { isAbsolute, join, resolve } from 'node:path'

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
//
// Antigravity addition (SMI-5982 Wave 6), verified 2026-08-11:
//   - Antigravity: ~/.gemini/config/skills — sourced from
//     docs/internal/research/smi-5386-opencode-antigravity-skill-dirs.md
//     (2026-06-26 spike, itself sourced from Google's own Antigravity docs),
//     covering the Antigravity IDE, CLI, and 2.0 surfaces uniformly. This
//     CORRECTS SMI-5179's own stale `~/.gemini/antigravity/skills`
//     description (verified live against Linear 2026-08-11) — do not carry
//     that older path forward. Antigravity was previously browse-only (see
//     `compatibility/slugs.ts` `BROWSE_ONLY_SLUGS`, now un-deferred here).
export type ClientId =
  | 'claude-code'
  | 'cursor'
  | 'copilot'
  | 'windsurf'
  | 'agents'
  | 'opencode'
  | 'hermes'
  | 'grok'
  | 'antigravity'

export const CLIENT_NATIVE_PATHS: Record<ClientId, string> = {
  'claude-code': join(homedir(), '.claude', 'skills'),
  cursor: join(homedir(), '.cursor', 'skills'),
  copilot: join(homedir(), '.copilot', 'skills'),
  windsurf: join(homedir(), '.codeium', 'windsurf', 'skills'),
  agents: join(homedir(), '.agents', 'skills'),
  opencode: join(homedir(), '.config', 'opencode', 'skills'),
  hermes: join(homedir(), '.hermes', 'skills'),
  grok: join(homedir(), '.grok', 'skills'),
  antigravity: join(homedir(), '.gemini', 'config', 'skills'),
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
  antigravity: 'Antigravity',
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
  'antigravity',
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
 * `fileMode` has two values:
 * - `'flat'` — one file directly inside `dir`, named by substituting `{name}`
 *   in `filenamePattern`. Used by every client except Antigravity.
 * - `'directory-package'` (SMI-5982 Wave 6, Antigravity) — a per-skill
 *   subdirectory `<dir>/<name>/` containing a fixed-name file
 *   (`filenamePattern`, always `'agent.md'` for this mode — no `{name}`
 *   substitution, the name lives in the directory segment instead). See
 *   {@link resolveCompanionAgentPath} for the resolution logic per mode.
 */
export interface CompanionAgentTarget {
  dir: string
  fileMode: 'flat' | 'directory-package'
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
 *   `~/.copilot/agents/skillsmith-agent.agent.md`. Both its DIRECTORY
 *   (`~/.copilot/agents/`) AND its `.agent.md` EXTENSION are cited here as
 *   independent evidence (corroborated by shims.ts's own doc comment:
 *   "Copilot `.agent.md` (Copilot cloud-agent + CLI surfaces, which do not
 *   read `.claude/agents`)") — PR-review finding (BLOCKING): a plain
 *   `-specialist.md` suffix here previously risked writing a companion file
 *   Copilot's own surfaces don't discover at all. Per-skill naming is
 *   `<name>.agent.md`, not `<name>-specialist.md`.
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
 * - `antigravity` (SMI-5982 Wave 6): NOT a `HarnessId` member either, but
 *   unlike the clients above, it does NOT default to the shared
 *   `~/.claude/agents/` value — Antigravity has its own independently
 *   web-verified convention (live search against
 *   antigravity.google/docs/cli/commands/agents, 2026-08-11), and it is a
 *   directory-package, not a flat file. No existing global-vs-project
 *   install-mode distinction exists anywhere in this CLI (grepped
 *   `--global`/`--project`/`isGlobal`/`globalScope`, zero hits) — this
 *   entry therefore defaults to PROJECT-scoped (`.agents/agents/<name>/agent.md`,
 *   relative to the invocation directory, i.e. `dir` here is a RELATIVE
 *   path, unlike every other entry's `homedir()`-anchored absolute path).
 *   Global scope (`~/.gemini/config/agents/<name>/agent.md`) is an explicit
 *   fast-follow, not implemented here — see the SMI-5982 Linear comment.
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
    // PR-review finding (BLOCKING): both dir AND filename are now cited
    // from AGENT_SHIM_TARGETS.copilot (agent-harness-targets.ts:156,
    // `skillsmith-agent.agent.md`) and shims.ts's own doc comment ("Copilot
    // `.agent.md` (Copilot cloud-agent + CLI surfaces, which do not read
    // `.claude/agents`)") -- this codebase already has independently
    // verified evidence that Copilot's real companion-agent format is
    // `<name>.agent.md`, not the generic `-specialist.md` suffix every
    // other client here defaults to. Writing plain `.md` risked producing
    // an undiscoverable companion file.
    dir: join(homedir(), '.copilot', 'agents'),
    fileMode: 'flat',
    filenamePattern: '{name}.agent.md',
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
  antigravity: {
    // SMI-5982 (Wave 6): directory-package mode, not flat — confirmed via a
    // live web search against antigravity.google/docs/cli/commands/agents
    // (2026-08-11): each agent is a directory `<name>/` containing a single
    // `agent.md` (YAML frontmatter: `name`, `description` only — no
    // `subagent:` field or equivalent exists in the real schema, confirming
    // the plan's decision NOT to emit one). `dir` is intentionally a
    // RELATIVE path (`.agents/agents`, resolved against the process's
    // invocation directory by Node's fs calls) — project-scoped, per Step 1
    // of the SMI-5982 plan: this CLI has no existing global-vs-project
    // install-mode distinction to hook into, so this defaults to
    // project-scoped rather than inventing scope-detection logic. Global
    // scope (`~/.gemini/config/agents/`) is an explicit fast-follow.
    dir: join('.agents', 'agents'),
    fileMode: 'directory-package',
    filenamePattern: 'agent.md',
  },
}

/** Resolve the companion-agent target descriptor for `client` (default: canonical). */
export function getCompanionAgentTarget(client: ClientId = CANONICAL_CLIENT): CompanionAgentTarget {
  return COMPANION_AGENT_TARGETS[client]
}

/**
 * Resolve just the companion-agent output directory for `client` (default:
 * canonical). For `fileMode: 'directory-package'` clients (Antigravity), this
 * is the SHARED PARENT of every skill's own `<name>/` package, not the final
 * per-skill directory — use {@link resolveCompanionAgentPath} (and its
 * `path.dirname()`) to get the actual per-skill directory a file lands in.
 */
export function resolveCompanionAgentDir(client: ClientId = CANONICAL_CLIENT): string {
  return getCompanionAgentTarget(client).dir
}

/**
 * Resolve the full on-disk companion-subagent file path for `client` +
 * `skillName` (default client: canonical / `claude-code`).
 *
 * Two `fileMode`s (SMI-5982 Wave 6):
 * - `'flat'`: `<dir>/<filenamePattern with {name} substituted>` — one file
 *   directly inside the shared client agents dir (all clients but Antigravity).
 * - `'directory-package'`: `<dir>/<skillName>/<filenamePattern>` — a
 *   per-skill subdirectory containing a fixed-name file (Antigravity only
 *   today; `filenamePattern` carries no `{name}` token in this mode, since
 *   the skill name is the directory segment instead).
 *
 * SMI-5982 code-review fix #1 (BLOCKING, cwd-dependent resolution): Antigravity's
 * `dir` is the only RELATIVE entry in `COMPANION_AGENT_TARGETS` — every other
 * client's `dir` is `homedir()`-anchored absolute. A relative `dir` used to be
 * resolved IMPLICITLY by whichever `fs` call eventually consumed the returned
 * path, against that call's `process.cwd()` at THAT moment. For a short-lived
 * CLI process cwd is genuinely the user's invocation directory, but for the
 * long-running MCP server cwd is fixed at server launch and generally does
 * NOT track the calling editor/agent's actual project — silently writing into
 * an unrelated directory. `baseDir` makes the resolution root an explicit,
 * caller-controlled parameter instead: every caller now decides what "cwd"
 * means for its own lifecycle, rather than the process's ambient cwd deciding
 * for it. Applied unconditionally via `isAbsolute()` (not gated to
 * `directory-package` mode) so the function stays correct if a future client
 * ever adds a relative `flat`-mode `dir` too — today's flat-mode clients are
 * all absolute already, so this is a no-op for them.
 *
 * SMI-5982 code-review fix #2 (BLOCKING, path traversal): in `directory-package`
 * mode, `skillName` becomes ITS OWN path segment (`<dir>/<skillName>/...`), so
 * an unsanitized `skillName === '..'` would `path.join`-normalize to
 * `<parent-of-dir>/agent.md` — escaping the intended companion-agent
 * namespace entirely. `flat` mode never had this exact exposure (`skillName`
 * there is embedded INSIDE a suffixed filename via `.replace()`, a literal
 * filename component, not a traversal directive). Every current caller of
 * `writeInstallFiles()` already sanitizes `skillName` upstream, but this is a
 * general, exported, reusable function with no validation of its own — per
 * this codebase's own stated principle (see `skillNameFromSkillId()`'s doc
 * comment, skill-installation.content.ts): the actual disk-write boundary is
 * the last line of defense regardless of what any upstream caller does, since
 * a future caller could bypass upstream sanitization entirely.
 */
export function resolveCompanionAgentPath(
  skillName: string,
  client: ClientId = CANONICAL_CLIENT,
  baseDir: string = process.cwd()
): string {
  const target = getCompanionAgentTarget(client)
  const resolvedDir = isAbsolute(target.dir) ? target.dir : resolve(baseDir, target.dir)
  if (target.fileMode === 'directory-package') {
    if (
      skillName === '' ||
      skillName === '.' ||
      skillName === '..' ||
      skillName.includes('/') ||
      skillName.includes('\\')
    ) {
      throw new Error(
        `Unsafe skill name for directory-package companion path: ${JSON.stringify(skillName)}`
      )
    }
    return join(resolvedDir, skillName, target.filenamePattern)
  }
  const filename = target.filenamePattern.replace('{name}', skillName)
  return join(resolvedDir, filename)
}
