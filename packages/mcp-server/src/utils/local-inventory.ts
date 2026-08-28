/**
 * @fileoverview Local-inventory scanner for the consumer namespace audit.
 * @module @skillsmith/mcp-server/utils/local-inventory
 * @see SMI-4587 Wave 1 Step 2 — scan ~/.claude/{skills,commands,agents} +
 *      CLAUDE.md trigger phrases into a unified InventoryEntry[].
 * @see SMI-6077 — skills scanning extended from Claude Code only to every
 *      supported client's native skills directory (CLIENT_IDS). commands /
 *      agents / CLAUDE.md rules remain Claude Code-only — no other
 *      supported client has an equivalent construct today.
 *
 * Each source is independent — failure in one does not fail the others.
 * The scanner is read-only; bootstrapping unmanaged skills via `index_local`
 * is wired in a subsequent PR (Step 6a).
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  CANONICAL_CLIENT,
  CLIENT_IDS,
  CLIENT_NATIVE_PATHS,
  type ClientId,
} from '@skillsmith/core/install'

import type { InventoryEntry, ScanResult, ScanWarning } from './local-inventory.types.js'
import {
  WARNING_CODES,
  capTriggerSurface,
  coerceDescription,
  extractClaudeMdTriggers,
  firstNonEmptyLine,
  isSafePathComponent,
  isWithinRoot,
  loadManifest,
  readBody,
  readEnabledPluginIds,
  readFrontmatter,
  readMtime,
  scanSkillsDirEntries,
  splitDescriptionToPhrases,
} from './local-inventory.helpers.js'

// Captured ONCE at module-load time (mirrors `CLIENT_NATIVE_PATHS` itself,
// which freezes against `os.homedir()` at ITS module-load time in
// `@skillsmith/core/install/paths.ts`). Both modules are statically
// imported — and therefore both evaluate their top-level `homedir()` calls
// — before any test body runs, so this is guaranteed to observe the SAME
// real home directory `CLIENT_NATIVE_PATHS` baked in. Deliberately NOT a
// live `os.homedir()` call inside `resolveClientSkillsDir` below: several
// existing tests (e.g. `skill-inventory-audit.test.ts`) mutate
// `process.env.HOME` to the test fixture INSIDE a test body (Node's
// `os.homedir()` reads `$HOME` on POSIX) — a live call there would resolve
// against the MUTATED value instead of the real one `CLIENT_NATIVE_PATHS`
// was frozen against, silently making the "rebase under homeDir" math
// below a no-op that reads the REAL host's client directories instead of
// the test fixture.
const REAL_HOME_DIR = os.homedir()

const DEFAULT_HOME_CLAUDE_DIR = path.join(REAL_HOME_DIR, '.claude')
const DEFAULT_MANIFEST_PATH = path.join(REAL_HOME_DIR, '.skillsmith', 'manifest.json')

/**
 * Resolve `client`'s native skills directory, rebased under `homeDir`
 * (SMI-6077).
 *
 * `CLIENT_NATIVE_PATHS` (the single source of truth every client-aware
 * command uses — `install_skill --client`, `inventory-collector.ts`, etc.)
 * is frozen at module-load time against the real home directory, so it
 * can't respect this scanner's `homeDir` test-fixture override directly.
 * Rebasing by relative-path substitution — instead of hand-duplicating each
 * client's directory suffix here — keeps `CLIENT_NATIVE_PATHS` the only
 * place per-client path shape is defined. When `homeDir === REAL_HOME_DIR`
 * (the non-test-fixture case) this returns exactly `CLIENT_NATIVE_PATHS[client]`.
 */
function resolveClientSkillsDir(client: ClientId, homeDir: string): string {
  const nativePath = CLIENT_NATIVE_PATHS[client]
  const relativeToRealHome = path.relative(REAL_HOME_DIR, nativePath)
  return path.join(homeDir, relativeToRealHome)
}

