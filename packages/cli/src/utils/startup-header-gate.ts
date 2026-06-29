/**
 * SMI-5427: gate for the CLI startup header (version + license banner).
 *
 * The header is human context, not program output, so it is suppressed for
 * non-TTY / piped / scripted use, for the auth commands, and for machine-readable
 * subcommands. Subcommands are matched by FULL path (`parent leaf`) — a bare leaf
 * like `status` is ambiguous across groups (`inventory status` vs `sync status`
 * vs `telemetry status`), so matching the leaf alone would over-exempt.
 *
 * @module @skillsmith/cli/utils/startup-header-gate
 */

/** Commands (full `parent leaf` path, or bare leaf for top-level) that never show the header. */
const NO_HEADER_COMMANDS = new Set<string>([
  'login',
  'logout',
  'whoami',
  'inventory push',
  'inventory status',
  'inventory forget-device',
])

/**
 * Resolve a command's full path. A top-level command (whose parent is the program
 * root) resolves to its bare leaf name; a subcommand resolves to `parent leaf`.
 *
 * @param leaf - The action command's own name (e.g. `push`).
 * @param parentName - The parent command's name, or `undefined` for top-level.
 * @param rootName - The program root name (`skillsmith` or the `sklx` alias).
 */
export function resolveCommandPath(
  leaf: string,
  parentName: string | undefined,
  rootName: string
): string {
  return parentName && parentName !== rootName ? `${parentName} ${leaf}` : leaf
}

/**
 * Whether the startup header should be displayed.
 *
 * @param commandPath - Full command path from {@link resolveCommandPath}.
 * @param isTTY - `process.stdout.isTTY`; a non-TTY (piped/scripted) stream never
 *   shows the header so it cannot pollute machine-readable output.
 */
export function shouldShowStartupHeader(commandPath: string, isTTY: boolean): boolean {
  if (!isTTY) return false
  return !NO_HEADER_COMMANDS.has(commandPath)
}
