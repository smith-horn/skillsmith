/**
 * @fileoverview `skillsmith logs` — print or tail on-disk structured log records.
 * @module @skillsmith/cli/commands/logs
 * @see SMI-5615 Wave 3 Step 1 — docs/internal/implementation/production-error-logging.md §5
 *   "DevEx consumption surface"
 *
 * `--level <level>` filters to `>=` the given level (`debug < info < warn <
 * error`, matching `packages/core/src/logging/types.ts`'s `LogLevel`).
 *
 * Without `--tail`: prints every existing matching record, chronologically
 * (oldest first — matches how a human reads a log, unlike `diagnose`'s
 * most-recent-first summary).
 *
 * `--tail`: prints today's existing matching lines, then watches today's
 * per-surface files for newly appended lines and prints them as they
 * arrive. Reuses `chokidar` — already a `@skillsmith/cli` dependency, and
 * already the file-watching mechanism used by `import-local.ts`'s
 * `--watch` mode (`grep -n "chokidar" packages/cli/src/commands/import-local.ts`)
 * — rather than inventing a new `fs.watch`-based mechanism.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'
import type { LogLevel, LogRecord, Surface } from '@skillsmith/core/logging'
import { getCliLogger } from '../cli-logger.js'
import { sanitizeError } from '../utils/sanitize.js'
import {
  filterByMinLevel,
  formatRecordLine,
  isLogLevel,
  listLogFiles,
  noLogsFoundMessage,
  readAllLogRecords,
  readLogRecords,
  resolveLogDir,
  sortByTsAsc,
} from './log-records.helpers.js'

const logger = getCliLogger()

/**
 * Every surface that can write today's per-surface log file (types.ts's
 * `Surface`). `'doc-retrieval'` (SMI-5793) is the `.husky/post-commit`
 * reindex CLI's own surface — omitting it here would silently leave
 * `sklx logs --tail` never watching its
 * `skillsmith-doc-retrieval-<date>.jsonl` file even after `Surface` itself
 * was widened in `types.ts` (`sklx logs` without `--tail` is unaffected — it
 * scans the log directory rather than enumerating surfaces).
 */
const TAIL_SURFACES: readonly Surface[] = ['cli', 'mcp', 'vscode', 'doc-retrieval']

export interface LogsCliOptions {
  tail?: boolean
  level?: string
}

function todayDateString(): string {
  // `.slice(0, 10)` (not `.split('T')[0]`) — equivalent YYYY-MM-DD extraction
  // from the fixed-format ISO string, but avoids an index-into-array read
  // that `noUncheckedIndexedAccess` (packages/cli's tsconfig, unlike core's)
  // would otherwise widen to `string | undefined`.
  return new Date().toISOString().slice(0, 10)
}

function todaysFilePaths(dir: string): string[] {
  const date = todayDateString()
  return TAIL_SURFACES.map((surface) => join(dir, `skillsmith-${surface}-${date}.jsonl`))
}

function resolveLevel(raw: string | undefined): LogLevel | undefined {
  if (raw === undefined) return undefined
  if (!isLogLevel(raw)) {
    throw new Error(`Invalid --level value: ${raw}. Expected one of: debug, info, warn, error`)
  }
  return raw
}

function printRecords(records: readonly LogRecord[]): void {
  for (const record of records) {
    console.log(formatRecordLine(record))
  }
}

// ---------------------------------------------------------------------------
// Non-tail path
// ---------------------------------------------------------------------------

function runLogsOnce(dir: string, level: LogLevel | undefined): void {
  const files = listLogFiles(dir)
  if (files.length === 0) {
    console.log(noLogsFoundMessage(dir))
    return
  }
  let records = sortByTsAsc(readAllLogRecords(dir))
  if (level) records = filterByMinLevel(records, level)
  if (records.length === 0) {
    console.log(chalk.gray('No log records match the given filters.'))
    return
  }
  printRecords(records)
}

