/**
 * CLI Configuration
 *
 * Shared configuration constants for the Skillsmith CLI.
 */

import { join } from 'path'
import { homedir } from 'os'
import { getCanonicalInstallPath } from '@skillsmith/core/install'

/**
 * Default database path: ~/.skillsmith/skills.db
 * This matches the seed script and MCP server defaults.
 */
export const DEFAULT_DB_PATH = join(homedir(), '.skillsmith', 'skills.db')

/**
 * Default skills installation directory.
 *
 * SMI-4578: routes through the canonical multi-client path table so the
 * default-client (Claude Code) directory is defined in exactly one place.
 * Callers that need a non-default client should call `getInstallPath(client)`
 * from `@skillsmith/core/install` instead of overriding this constant.
 */
export const DEFAULT_SKILLS_DIR = getCanonicalInstallPath()

/**
 * Default manifest path: ~/.skillsmith/manifest.json
 */
export const DEFAULT_MANIFEST_PATH = join(homedir(), '.skillsmith', 'manifest.json')

/**
 * Get the default database path.
 * Returns ~/.skillsmith/skills.db
 */
export function getDefaultDbPath(): string {
  return DEFAULT_DB_PATH
}
