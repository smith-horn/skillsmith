/**
 * SMI-1629: Node version detection with helpful errors
 *
 * Validates the runtime Node.js version against the minimum required
 * version specified in package.json engines field.
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Reads the minimum Node.js version from package.json engines field.
 * Falls back to '22.0.0' if not found.
 */
function loadMinNodeVersion(): string {
  try {
    const packageJsonPath = join(__dirname, '..', '..', 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    const engineConstraint = packageJson.engines?.node ?? '>=22.0.0'
    // Extract version number from constraint (e.g., ">=22.0.0" -> "22.0.0")
    return engineConstraint.replace(/[>=<^~\s]/g, '')
  } catch {
    // Fallback if package.json can't be read
    return '22.0.0'
  }
}

const MIN_NODE_VERSION = loadMinNodeVersion()

/**
 * Returns the minimum required Node.js version.
 *
 * @returns The minimum version string (e.g., "22.0.0")
 */
export function getMinNodeVersion(): string {
  return MIN_NODE_VERSION
}

/**
 * Returns the current Node.js version without the "v" prefix.
 *
 * @returns The current version string (e.g., "22.5.0")
 */
export function getCurrentNodeVersion(): string {
  return process.version.replace(/^v/, '')
}

/**
 * Compares two semantic version strings.
 *
 * @param a - First version string (e.g., "22.5.0")
 * @param b - Second version string (e.g., "22.0.0")
 * @returns Positive if a > b, negative if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const parseVersion = (v: string): number[] => {
    // Strip pre-release suffix (e.g., "22.0.0-beta.1" -> "22.0.0")
    const cleanVersion = v.split('-')[0] ?? v
    const parts = cleanVersion.split('.').map((p) => parseInt(p, 10) || 0)
    // Pad to at least 3 parts for consistent comparison
    while (parts.length < 3) {
      parts.push(0)
    }
    return parts
  }

  const partsA = parseVersion(a)
  const partsB = parseVersion(b)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0

    if (numA > numB) return 1
    if (numA < numB) return -1
  }

  return 0
}

/**
 * Formats a helpful error message when the Node.js version is incompatible.
 *
 * @param currentVersion - The current Node.js version
 * @param requiredVersion - The minimum required version
 * @returns A formatted error message with upgrade instructions
 */
export function formatVersionError(currentVersion: string, requiredVersion: string): string {
  return `
Node.js version mismatch detected.

  Current version:  v${currentVersion}
  Required version: v${requiredVersion} or higher

Your Node.js version is too old to run this CLI.

To upgrade Node.js, use one of these methods:

  Using nvm (recommended):
    nvm install ${requiredVersion}
    nvm use ${requiredVersion}

  Using fnm:
    fnm install ${requiredVersion}
    fnm use ${requiredVersion}

  Using volta:
    volta install node@${requiredVersion}

  Download directly:
    https://nodejs.org/

After upgrading, verify with: node --version
`.trim()
}

/**
 * Checks if the current Node.js version meets the minimum requirement.
 *
 * @returns null if the version is acceptable, or an error message string if not
 */
export function checkNodeVersion(): string | null {
  const currentVersion = getCurrentNodeVersion()
  const minVersion = getMinNodeVersion()

  if (compareVersions(currentVersion, minVersion) >= 0) {
    return null
  }

  return formatVersionError(currentVersion, minVersion)
}