// ---------------------------------------------------------------------------
// Tail path
// ---------------------------------------------------------------------------

export interface TailHandle {
  close: () => Promise<void>
}

/**
 * Prints today's existing matching lines for each per-surface file, then
 * watches those exact paths (chokidar) for appended content, printing new
 * complete lines as they arrive.
 *
 * Exported (not inlined into the action) so tests can start a tail, append a
 * line, await one `onRecord` callback, then `close()` deterministically
 * instead of racing a real `tail -f` against a fixed sleep.
 */
export async function startTail(
  dir: string,
  level: LogLevel | undefined,
  opts: { onRecord?: () => void } = {}
): Promise<TailHandle> {
  const paths = todaysFilePaths(dir)
  const offsets = new Map<string, number>()
  let printedAny = false

  for (const path of paths) {
    if (!existsSync(path)) {
      offsets.set(path, 0)
      continue
    }
    let records = readLogRecords(path)
    if (level) records = filterByMinLevel(records, level)
    if (records.length > 0) {
      printRecords(sortByTsAsc(records))
      printedAny = true
    }
    offsets.set(path, statSync(path).size)
  }

  if (!printedAny) {
    console.log(noLogsFoundMessage(dir))
  }

  // Lazy-loaded so the dependency cost is paid only when `--tail` is used —
  // mirrors `import-local.ts`'s `startWatchMode`.
  const chokidar = await import('chokidar')
  // `usePolling` guards against environments (some Docker storage drivers,
  // network/overlay filesystems) where native inotify/fsevents don't fire
  // reliably for paths that don't exist yet at watch-start — the common case
  // here, since a fresh install has no file for today until the first write.
  // A short interval keeps `--tail` responsive without being a busy-loop.
  const watcher = chokidar.watch(paths, {
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 100,
  })

  // Wait for chokidar's initial scan to finish attaching watches before
  // returning — otherwise a write that lands between `watch()` returning and
  // the watch actually being established can be missed (most visible in
  // tests that append immediately after `startTail` resolves).
  await new Promise<void>((resolve) => {
    watcher.once('ready', resolve)
  })

  const handleEvent = (path: string): void => {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    const previousOffset = offsets.get(path) ?? 0
    if (size <= previousOffset) {
      offsets.set(path, size)
      return
    }
    let content: string
    try {
      content = readFileSync(path).subarray(previousOffset).toString('utf8')
    } catch {
      return
    }
    offsets.set(path, size)
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let record: LogRecord
      try {
        record = JSON.parse(trimmed) as LogRecord
      } catch {
        // A partially-written line — it'll be read whole once complete, on
        // whichever subsequent 'change' event covers the rest of it.
        continue
      }
      if (!level || filterByMinLevel([record], level).length > 0) {
        console.log(formatRecordLine(record))
        opts.onRecord?.()
      }
    }
  }

  watcher.on('add', handleEvent)
  watcher.on('change', handleEvent)

  console.log(chalk.dim(`Watching ${dir} for today's log activity (Ctrl-C to stop)...`))

  return {
    close: async () => {
      await watcher.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Command action
// ---------------------------------------------------------------------------

export async function runLogs(options: LogsCliOptions): Promise<void> {
  try {
    const level = resolveLevel(options.level)
    const dir = resolveLogDir()

    if (options.tail) {
      await startTail(dir, level)
      return
    }

    runLogsOnce(dir, level)
  } catch (error) {
    logger.error(sanitizeError(error))
    process.exit(1)
  }
}

export const logsAction = withTelemetry(runLogs, {
  source: 'cli',
  extractSkillId: () => 'logs',
  extractFramework: () => 'cli',
})

/**
 * Create the `logs` command
 */
export function createLogsCommand(): Command {
  return new Command('logs')
    .description('Print or tail Skillsmith structured log records')
    .option('--tail', "Tail today's log files live, printing new records as they arrive")
    .option('--level <level>', 'Filter to records at or above this level (debug|info|warn|error)')
    .action(logsAction)
}
