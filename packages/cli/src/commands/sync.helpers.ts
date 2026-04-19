/**
 * sync command helpers (SMI-4287)
 *
 * Extracted from `sync.ts` to keep the main command file under the 500-line
 * governance ceiling. Covers local-skill adapter scanning and warning
 * formatting for the `sync status` subcommand.
 */

import chalk from 'chalk'
import { createLocalFilesystemAdapter, type AdapterError } from '@skillsmith/core'
import { DEFAULT_SKILLS_DIR } from '../config.js'

/**
 * Scan `~/.claude/skills` for non-fatal adapter warnings.
 *
 * Pulls `SourceSearchResult.warnings[]` from a fresh LocalFilesystemAdapter
 * so `sync status` surfaces symlink-escape / permission / loop issues.
 * Returns an empty array if the skills dir does not exist (e.g. fresh
 * install) or the adapter fails to initialise — `sync status` must not
 * crash just because local skills couldn't be scanned.
 */
export async function scanLocalSkillsForWarnings(): Promise<AdapterError[]> {
  try {
    const adapter = createLocalFilesystemAdapter({
      id: 'sync-status-local',
      name: 'Local Skills',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: DEFAULT_SKILLS_DIR,
      followSymlinks: true,
    })
    await adapter.initialize()
    const result = await adapter.search({})
    return result.warnings ?? []
  } catch {
    return []
  }
}

/**
 * Format adapter warnings for stderr display.
 *
 * One `chalk.yellow` line per warning with a machine-readable prefix the
 * user can grep for: `[symlink-guard]`, `[permission]`, `[loop]`,
 * `[not-found]`, `[io]`.
 */
export function formatAdapterWarnings(warnings: AdapterError[]): string[] {
  return warnings.map((warning) => {
    const prefix = warning.code === 'symlink-escape' ? 'symlink-guard' : warning.code
    return chalk.yellow(`  [${prefix}] ${warning.message}`)
  })
}
