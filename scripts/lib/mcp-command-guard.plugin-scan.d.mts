/**
 * SMI-6229 — type declarations for scripts/lib/mcp-command-guard.plugin-scan.mjs.
 *
 * Mirrors the exports of the TS reference implementation
 * (packages/mcp-server/src/utils/local-inventory.helpers.ts's
 * `readEnabledPluginIds`) so that TypeScript consumers (e.g. the
 * cross-runtime parity test) can import mcp-command-guard.plugin-scan.mjs
 * cleanly under NodeNext module resolution without @ts-expect-error
 * suppression. The .d.mts extension is the correct pairing for a .mjs
 * module under NodeNext — same convention as scripts/lib/project-dir.d.mts
 * (SMI-5419).
 */

export function readEnabledPluginIds(settingsPath: string): string[]
export function resolvePluginMcpConfigPath(claudeDir: string, pluginId: string): string | null
export function scanPluginMcpServers(opts: {
  homeDir: string
}): Array<{ pluginId: string; mcpServers: Record<string, unknown> }>
