/**
 * @fileoverview `skillsmith import-local` — walk a directory tree of `SKILL.md`
 * files and upsert them into the local skills DB with `source='local'` so
 * subsequent registry sync (with or without `--force`) leaves them alone.
 *
 * @see SMI-4665
 */
import { Command } from 'commander'
import {
  createDatabaseAsync,
  initializeSchema,
  SkillRepository,
  type SkillCreateInput,
} from '@skillsmith/core'
import {
  getCanonicalInstallPath,
  getInstallPath,
  resolveClientId,
  type ClientId,
} from '@skillsmith/core/install'
import { resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { DEFAULT_DB_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'
import { walkSkillFiles, parseSkillFile, localSkillId } from './import-local.helpers.js'
import type {
  ImportLocalOptions,
  ImportLocalResult,
  LocalSkillRecord,
} from './import-local.types.js'

const WATCH_DEBOUNCE_MS = 500

/**
 * Resolve the directory the importer should walk. Precedence:
 *   1. Positional `[path]`
 *   2. `--client <id>` → multi-client install path
 *   3. Canonical `~/.claude/skills/`
 */
function resolveRoot(opts: ImportLocalOptions): string {
  if (opts.path) return resolve(opts.path)
  if (opts.client) return getInstallPath(opts.client)
  return getCanonicalInstallPath()
}

/**
 * Run a single pass of the importer. Returns the summary; never throws on
 * per-file errors (those land in `result.errors`).
 */
export async function runImportLocal(opts: ImportLocalOptions): Promise<ImportLocalResult> {
  const start = Date.now()
  const rootDir = resolveRoot(opts)
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH

  const result: ImportLocalResult = {
    rootDir,
    scanned: 0,
    imported: 0,
    updated: 0,
    unchanged: 0,
    errors: [],
    skipped: [],
    durationMs: 0,
    dryRun: !!opts.dryRun,
  }

  // Preflight: rootDir must exist. Surface as a single error rather than
  // letting the walker silently return zero files.
  try {
    const stat = await fs.stat(rootDir)
    if (!stat.isDirectory()) {
      result.errors.push({ path: rootDir, message: 'not-a-directory' })
      result.durationMs = Date.now() - start
      return result
    }
  } catch (error) {
    result.errors.push({
      path: rootDir,
      message: `stat-failed: ${error instanceof Error ? error.message : String(error)}`,
    })
    result.durationMs = Date.now() - start
    return result
  }

  const { files, skipped } = await walkSkillFiles(rootDir)
  result.scanned = files.length
  result.skipped = skipped

  const records: LocalSkillRecord[] = []
  for (const file of files) {
    const record = await parseSkillFile(file)
    if (record.error) {
      result.errors.push({ path: record.path, message: record.error })
    }
    records.push(record)
  }

  if (opts.dryRun) {
    // Tally without writing.
    const db = await createDatabaseAsync(dbPath)
    initializeSchema(db)
    try {
      const repo = new SkillRepository(db)
      for (const record of records) {
        if (record.error) continue
        const existing = repo.findById(record.id)
        if (existing) {
          // A re-import of the same path always updates (id is path-derived).
          // Counted separately from `imported` so the summary distinguishes
          // first-time imports from idempotent re-runs.
          result.updated++
        } else {
          result.imported++
        }
      }
    } finally {
      db.close()
    }
    result.durationMs = Date.now() - start
    return result
  }

  // Real import.
  const db = await createDatabaseAsync(dbPath)
  initializeSchema(db)
  try {
    const repo = new SkillRepository(db)
    for (const record of records) {
      if (record.error) continue
      const input: SkillCreateInput = {
        id: record.id,
        name: record.name,
        description: record.description,
        author: null,
        repoUrl: null,
        qualityScore: null,
        trustTier: 'local',
        source: 'local',
        tags: record.tags,
      }
      const existing = repo.findById(record.id)
      if (existing) {
        repo.update(record.id, input)
        result.updated++
      } else {
        repo.create(input)
        result.imported++
      }
    }
    result.unchanged = result.scanned - result.imported - result.updated - result.errors.length
    if (result.unchanged < 0) result.unchanged = 0
  } finally {
    db.close()
  }

  result.durationMs = Date.now() - start
  return result
}

/**
 * Watch mode: chokidar-based debounced re-import. Lazy-loaded so the
 * dependency cost is paid only when `--watch` is used.
 */
async function startWatchMode(opts: ImportLocalOptions, jsonOutput: boolean): Promise<void> {
  // chokidar 4.x exposes `watch` as a named export. Lazy-loaded so the
  // dependency cost is paid only when `--watch` is used.
  const chokidar = await import('chokidar')
  const rootDir = resolveRoot(opts)
  let pending: NodeJS.Timeout | null = null
  let inFlight = false

  const trigger = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      const result = await runImportLocal(opts)
      if (jsonOutput) {
        console.log(JSON.stringify(result))
      } else {
        console.log(
          `[import-local] ${result.scanned} scanned, ${result.imported} added, ${result.updated} updated, ${result.errors.length} errors`
        )
      }
    } catch (error) {
      console.error('[import-local] watch pass failed:', sanitizeError(error))
    } finally {
      inFlight = false
    }
  }

  await trigger()

  const watcher = chokidar.watch(`${rootDir}/**/SKILL.md`, {
    ignoreInitial: true,
    persistent: true,
  })

  const onEvent = (_event: string, _path: string): void => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      void trigger()
    }, WATCH_DEBOUNCE_MS)
  }

  watcher.on('add', (p) => onEvent('add', p))
  watcher.on('change', (p) => onEvent('change', p))
  watcher.on('unlink', (p) => onEvent('unlink', p))
  console.log(`[import-local] watching ${rootDir} (Ctrl-C to stop)`)
}

