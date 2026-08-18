/**
 * Version check utility for auto-update notifications
 * @see SMI-1952: Add auto-update check to MCP server startup
 */
import { resolveClientId } from '../install/paths.js'

/**
 * Result of a version check against npm registry
 */
export interface VersionCheckResult {
  /** Currently installed version */
  currentVersion: string
  /** Latest version available on npm */
  latestVersion: string
  /** True if a newer version is available */
  updateAvailable: boolean
  /** Command to update the package */
  updateCommand: string
}

/** Default timeout for npm registry requests (3 seconds) */
const VERSION_CHECK_TIMEOUT_MS = 3000

/**
 * Check for updates to a package by querying the npm registry
 *
 * @param packageName - The npm package name to check (e.g., '@skillsmith/mcp-server')
 * @param currentVersion - The currently installed version
 * @returns Version check result, or null if check failed (network error, timeout, etc.)
 *
 * @example
 * ```typescript
 * const result = await checkForUpdates('@skillsmith/mcp-server', '0.3.0')
 * if (result?.updateAvailable) {
 *   console.log(`Update available: ${result.latestVersion}`)
 * }
 * ```
 */
export async function checkForUpdates(
  packageName: string,
  currentVersion: string
): Promise<VersionCheckResult | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as { version?: string }
    const latestVersion = data.version

    if (!latestVersion) {
      return null
    }

    return {
      currentVersion,
      latestVersion,
      updateAvailable: latestVersion !== currentVersion,
      updateCommand: `npx ${packageName}@latest`,
    }
  } catch {
    // Silent failure on any error (timeout, network, parse, etc.)
    return null
  }
}

/**
 * Format update notification message for stderr output
 *
 * SMI-5893 Wave 10 (GH#2368 C-06/C-07/C-22): upgrading the npm package alone
 * never refreshes on-disk onboarding artifacts (hooks.json, the bundled
 * slash-command skill's SKILL.md, agent-pack hook scripts) — those are only
 * (re)written when the corresponding install command actually runs. Before
 * this change the message assumed Claude Code and said nothing about this,
 * so a Cursor (or any non-Claude-Code) user who upgraded the package still
 * saw stale hooks/SKILL.md content with no indication why.
 *
 * Verified against current command behavior, not assumed:
 *  - `skillsmith setup --client <client>` installs the bundled slash-command
 *    skill but SKIPS an already-present install unless `--force` is passed
 *    (`install-skill.ts`) — so `--force` is required here to actually refresh
 *    it, and `--client` IS supported (per-client target path).
 *  - `skillsmith agent install` (hooks, MCP registration, agent-pack SKILL.md)
 *    always re-writes Skillsmith-owned artifacts on every run, with or
 *    without `--force` — that flag only controls whether a FOREIGN
 *    conflicting entry gets overwritten (`agent.ts`'s own `--force` help
 *    text). It has NO `--client` flag — it auto-detects and installs into
 *    every present harness, so `client` is threaded only into the `setup`
 *    line below, not this one.
 *
 * Code-review finding (real regression): an earlier draft of this message
 * dropped `result.updateCommand` (the actual "how do I get the new npm
 * version" instruction) entirely, replacing it solely with the on-disk-
 * artifact-refresh commands above — which run against the STILL-OLD
 * installed binary and never upgrade anything. Both instructions are
 * necessary and address different problems; neither substitutes the other.
 *
 * @param result - Version check result with update available
 * @param client - Resolved client ID (e.g. via {@link resolveUpdateNotificationClient}),
 *   if available. When omitted, the message stays generic rather than
 *   guessing a client.
 * @returns Formatted message string
 */
export function formatUpdateNotification(result: VersionCheckResult, client?: string): string {
  const clientFlag = client ? ` --client ${client}` : ''
  return (
    `[skillsmith] Update available: ${result.currentVersion} → ${result.latestVersion}\n` +
    `Run \`${result.updateCommand}\` to use the new version.\n` +
    `Note: upgrading does not refresh onboarding artifacts already on disk —\n` +
    `run \`skillsmith setup --force${clientFlag}\` to refresh the bundled skill, and\n` +
    `\`skillsmith agent install\` to refresh hooks/MCP registration.`
  )
}

/**
 * Resolve `SKILLSMITH_CLIENT` for {@link formatUpdateNotification}'s
 * optional `client` parameter, without ever throwing (code-review finding,
 * SMI-5893 Wave 10): the only production call site (`mcp-server/src/index.ts`)
 * awaits this inside a `.then()` whose trailing `.catch()` is empty — an
 * uncaught throw from `resolveClientId` on an invalid env value would
 * silently drop the ENTIRE update notification, not just degrade to the
 * generic message this function's own contract promises.
 *
 * Also deliberately does NOT call `resolveClientId(undefined)` when `raw`
 * is unset — that would return `'claude-code'` (its documented default),
 * which is actively wrong here: of the 9 client harnesses this repo
 * supports, only Cursor's own generated MCP config ever sets
 * `SKILLSMITH_CLIENT` (confirmed via `packages/cli/src/templates/mcp-server.template.snippets.ts` —
 * the claude-code/copilot/windsurf/agents/codex/opencode/hermes/grok/
 * antigravity snippets never set it). Defaulting to claude-code would tell
 * a Windsurf/Copilot/etc. user to `setup --force --client claude-code`,
 * pointing them at `~/.claude/skills` instead of their actual client's
 * directory. Staying `undefined` here keeps the message client-neutral for
 * everyone this env var was never meant to identify.
 *
 * @param raw - `process.env.SKILLSMITH_CLIENT`, or any other raw string.
 * @returns the resolved client id, or `undefined` if `raw` is unset/empty
 *   or does not resolve to a known client.
 */
export function resolveUpdateNotificationClient(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    return resolveClientId(raw)
  } catch {
    return undefined
  }
}
