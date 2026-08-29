#!/usr/bin/env node
/**
 * Plugin-config scan for the MCP command guard (SMI-6229).
 *
 * Discovers MCP server configs registered by Claude Code plugins under
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json` — the
 * third scan source `mcp-command-guard.mjs` needs, because plugin-scoped
 * configuration lives entirely outside this repo's `.mcp.json` and
 * `~/.claude.json`, the guard's two pre-existing sources. This is the only
 * place a plugin-registered hosted server like `mcp.supabase.com` actually
 * appears on disk (SMI-6229 Context).
 *
 * SECURITY-RELEVANT DUPLICATION (ADR-137): `readEnabledPluginIds` below is a
 * native `.mjs` reimplementation of
 * packages/mcp-server/src/utils/local-inventory.helpers.ts's function of the
 * same name (SMI-6228 Wave 1) — not a shared import, because this file runs
 * on a `SessionStart` hook path where `packages/mcp-server/dist` may not
 * exist yet (fresh clone, interrupted install), and an advisory guard must
 * never turn a missing build artifact into a startup failure. This is NOT a
 * cosmetic duplication: the ids this function returns decide which
 * plugin-registered MCP servers get evaluated by
 * `findHostedScopeViolations` in ./mcp-command-guard.mjs, a check that
 * exists specifically to catch a hosted server exposing write-capable
 * database tools (`execute_sql`, `apply_migration`). A silent divergence
 * between this file and the TS reference implementation would mean this
 * guard scans a different plugin set than `skill_inventory_audit` does —
 * the guard could go blind to exactly the class of risk this scan exists to
 * catch, with nothing else to signal that it happened. That is a security
 * gap, not a cosmetic inconsistency.
 *
 * @see packages/mcp-server/src/utils/local-inventory.helpers.ts (readEnabledPluginIds, SMI-6228 Wave 1)
 * @see packages/mcp-server/tests/unit/plugin-scan-parity.test.ts — enforces agreement between the two implementations
 * @see docs/internal/implementation/mcp-guard-plugin-config-scan.md
 * @see docs/internal/adr/136-cross-runtime-duplication-of-security-logic.md
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, sep as pathSep } from 'node:path'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse `<claudeDir>/settings.json`'s `enabledPlugins` map and return the
 * ids (`<plugin>@<marketplace>` shape) whose value is exactly boolean
 * `true`. Mirrors
 * packages/mcp-server/src/utils/local-inventory.helpers.ts's function of
 * the same name (SMI-6228 Wave 1) — see this file's header for why this is
 * a reimplementation rather than a shared import, and why a divergence here
 * is a security concern, not a cosmetic one.
 *
 * The exact-`true` gate is load-bearing, not incidental: a disabled plugin
 * (`false`) must not have its MCP config scanned, or a stale, deliberately
 * disabled server config would resurface as a false positive.
 *
 * Fail-soft, split by what the failure means (mirrors the TS reference's
 * fail-soft behavior with one deliberate divergence, named below):
 * - Missing file, unreadable file, malformed JSON, missing `enabledPlugins`
 *   key: silent `[]` — normal absent states.
 * - `enabledPlugins` present but not an object: `[]` plus one
 *   `console.error` line. **Named divergence from the TS reference
 *   (plan-review High #3)**: the TS `readEnabledPluginIds` is silent in
 *   this exact case (pushes to a `warnings[]` array consumed by an audit
 *   report, not stderr). This guard's only output channel is stderr, and a
 *   corrupt `enabledPlugins` shape means the guard is blind for this
 *   source — worth a line, matching this file's own
 *   `~/.claude.json`-`projects`-not-an-object precedent in
 *   ./mcp-command-guard.mjs. The two implementations still agree on the
 *   *returned ids* (both `[]`) for this case, so the parity test still
 *   passes; they disagree only on side-channel reporting, which the parity
 *   test does not and should not check.
 */
export function readEnabledPluginIds(settingsPath) {
  if (!existsSync(settingsPath)) return []

  let raw
  try {
    raw = readFileSync(settingsPath, 'utf-8')
  } catch {
    return []
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Silent, deliberately: matches this guard's existing ~/.claude.json
    // parse-failure privacy constraint — Node's JSON.parse SyntaxError
    // embeds a raw snippet of the offending source, and settings.json
    // carries `env` blocks and hook configuration.
    return []
  }

  if (!isPlainObject(parsed)) return []
  const enabledPlugins = parsed.enabledPlugins
  if (enabledPlugins === undefined) return []
  if (!isPlainObject(enabledPlugins)) {
    console.error(
      '[mcp-command-guard] ~/.claude/settings.json enabledPlugins is not an object — plugin MCP configs will not be scanned this run.'
    )
    return []
  }

  return Object.entries(enabledPlugins)
    .filter(([, value]) => value === true)
    .map(([id]) => id)
}

