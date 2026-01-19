/**
 * CLI Configuration
 *
 * Shared configuration constants for the Skillsmith CLI.
 */

import { join } from 'path'
import { homedir } from 'os'

/**
 * Default database path: ~/.skillsmith/skills.db
 * This matches the seed script and MCP server defaults.
 */
export const DEFAULT_DB_PATH = join(homedir(), '.skillsmith', 'skills.db')

/**
 * Default skills installation directory: ~/.claude/skills
 */
export const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills')

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
