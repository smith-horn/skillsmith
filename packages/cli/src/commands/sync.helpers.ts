/**
 * sync command helpers (SMI-4287)
 *
 * Extracted from `sync.ts` to keep the main command file under the 500-line
 * governance ceiling. Covers local-skill adapter scanning and warning
 * formatting for the `sync status` subcommand.
 */

import chalk from 'chalk'
import { createLocalFilesystemAdapter, type AdapterError, type SyncResult } from '@skillsmith/core'
import { DEFAULT_SKILLS_DIR } from '../config.js'

/**
 * SMI-4482: Detect whether a failed sync was caused by exhausted/absent
 * credentials rather than a transient network or server error.
 *
 * Root cause: on a fresh install (`skillsmith sync` before `skillsmith login`,
 * no `SKILLSMITH_API_KEY`) the API client correctly falls back to the public
 * Supabase anon key and reaches the anonymous IP-trial path. Once the per-IP
 * free-trial limit is exhausted the `skills-search` edge function returns
 * HTTP 401 with body `{"error":"Authentication required", ...}`. `SyncEngine`
 * surfaces that raw string in `SyncResult.errors`, so the CLI used to print a
 * bare `Authentication required` with `Σ Total: 0` and no next step.
 *
 * This matches the 401 auth signal so `sync.ts` can replace the bare error
 * with actionable guidance.
 *
 * @param result - The `SyncResult` returned by the sync engine.
 * @returns `true` when the sync failed solely because no usable credentials
 *   were available (anonymous trial exhausted or auth rejected).
 */
export function isAuthFailure(result: SyncResult): boolean {
  if (result.success || result.totalProcessed > 0) {
    return false
  }
  return result.errors.some((error) => /authentication required|unauthorized/i.test(error))
}

/**
 * SMI-4482: Actionable, multi-line guidance shown when `sync` fails because
 * no credentials are available. Replaces the previous bare
 * `Error: Authentication required` so the user always has a clear next step.
 *
 * @returns Lines to print to stderr, in order.
 */
export function formatAuthGuidance(): string[] {
  return [
    chalk.yellow('Sync requires authentication. Run: ') + chalk.cyan('skillsmith login'),
    chalk.dim('Or set SKILLSMITH_API_KEY for headless/CI use.'),
  ]
}

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