export interface ScanLocalInventoryOptions {
  /** Defaults to `os.homedir()`. */
  homeDir?: string
  /**
   * Optional project directory. When set, also scans `<projectDir>/CLAUDE.md`
   * (Source 4, in addition to the user one) and `<projectDir>/.claude/skills/`
   * (Source 6, SMI-6240 — this project's own skills, invisible to every
   * other source, which are all user-level).
   */
  projectDir?: string
  /** Override path to `~/.skillsmith/manifest.json`. */
  manifestPath?: string
}

/**
 * Scan every supported AI coding client's skills directory, plus Claude
 * Code's own `{commands,agents}` and CLAUDE.md trigger phrases (SMI-6077).
 *
 * Returns `entries[]` sorted by `kind` then `identifier`, plus any soft
 * `warnings[]` raised during scanning. `durationMs` measures wall-clock
 * time for the whole scan (excluding the optional bootstrap step that
 * lands in a subsequent PR).
 */
export async function scanLocalInventory(
  opts: ScanLocalInventoryOptions = {}
): Promise<ScanResult> {
  const startedAt = process.hrtime.bigint()

  const homeDir = opts.homeDir ?? os.homedir()
  const claudeDir = opts.homeDir ? path.join(opts.homeDir, '.claude') : DEFAULT_HOME_CLAUDE_DIR
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH

  const warnings: ScanWarning[] = []
  const entries: InventoryEntry[] = []

  const manifest = loadManifest(manifestPath)

  // Source 1 (SMI-6077): every supported client's native skills directory —
  // Claude Code (~/.claude/skills), Cursor, Copilot, Windsurf, the shared
  // ~/.agents/skills cross-agent convention (Codex reads ONLY this path,
  // never .claude/skills), OpenCode, Hermes, Grok Build, and Antigravity —
  // via `CLIENT_NATIVE_PATHS` (`@skillsmith/core/install`), the same
  // per-client-path source of truth `install_skill --client` and every
  // other client-aware command already uses. Scanned unconditionally for
  // every client on every call rather than pre-detecting which clients are
  // actually installed first: `scanSkills` already no-ops in ~microseconds
  // on an absent directory (existsSync gate below), matching the precedent
  // set by `collectDeviceSkills()` (`@skillsmith/core/sync/inventory-collector.ts`,
  // the `inventory_push` tool's scanner) — it loops every `CLIENT_IDS` entry
  // unconditionally and lets a missing directory's ENOENT short-circuit
  // each iteration, rather than gating the loop on a separate presence
  // check. `enumerateHarnessPresence()` exists in the same module but is
  // used ONLY for display purposes (`sklx inventory status`'s "Harness
  // presence" section), never as a scan gate — that precedent is followed
  // here too. A directory-name collision between two DIFFERENT skills that
  // happen to share an identifier across two clients' directories is
  // exactly the kind of finding the exact-collision pass already looks
  // for (unchanged semantics — see `collision-detector.helpers.ts`'s
  // `detectExactCollisions`, which has always matched by identifier across
  // every scanned source, not scoped per-directory); this is intentionally
  // additive, not a filtered subset.
  for (const client of CLIENT_IDS) {
    const skillsDir = resolveClientSkillsDir(client, homeDir)
    entries.push(...scanSkills(skillsDir, manifest, warnings, client))
  }

  // Source 2: ~/.claude/commands/*.md — Claude Code only; no other
  // supported client has an equivalent slash-command directory.
  entries.push(...scanCommands(path.join(claudeDir, 'commands'), warnings))

  // Source 3: ~/.claude/agents/*.md — Claude Code only, same rationale.
  entries.push(...scanAgents(path.join(claudeDir, 'agents'), warnings))

  // Source 4: ~/.claude/CLAUDE.md and (optional) project CLAUDE.md —
  // Claude Code only, same rationale.
  const userClaudeMd = path.join(claudeDir, 'CLAUDE.md')
  if (fs.existsSync(userClaudeMd)) {
    entries.push(...extractClaudeMdTriggers(userClaudeMd, warnings))
  }
  if (opts.projectDir) {
    const projectClaudeMd = path.join(opts.projectDir, 'CLAUDE.md')
    if (fs.existsSync(projectClaudeMd)) {
      entries.push(...extractClaudeMdTriggers(projectClaudeMd, warnings))
    }
  }

  // Source 5 (SMI-6228): Claude Code plugin-installed skills under
  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/**,
  // gated on `enabledPlugins["<plugin>@<marketplace>"] === true` in
  // ~/.claude/settings.json. Additive to Sources 1-4 — plugin-installed
  // skills were invisible to this scanner before this source existed
  // (discovered via a vendor Supabase plugin colliding with this project's
  // own `supabase` skill — see Source 6 below for the other half of that
  // scenario this source alone did not close).
  entries.push(...scanPluginInventory(claudeDir, manifest, warnings))

  // Source 6 (SMI-6240): this project's own `.claude/skills/` mount-point
  // (the private `skillsmith-strategy` submodule). Source 1 is USER-level
  // only (~/.claude/skills), so a project-relative skill was invisible to
  // this scanner even after Source 5 existed — the actual other half of
  // the Source 5 collision scenario above. See `scanProjectSkills` for the
  // full rationale.
  if (opts.projectDir) {
    const projectSkillsDir = path.join(opts.projectDir, '.claude', 'skills')
    // GPT-5.6-Sol review finding (commit 4a883c9aa): a symlinked `.claude`
    // or `skills` segment could resolve outside `projectDir` even though
    // the lexical join above looks safe — same class of gap the Source 5
    // plugin scan already guards against with `isWithinRoot`. Only check
    // when the directory exists: `scanSkillsDirEntries` itself degrades
    // silently (no warning) for a missing directory, and `isWithinRoot`'s
    // `realpathSync` would otherwise throw on a nonexistent path and turn
    // that silent case into a spurious skip-warning.
    if (fs.existsSync(projectSkillsDir)) {
      if (isWithinRoot(opts.projectDir, projectSkillsDir)) {
        entries.push(...scanProjectSkills(projectSkillsDir, manifest, warnings))
      } else {
        warnings.push({
          code: WARNING_CODES.PROJECT_SKILLS_SCAN_SKIPPED,
          message: `${projectSkillsDir} resolves outside the project directory (symlink escape); skipping`,
          context: { path: projectSkillsDir },
        })
      }
    }
  }

  // Stable ordering for downstream consumers.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.identifier.localeCompare(b.identifier)
  })

  const elapsedNs = process.hrtime.bigint() - startedAt
  const durationMs = Number(elapsedNs) / 1_000_000

  return { entries, warnings, durationMs }
}

/**
 * Scan a single client's native skills directory (e.g. `~/.claude/skills/*`,
 * `~/.cursor/skills/*`) for SKILL.md frontmatter. Returns one entry per
 * directory; entries without SKILL.md are still recorded (with
 * directory-name fallback) so the collision detector still sees them.
 *
 * Thin wrapper over {@link scanSkillsDirEntries} that tags the result as
 * Source 1 (`origin: 'native-client'`, `client` set). See
 * {@link scanPluginSkills} for the Source 5 (plugin-scan) counterpart, which
 * shares this same directory-walking logic but tags differently.
 */
function scanSkills(
  skillsDir: string,
  manifest: Record<string, unknown> | null,
  warnings: ScanWarning[],
  client: ClientId
): InventoryEntry[] {
  return scanSkillsDirEntries(skillsDir, manifest, warnings).map((entry) => ({
    ...entry,
    client,
    origin: 'native-client',
  }))
}

/**
 * Scan a plugin's `skills/` directory (SMI-6228 Source 5) — the pinned
 * cache copy at
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/**`, NOT
 * the marketplace git clone. Same directory shape as a client's native
 * skills directory (one `SKILL.md` per subdirectory), so this reuses
 * {@link scanSkillsDirEntries} and only differs in how the result is
 * tagged: `origin: 'plugin'` + `pluginId`, with `client` left `undefined`
 * (a plugin is not a `ClientId` install target — see the doc comment on
 * `InventoryEntry.origin`).
 */
function scanPluginSkills(
  skillsDir: string,
  manifest: Record<string, unknown> | null,
  warnings: ScanWarning[],
  pluginId: string
): InventoryEntry[] {
  return scanSkillsDirEntries(skillsDir, manifest, warnings).map((entry) => ({
    ...entry,
    origin: 'plugin',
    pluginId,
  }))
}

/**
 * Source 6 (SMI-6240): this project's own `.claude/skills/` mount-point —
 * the private `skillsmith-strategy` submodule (see CLAUDE.md's Skill
 * Location Policy). Source 1 only scans USER-level client directories
 * (`~/.claude/skills`, etc.); a project-relative skill was invisible to
 * this scanner even after Source 5 (plugin scan) existed. This is the
 * actual missing half of the scenario that motivated Source 5 in the first
 * place — a vendor plugin skill colliding with THIS project's own skill
 * (e.g. its `supabase` skill) was undetectable on either side until now.
 * `client: CANONICAL_CLIENT` because no other supported client reads this
 * project-relative convention today (same rationale as Sources 2-4).
 */
function scanProjectSkills(
  skillsDir: string,
  manifest: Record<string, unknown> | null,
  warnings: ScanWarning[]
): InventoryEntry[] {
  return scanSkillsDirEntries(skillsDir, manifest, warnings).map((entry) => ({
    ...entry,
    client: CANONICAL_CLIENT,
    origin: 'project',
  }))
}

/**
 * Source 5 (SMI-6228): Claude Code plugin-installed skills.
 *
 * For every plugin enabled in `~/.claude/settings.json` (per
 * {@link readEnabledPluginIds}), resolve its skills from the PINNED CACHE
 * copy — `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/**`
 * — never the marketplace git clone. The `<version>` segment is an opaque,
 * arbitrary hash assigned by Claude Code's plugin manager; it is discovered
 * by listing `<marketplace>/<plugin>/`, never hardcoded. Exactly one version
 * directory is the expected steady state — zero (plugin id references a
 * cache dir that was never populated or was since removed) or multiple
 * (an in-progress or interrupted plugin update) both fail soft with a
 * `PLUGIN_SCAN_SKIPPED` warning rather than guessing which version is live.
 *
 * Path-traversal/symlink guards (`isSafePathComponent`/`isWithinRoot`,
 * GPT-5.6-Sol review finding) live in `local-inventory.helpers.ts`.
 */
function scanPluginInventory(
  claudeDir: string,
  manifest: Record<string, unknown> | null,
  warnings: ScanWarning[]
): InventoryEntry[] {
  const settingsPath = path.join(claudeDir, 'settings.json')
  const enabledPluginIds = readEnabledPluginIds(settingsPath, warnings)
  if (enabledPluginIds.length === 0) return []

  const pluginsCacheDir = path.join(claudeDir, 'plugins', 'cache')
  const out: InventoryEntry[] = []

  for (const pluginId of enabledPluginIds) {
    const sep = pluginId.indexOf('@')
    if (sep <= 0 || sep === pluginId.length - 1) {
      warnings.push({
        code: WARNING_CODES.PLUGIN_SCAN_SKIPPED,
        message: `enabledPlugins id "${pluginId}" is not in "<plugin>@<marketplace>" shape; skipping`,
        context: { plugin_id: pluginId },
      })
      continue
    }
    const pluginName = pluginId.slice(0, sep)
    const marketplace = pluginId.slice(sep + 1)
    // Cross-provider review finding (GPT-5.6-Sol, Medium): pluginName/
    // marketplace were previously joined into a path with no check against
    // separators or ".." segments, and the resolved path was never
    // confirmed to stay under pluginsCacheDir.
    if (!isSafePathComponent(pluginName) || !isSafePathComponent(marketplace)) {
      warnings.push({
        code: WARNING_CODES.PLUGIN_SCAN_SKIPPED,
        message: `enabledPlugins id "${pluginId}" has an unsafe path component; skipping`,
        context: { plugin_id: pluginId },
      })
      continue
    }
    const pluginDir = path.join(pluginsCacheDir, marketplace, pluginName)
    if (!isWithinRoot(pluginsCacheDir, pluginDir)) {
      warnings.push({
        code: WARNING_CODES.PLUGIN_SCAN_SKIPPED,
        message: `enabledPlugins id "${pluginId}" resolves outside the plugin cache root; skipping`,
        context: { plugin_id: pluginId, path: pluginDir },
      })
      continue
    }

    let versionDirs: fs.Dirent[]
    try {
      versionDirs = fs
        .readdirSync(pluginDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
    } catch {
      warnings.push({
        code: WARNING_CODES.PLUGIN_SCAN_SKIPPED,
        message: `enabled plugin "${pluginId}" has no cache directory at ${pluginDir}; skipping`,
        context: { plugin_id: pluginId, path: pluginDir },
      })
      continue
    }

    if (versionDirs.length !== 1) {
      warnings.push({
        code: WARNING_CODES.PLUGIN_SCAN_SKIPPED,
        message: `enabled plugin "${pluginId}" has ${versionDirs.length} version directories under ${pluginDir} (expected exactly 1); skipping`,
        context: {
          plugin_id: pluginId,
          path: pluginDir,
          version_dir_count: versionDirs.length,
        },
      })
      continue
    }

    const skillsDir = path.join(pluginDir, versionDirs[0]!.name, 'skills')
    if (!isWithinRoot(pluginsCacheDir, skillsDir)) {
      warnings.push({
        code: WARNING_CODES.PLUGIN_SCAN_SKIPPED,
        message: `enabled plugin "${pluginId}"'s skills directory resolves outside the plugin cache root; skipping`,
        context: { plugin_id: pluginId, path: skillsDir },
      })
      continue
    }
    out.push(...scanPluginSkills(skillsDir, manifest, warnings, pluginId))
  }

  return out
}

/**
 * Scan `~/.claude/commands/*.md`. Frontmatter `description:` wins as
 * trigger surface; otherwise the first non-empty line of the body.
 * Tolerates frontmatter-less files (most slash commands have none).
 */
function scanCommands(commandsDir: string, warnings: ScanWarning[]): InventoryEntry[] {
  if (!fs.existsSync(commandsDir)) return []
  return scanMdDir(commandsDir, 'command', warnings)
}

/**
 * Scan `~/.claude/agents/*.md`. Subagent files always carry frontmatter
 * `description:` per Claude Code convention; surface that. Falls back to
 * filename + body first-line if frontmatter is absent.
 */
function scanAgents(agentsDir: string, warnings: ScanWarning[]): InventoryEntry[] {
  if (!fs.existsSync(agentsDir)) return []
  return scanMdDir(agentsDir, 'agent', warnings)
}

/**
 * Shared scan logic for commands + agents — both follow the
 * "filename = identifier; description from frontmatter or body" shape.
 */
function scanMdDir(
  dir: string,
  kind: 'command' | 'agent',
  warnings: ScanWarning[]
): InventoryEntry[] {
  const out: InventoryEntry[] = []
  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const dirent of dirEntries) {
    if (!dirent.isFile()) continue
    if (!dirent.name.endsWith('.md')) continue
    if (dirent.name.startsWith('.')) continue

    const filePath = path.join(dir, dirent.name)
    const identifier = dirent.name.slice(0, -3) // strip .md
    const fm = readFrontmatter(filePath)
    const description = coerceDescription(fm.description)
    let triggerLine = description ?? ''
    if (!triggerLine) {
      triggerLine = firstNonEmptyLine(readBody(filePath))
    }

    const phrases = capTriggerSurface(
      identifier,
      [identifier, ...(triggerLine ? splitDescriptionToPhrases(triggerLine) : [])],
      warnings
    )

    out.push({
      kind,
      source_path: filePath,
      identifier,
      triggerSurface: phrases,
      mtime: readMtime(filePath),
      client: CANONICAL_CLIENT,
      // Source 2/3 — native-client entries, not plugin-scan ones (SMI-6228).
      origin: 'native-client',
      meta: {
        description: triggerLine || undefined,
      },
    })
  }
  return out
}
