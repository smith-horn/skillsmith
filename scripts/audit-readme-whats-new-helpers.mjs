/**
 * Helper for Check 60 (README "What's New" Currency, SMI-5613).
 * Extracted for unit testability, matching the audit-mcp-tool-count-helpers.mjs
 * precedent (Check 25).
 */

/**
 * Extracts the version from a README's "## What's New in vX.Y.Z" heading.
 * Tolerates a missing leading "v". Returns null if no such heading is found.
 *
 * @param {string} readmeContent
 * @returns {string | null}
 */
export function extractWhatsNewVersion(readmeContent) {
  const match = readmeContent.match(/^## What's New in v?(\d+\.\d+\.\d+)/m)
  return match ? match[1] : null
}