/**
 * Build the Commander subcommand. Wired into `index.ts` via `addCommand`.
 */
export function createImportLocalCommand(): Command {
  return new Command('import-local')
    .description(
      'Walk a directory of SKILL.md files and import them into the local skills DB. ' +
        "Imported rows are tagged source='local' so registry sync (including --force) " +
        'leaves them alone.'
    )
    .argument('[path]', 'Directory to walk (default: ~/.claude/skills/)')
    .option(
      '--client <id>',
      'Walk a different client install path (claude-code, cursor, copilot, windsurf, agents)'
    )
    .option('--watch', 'Watch the directory and re-import on change (debounced 500ms)')
    .option('--dry-run', 'List what would be imported without writing to the DB')
    .option('--json', 'Emit a single machine-readable summary object on stdout')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .action(
      async (
        path: string | undefined,
        cliOptions: {
          client?: string
          watch?: boolean
          dryRun?: boolean
          json?: boolean
          db?: string
        }
      ) => {
        try {
          let resolvedClient: ClientId | undefined
          if (cliOptions.client !== undefined) {
            resolvedClient = resolveClientId(cliOptions.client)
          }

          const opts: ImportLocalOptions = {
            ...(path !== undefined && { path }),
            ...(resolvedClient !== undefined && { client: resolvedClient }),
            ...(cliOptions.watch !== undefined && { watch: cliOptions.watch }),
            ...(cliOptions.dryRun !== undefined && { dryRun: cliOptions.dryRun }),
            ...(cliOptions.json !== undefined && { json: cliOptions.json }),
            ...(cliOptions.db !== undefined && { dbPath: cliOptions.db }),
          }

          if (opts.watch) {
            await startWatchMode(opts, !!opts.json)
            return
          }

          const result = await runImportLocal(opts)
          if (opts.json) {
            console.log(JSON.stringify(result))
          } else {
            printHumanSummary(result)
          }
          if (result.errors.length > 0 && opts.json) {
            process.exit(1)
          }
        } catch (error) {
          console.error('import-local failed:', sanitizeError(error))
          process.exit(1)
        }
      }
    )
}

function printHumanSummary(result: ImportLocalResult): void {
  console.log(`\n--- import-local ${result.dryRun ? '(dry run)' : ''} ---`)
  console.log(`Root:     ${result.rootDir}`)
  console.log(`Scanned:  ${result.scanned}`)
  console.log(`Imported: ${result.imported}`)
  console.log(`Updated:  ${result.updated}`)
  console.log(`Unchanged:${result.unchanged}`)
  if (result.skipped.length > 0) {
    console.log(`Skipped:  ${result.skipped.length}`)
    for (const s of result.skipped) {
      console.log(`  - ${s.path} (${s.reason})`)
    }
  }
  if (result.errors.length > 0) {
    console.log(`Errors:   ${result.errors.length}`)
    for (const e of result.errors) {
      console.log(`  - ${e.path}: ${e.message}`)
    }
  }
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`)
}

// Re-export helpers for unit tests.
export { walkSkillFiles, parseSkillFile, localSkillId }