/**
 * Resolve the pinned-cache `.mcp.json` path for one enabled plugin id, or
 * `null` if it cannot be resolved. Mirrors the pinned-cache resolution in
 * `local-inventory.ts`'s `scanPluginInventory` (SMI-6228 Wave 1): split at
 * the FIRST `@`, discover (never hardcode) the plugin's opaque version-hash
 * directory by listing, require exactly one.
 *
 * Zero or multiple version directories is a normal transient state (an
 * in-progress or interrupted plugin update) and fails soft with a silent
 * skip — deliberately no `console.error` here (mcp-command-guard.mjs's
 * fail-soft table): an un-debounced stderr line on every session start
 * through an update window would be noise, and the guard runs on every
 * startup so the blindness window closes on its own.
 *
 * Cross-provider review finding (GPT-5.6-Sol, Medium): `pluginName` and
 * `marketplace` come straight from an `enabledPlugins` KEY in
 * `~/.claude/settings.json` — not validated by anything upstream of this
 * function. Without a check here, an id like `"../outside@../.."` would
 * resolve `pluginDir` well outside `~/.claude/plugins/cache`, and a
 * symlinked path component could do the same even with clean-looking
 * segments. Reject any component containing a path separator or a `..`
 * segment, then confirm the fully-resolved path still lives under the
 * cache root before ever calling `readdirSync`/`readFileSync` on it — this
 * guard's job is to read plugin-registered MCP configs, not to become a
 * path into arbitrary files on disk.
 */
export function resolvePluginMcpConfigPath(claudeDir, pluginId) {
  const sep = pluginId.indexOf('@')
  if (sep <= 0 || sep === pluginId.length - 1) return null

  const pluginName = pluginId.slice(0, sep)
  const marketplace = pluginId.slice(sep + 1)
  if (!isSafePathComponent(pluginName) || !isSafePathComponent(marketplace)) return null

  const cacheRoot = join(claudeDir, 'plugins', 'cache')
  const pluginDir = join(cacheRoot, marketplace, pluginName)
  if (!isWithinRoot(cacheRoot, pluginDir)) return null

  let versionDirs
  try {
    versionDirs = readdirSync(pluginDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return null
  }
  if (versionDirs.length !== 1) return null

  const versionDirName = versionDirs[0].name
  if (!isSafePathComponent(versionDirName)) return null

  const configPath = join(pluginDir, versionDirName, '.mcp.json')
  if (!isWithinRoot(cacheRoot, configPath)) return null

  // Verified live (docs/internal/implementation/mcp-guard-plugin-config-scan.md
  // "Surface Grounding"): the plugin's .mcp.json sits at the version-dir
  // ROOT, NOT under skills/.
  return configPath
}

/** Rejects path separators, `.`/`..` segments, and empty strings. */
function isSafePathComponent(component) {
  return (
    typeof component === 'string' &&
    component.length > 0 &&
    component !== '.' &&
    component !== '..' &&
    !component.includes('/') &&
    !component.includes('\\')
  )
}

/**
 * True when `candidate`, once resolved to its REAL (symlink-followed) path,
 * is `root` or nested under it.
 *
 * Cross-provider review finding (GPT-5.6-Sol, Medium): the first version of
 * this check used lexical `path.resolve()`, which normalizes `..`/`.`
 * segments but does NOT follow symlinks — so a symlinked cache subdirectory
 * pointing outside the tree (e.g. `cache/marketplace/plugin -> /etc`) would
 * pass the string-prefix check even though `readdirSync`/`readFileSync`
 * would then genuinely follow it outside the cache root. `realpathSync`
 * resolves symlinks; comparing REAL paths closes that gap. A path that
 * doesn't exist yet (a normal case — an enabled plugin whose cache
 * directory was never populated) makes `realpathSync` throw, which this
 * function treats as "not safely within root" (fails closed, same
 * `null`-and-skip outcome the caller already had for a missing directory).
 */
function isWithinRoot(root, candidate) {
  let resolvedRoot
  let resolvedCandidate
  try {
    resolvedRoot = realpathSync(root)
    resolvedCandidate = realpathSync(candidate)
  } catch {
    return false
  }
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + pathSep)
}

/**
 * Scan every enabled plugin's pinned-cache `.mcp.json` for an `mcpServers`
 * block. Returns one entry per plugin whose config resolves and parses to
 * an object `mcpServers` map. Plugins with no resolvable config, an
 * unreadable config, or a malformed config are silently skipped — fail-soft,
 * no `console.error`, same "normal absent state" reasoning as
 * `resolvePluginMcpConfigPath`'s version-dir case.
 */
export function scanPluginMcpServers({ homeDir }) {
  const claudeDir = join(homeDir, '.claude')
  const out = []

  for (const pluginId of readEnabledPluginIds(join(claudeDir, 'settings.json'))) {
    const configPath = resolvePluginMcpConfigPath(claudeDir, pluginId)
    if (!configPath || !existsSync(configPath)) continue

    let parsed
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
      continue
    }

    if (isPlainObject(parsed?.mcpServers)) {
      out.push({ pluginId, mcpServers: parsed.mcpServers })
    }
  }

  return out
}
