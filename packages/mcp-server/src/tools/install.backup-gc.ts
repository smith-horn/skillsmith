/**
 * @fileoverview Backup garbage-collector for the namespace-rename workflow
 *               (SMI-4588 Wave 2 Step 9, PR #4).
 * @module @skillsmith/mcp-server/tools/install.backup-gc
 *
 * Sweeps `~/.claude/skills/.backups/<skillName>/<timestamp>_<reason>/`
 * directories whose timestamp prefix is older than `retentionDays`
 * (default 14, configurable via `SKILLSMITH_BACKUP_RETENTION_DAYS`,
 * clamped to [1, 365]).
 *
 * Lives in `mcp-server` (not `core`) because `getBackupsDir()` is
 * canonical in `mcp-server/tools/install.conflict-helpers.ts`. An upward
 * dependency from `core` would either violate the package boundary or
 * duplicate the path constant and drift (plan §1 Edit 4).
 *
 * Failure model:
 *
 *   - Missing backup root → `removed: 0, kept: 0` (nothing to do).
 *   - Malformed timestamp directory (manual user dir, non-ISO prefix) →
 *     skipped with `console.warn`; the sweep never aborts mid-walk.
 *   - `fs.rm` failure on a single entry → logged with `console.warn`;
 *     remaining entries continue to be evaluated. Idempotent: a partial
 *     failure on one run is recoverable on the next.
 *
 * Trigger points (Wave 4 wires these — Wave 2 ships only the helper):
 *
 *   - Free / Individual / Team: invoked at session-start by Wave 4's
 *     `session-start-audit.ts` hook.
 *   - Enterprise: invoked by Wave 4's `scheduled-audit/runner.ts` cron.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { getBackupsDir } from './install.conflict-helpers.js'

const DEFAULT_RETENTION_DAYS = 14
const MIN_RETENTION_DAYS = 1
const MAX_RETENTION_DAYS = 365
const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface RunBackupGCOptions {
  /** Override the backups directory (defaults to `getBackupsDir()`). */
  backupsDir?: string
  /**
   * Retention threshold in days. Clamped to `[1, 365]`. Defaults to the
   * `SKILLSMITH_BACKUP_RETENTION_DAYS` env var (also clamped) and falls
   * back to 14.
   */
  retentionDays?: number
  /** Override "now" for tests. Defaults to `Date.now()`. */
  now?: Date
}

export interface RunBackupGCResult {
  /** Number of timestamped backup directories removed by this sweep. */
  removed: number
  /** Number of timestamped backup directories retained (still within window). */
  kept: number
  /** Number of leaf entries skipped (malformed timestamp, non-directory). */
  skipped: number
}

/**
 * Resolve the retention window in days. Caller-provided value wins; falls
 * back to `SKILLSMITH_BACKUP_RETENTION_DAYS` env var; finally
 * `DEFAULT_RETENTION_DAYS`. Always clamped to `[1, 365]`.
 */
function resolveRetentionDays(override: number | undefined): number {
  const candidate =
    override !== undefined
      ? override
      : (() => {
          const raw = process.env['SKILLSMITH_BACKUP_RETENTION_DAYS']
          if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS
          const parsed = Number(raw)
          if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS
          return parsed
        })()
  if (!Number.isFinite(candidate)) return DEFAULT_RETENTION_DAYS
  if (candidate < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS
  if (candidate > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS
  return Math.floor(candidate)
}

/**
 * Parse the ISO-like timestamp prefix produced by `createSkillBackup`.
 * The writer formats `new Date().toISOString().replace(/[:.]/g, '-')` and
 * appends `_<reason>` — e.g. `2026-04-30T15-42-18-331Z_namespace-rename`.
 *
 * Returns the parsed `Date` on success, `null` on any of:
 *
 *   - No `_` separator (no `<reason>` suffix at all).
 *   - Empty timestamp prefix (`_reason` only).
 *   - Timestamp portion that does not round-trip through `Date.parse`.
 *
 * The reason suffix may itself contain hyphens; we split on the FIRST `_`
 * only.
 */
function parseBackupTimestamp(name: string): Date | null {
  const sepIdx = name.indexOf('_')
  if (sepIdx <= 0) return null
  const tsPortion = name.slice(0, sepIdx)
  // Reverse the writer's `[:.] → '-'` substitution to recover an ISO string.
  // The pattern is `YYYY-MM-DDTHH-mm-ss-SSSZ` → `YYYY-MM-DDTHH:mm:ss.SSSZ`.
  // Match the trailing `Z` + 3-digit ms + 2-digit s + 2-digit m + 2-digit h
  // boundary so we only touch the time portion (the date uses `-` legitimately).
  const isoMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(tsPortion)
  if (!isoMatch) return null
  const [, datePart, hh, mm, ss, ms] = isoMatch
  const isoCandidate = `${datePart}T${hh}:${mm}:${ss}.${ms}Z`
  const parsed = Date.parse(isoCandidate)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed)
}

/**
 * Sweep stale backup directories under `<backupsDir>/<skillName>/`. Idempotent:
 * safe to invoke concurrently (uses `fs.rm` with `force: true` and treats
 * already-removed dirs as success).
 *
 * Walk: two levels deep. Level 1 = skill-name directories; level 2 =
 * timestamp-prefixed leaf directories. Files at any level are ignored;
 * malformed timestamp leaves are skipped (with `console.warn`).
 */
export async function runBackupGC(opts: RunBackupGCOptions = {}): Promise<RunBackupGCResult> {
  const backupsDir = opts.backupsDir ?? getBackupsDir()
  const retentionDays = resolveRetentionDays(opts.retentionDays)
  const nowMs = (opts.now ?? new Date()).getTime()
  const cutoffMs = nowMs - retentionDays * MS_PER_DAY

  const result: RunBackupGCResult = { removed: 0, kept: 0, skipped: 0 }

  let level1: string[]
  try {
    const entries = await fs.readdir(backupsDir, { withFileTypes: true })
    level1 = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (err) {
    // Missing root → nothing to do. Other errors (permission denied) bubble
    // as warnings; sweep is best-effort.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return result
    }
    console.warn(
      `[install.backup-gc] failed to enumerate ${backupsDir} (${(err as Error).message}); aborting sweep`
    )
    return result
  }

  for (const skillName of level1) {
    const skillDir = path.join(backupsDir, skillName)
    let leaves: string[]
    try {
      const entries = await fs.readdir(skillDir, { withFileTypes: true })
      leaves = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch (err) {
      console.warn(
        `[install.backup-gc] failed to enumerate ${skillDir} (${(err as Error).message}); skipping skill`
      )
      continue
    }

    for (const leaf of leaves) {
      // The `.original` directory is reserved by `storeOriginal()` for
      // three-way merge state — never GC it (mirrors the
      // `cleanupOldBackups` carve-out in install.conflict-helpers.ts:202).
      if (leaf === '.original') {
        result.kept += 1
        continue
      }

      const ts = parseBackupTimestamp(leaf)
      if (ts === null) {
        console.warn(
          `[install.backup-gc] skipping malformed backup directory: ${path.join(skillDir, leaf)}`
        )
        result.skipped += 1
        continue
      }

      if (ts.getTime() > cutoffMs) {
        result.kept += 1
        continue
      }

      const leafPath = path.join(skillDir, leaf)
      try {
        await fs.rm(leafPath, { recursive: true, force: true })
        result.removed += 1
      } catch (err) {
        console.warn(
          `[install.backup-gc] failed to remove ${leafPath} (${(err as Error).message}); leaving in place`
        )
      }
    }
  }

  return result
}
