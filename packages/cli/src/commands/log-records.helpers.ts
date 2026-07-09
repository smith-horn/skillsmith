/**
 * @fileoverview Shared helpers for reading redacted on-disk log records
 * (`~/.skillsmith/logs/skillsmith-<surface>-<date>.jsonl`), consumed by both
 * `diagnose.ts` and `logs.ts`.
 * @module @skillsmith/cli/commands/log-records.helpers
 * @see SMI-5615 Wave 3 Step 1 — docs/internal/implementation/production-error-logging.md §5
 *   "DevEx consumption surface"
 *
 * Log-directory resolution intentionally MIRRORS
 * `packages/core/src/logging/rotation.ts`'s (unexported) `getLogDir()` —
 * `SKILLSMITH_LOG_DIR` env override, else `~/.skillsmith/logs` — rather than
 * diverging. `rotation.ts` doesn't export its resolver, so `resolveLogDir`
 * below replicates the exact rule instead of reaching into that module's
 * internals. If `rotation.ts`'s resolution rule ever changes, this must
 * change with it.
 *
 * Records read from disk are already redacted (SMI-883, Wave 1/2 guarantee)
 * — every function here only parses, sorts, filters, and formats; none of it
 * re-derives or logs the raw content anywhere new, so nothing new can leak.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import chalk from 'chalk'
import type { LogLevel, LogRecord } from '@skillsmith/core/logging'

/**
 * Matches `skillsmith-<surface>-<YYYY-MM-DD>.jsonl` and the rolled
 * continuation files (`....jsonl.1`, `....jsonl.2`, ...) `rotation.ts`'s
 * size-cap rollover produces.
 */
const LOG_FILE_PATTERN = /^skillsmith-[a-z]+-\d{4}-\d{2}-\d{2}\.jsonl(\.\d+)?$/

/** `debug < info < warn < error` — mirrors `packages/core/src/logging/types.ts`. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const VALID_LEVELS: ReadonlySet<string> = new Set(Object.keys(LOG_LEVEL_ORDER))

export function isLogLevel(value: string): value is LogLevel {
  return VALID_LEVELS.has(value)
}

/**
 * Log directory. Mirrors `rotation.ts`'s `getLogDir()` exactly (see file
 * header) — `SKILLSMITH_LOG_DIR` is the same test-only seam used by
 * `rotation.test.ts`, read lazily so tests can set it before first use.
 */
export function resolveLogDir(): string {
  return process.env['SKILLSMITH_LOG_DIR'] || join(homedir(), '.skillsmith', 'logs')
}

/** Full paths of every on-disk log file under `dir`, sorted by filename. */
export function listLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => LOG_FILE_PATTERN.test(name))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/**
 * Parses one JSONL file into records. Malformed lines (a truncated tail from
 * a crash mid-append, a line still being written) are skipped rather than
 * thrown — this is a best-effort reader over data that may be actively
 * appended to, never a schema validator.
 */
export function readLogRecords(filePath: string): LogRecord[] {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const records: LogRecord[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed) as LogRecord)
    } catch {
      // Skip unparsable lines — best-effort reader, not a validator.
    }
  }
  return records
}

/** Reads and concatenates records from every log file under `dir`. */
export function readAllLogRecords(dir: string): LogRecord[] {
  return listLogFiles(dir).flatMap((file) => readLogRecords(file))
}

export function sortByTsDesc(records: LogRecord[]): LogRecord[] {
  return [...records].sort((a, b) => b.ts.localeCompare(a.ts))
}

export function sortByTsAsc(records: LogRecord[]): LogRecord[] {
  return [...records].sort((a, b) => a.ts.localeCompare(b.ts))
}

/** Records at or above `minLevel` (`debug < info < warn < error`). */
export function filterByMinLevel(records: LogRecord[], minLevel: LogLevel): LogRecord[] {
  const threshold = LOG_LEVEL_ORDER[minLevel]
  return records.filter((r) => (LOG_LEVEL_ORDER[r.level] ?? -1) >= threshold)
}

const LEVEL_COLOR: Record<LogLevel, (text: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
}

/** One-line summary: `[level] surface ts: msg (correlationId if present)`. */
export function formatRecordLine(record: LogRecord): string {
  const color = LEVEL_COLOR[record.level] ?? ((text: string) => text)
  const corr = record.correlationId ? ` (${record.correlationId})` : ''
  return `${color(`[${record.level}]`)} ${record.surface} ${record.ts}: ${record.msg}${corr}`
}

/** Byte size of a file, or `0` when it doesn't exist / can't be stat'd. */
export function fileSizeBytes(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

/** Shared "nothing here" message for `diagnose` and `logs` (fresh install / SKILLSMITH_ERROR_LOG_DISABLE=1). */
export function noLogsFoundMessage(dir: string): string {
  return chalk.gray(
    `No logs found under ${dir}. This is expected on a fresh install, or if ` +
      `SKILLSMITH_ERROR_LOG_DISABLE is set.`
  )
}
