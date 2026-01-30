/**
 * Version check utility for auto-update notifications
 * @see SMI-1952: Add auto-update check to MCP server startup
 */

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
 * @param result - Version check result with update available
 * @returns Formatted message string
 */
export function formatUpdateNotification(result: VersionCheckResult): string {
  return (
    `[skillsmith] Update available: ${result.currentVersion} → ${result.latestVersion}\n` +
    `Restart Claude Code to use the latest version.`
  )
}
