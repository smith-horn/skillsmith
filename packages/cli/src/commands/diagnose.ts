/**
 * @fileoverview `skillsmith diagnose` — diagnostic snapshot for support/self-service debugging.
 * @module @skillsmith/cli/commands/diagnose
 * @see SMI-5615 Wave 3 Step 1 — docs/internal/implementation/production-error-logging.md §5
 *   "DevEx consumption surface"
 *
 * Prints:
 *   - Environment summary: CLI version, Node version, platform, whether
 *     SKILLSMITH_ERROR_LOG_DISABLE / SKILLSMITH_LOG_LEVEL are set (and to what).
 *   - Log file locations under the resolved log directory (see
 *     `log-records.helpers.ts`'s `resolveLogDir`).
 *   - The last `--limit` (default 20) redacted log records across every
 *     surface file, sorted by timestamp descending.
 *
 * `--bundle [path]` packages the log files + environment summary for a
 * support handoff. Bundling mechanism: plain-text concatenation (`.txt`),
 * NOT a `.tar.gz`. Checked before implementing: `grep -n '"tar"' package.json`
 * shows `tar` only under the root `overrides` block (a transitive-version
 * security pin, e.g. for `npm`'s own bundled tar usage) — it is not declared
 * as a `dependency` of `@skillsmith/cli` or any other workspace package. No
 * `archiver`/`tar-stream`/`adm-zip`/similar package is declared anywhere in
 * the monorepo either. Importing the overrides-only `tar` package from CLI
 * source would be an undeclared ("phantom") dependency working only by
 * hoisting accident — exactly the kind of new dependency the spec says not
 * to add for this alone. Plain-text concatenation is used instead.
 *
 * Records read from disk are already redacted (SMI-883, Wave 1/2 guarantee)
 * — this command only parses and prints/bundles them verbatim; it never
 * re-processes raw error content.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { checkCursorMcpArtifact, type CursorMcpArtifactCheck } from '@skillsmith/core'
import { AGENT_MCP_TARGETS } from '@skillsmith/core/install'
import { getCliLogger } from '../cli-logger.js'
import { sanitizeError } from '../utils/sanitize.js'
import { VERSION } from '../version.js'
import {
  fileSizeBytes,
  formatRecordLine,
  listLogFiles,
  noLogsFoundMessage,
  readAllLogRecords,
  resolveLogDir,
  sortByTsDesc,
} from './log-records.helpers.js'

const logger = getCliLogger()

const DEFAULT_LIMIT = 20

export interface DiagnoseCliOptions {
  limit?: string
  bundle?: string | boolean
}

interface EnvSummary {
  cliVersion: string
  nodeVersion: string
  platform: string
  arch: string
  errorLogDisable: string
  logLevel: string
  logDir: string
}

function buildEnvSummary(logDir: string): EnvSummary {
  return {
    cliVersion: VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    errorLogDisable: process.env['SKILLSMITH_ERROR_LOG_DISABLE'] ?? '(unset)',
    logLevel: process.env['SKILLSMITH_LOG_LEVEL'] ?? '(unset — default: warn)',
    logDir,
  }
}

function formatEnvSummaryPlain(summary: EnvSummary): string {
  return [
    `CLI version: ${summary.cliVersion}`,
    `Node version: ${summary.nodeVersion}`,
    `Platform: ${summary.platform} (${summary.arch})`,
    `SKILLSMITH_ERROR_LOG_DISABLE: ${summary.errorLogDisable}`,
    `SKILLSMITH_LOG_LEVEL: ${summary.logLevel}`,
    `Log directory: ${summary.logDir}`,
  ].join('\n')
}

function printEnvSummary(summary: EnvSummary): void {
  console.log(chalk.bold('Environment'))
  console.log(formatEnvSummaryPlain(summary))
  console.log('')
}

/**
 * Both locations Cursor reads MCP config from — global (`~/.cursor/mcp.json`)
 * and project-scoped (`<cwd>/.cursor/mcp.json`). The GH#2368 V3 repro's
 * actual broken config was project-scoped, and nothing before SMI-6279
 * Wave 9 even looked there — checked independently, since a healthy global
 * config says nothing about a stale project-scoped override shadowing it
 * (Cursor merges both, project-scoped taking precedence).
 */
function cursorMcpArtifactPaths(): string[] {
  return [AGENT_MCP_TARGETS.cursor.path, resolve(process.cwd(), '.cursor', 'mcp.json')]
}

function buildCursorMcpChecks(): CursorMcpArtifactCheck[] {
  return cursorMcpArtifactPaths().map((path) => checkCursorMcpArtifact(path))
}

function formatCursorMcpCheckLine(check: CursorMcpArtifactCheck): string {
  if (!check.exists) return `  ${check.path}: (not found)`
  if (!check.entryFound) return `  ${check.path}: exists, no Skillsmith MCP entry`
  if (!check.stale) return `  ${check.path}: OK`

  const reasons: string[] = []
  if (check.usesNpxForm) reasons.push("uses the broken 'npx' command form (GH#2368 C-01)")
  if (!check.hasClientEnv) reasons.push('missing SKILLSMITH_CLIENT=cursor')
  return `  ${check.path}: STALE — ${reasons.join('; ')}. Run \`${check.remediation}\` to fix.`
}

function printCursorMcpChecks(checks: CursorMcpArtifactCheck[]): void {
  console.log(chalk.bold('Cursor MCP registration'))
  for (const check of checks) {
    const line = formatCursorMcpCheckLine(check)
    console.log(check.stale ? chalk.yellow(line) : line)
  }
  console.log('')
}

function parseLimit(raw: string | undefined): number {
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT
}

/** Default bundle path when `--bundle` is passed without an explicit value. */
function defaultBundlePath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `./skillsmith-diagnose-${stamp}.txt`
}

function buildBundleContent(summary: EnvSummary, files: string[]): string {
  const parts: string[] = [
    'Skillsmith Diagnostic Bundle',
    `Generated: ${new Date().toISOString()}`,
    '',
    '--- Environment ---',
    formatEnvSummaryPlain(summary),
    '',
    '--- Log Files ---',
  ]
  if (files.length === 0) {
    parts.push('(no log files found)')
  } else {
    for (const file of files) {
      parts.push('')
      parts.push(`===== ${basename(file)} (${fileSizeBytes(file)} bytes) =====`)
      try {
        parts.push(readFileSync(file, 'utf8'))
      } catch (error) {
        parts.push(`[failed to read: ${sanitizeError(error)}]`)
      }
    }
  }
  return parts.join('\n')
}

/** Resolves the target path, writes the bundle, and returns the absolute path written. */
function writeBundle(bundleOption: string | boolean, summary: EnvSummary, files: string[]): string {
  const rawPath =
    typeof bundleOption === 'string' && bundleOption.length > 0 ? bundleOption : defaultBundlePath()
  const targetPath = resolve(rawPath)
  const content = buildBundleContent(summary, files)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, content, 'utf8')
  return targetPath
}

export async function runDiagnose(options: DiagnoseCliOptions): Promise<void> {
  try {
    const logDir = resolveLogDir()
    const summary = buildEnvSummary(logDir)
    printEnvSummary(summary)
    printCursorMcpChecks(buildCursorMcpChecks())

    const files = listLogFiles(logDir)

    if (files.length === 0) {
      console.log(noLogsFoundMessage(logDir))
      if (options.bundle !== undefined) {
        const target = writeBundle(options.bundle, summary, files)
        console.log('')
        console.log(chalk.green(`Diagnostic bundle written to ${target}`))
      }
      return
    }

    console.log(chalk.bold('Log files'))
    for (const file of files) {
      console.log(`  ${file} (${fileSizeBytes(file)} bytes)`)
    }
    console.log('')

    const limit = parseLimit(options.limit)
    const records = sortByTsDesc(readAllLogRecords(logDir)).slice(0, limit)

    console.log(chalk.bold(`Recent log records (last ${records.length})`))
    if (records.length === 0) {
      console.log(chalk.gray('  (log files exist but contain no parsable records)'))
    } else {
      for (const record of records) {
        console.log(formatRecordLine(record))
      }
    }

    if (options.bundle !== undefined) {
      const target = writeBundle(options.bundle, summary, files)
      console.log('')
      console.log(chalk.green(`Diagnostic bundle written to ${target}`))
    }
  } catch (error) {
    logger.error(sanitizeError(error))
    process.exit(1)
  }
}

export const diagnoseAction = withTelemetry(runDiagnose, {
  source: 'cli',
  extractSkillId: () => 'diagnose',
  extractFramework: () => 'cli',
})

/**
 * Create the `diagnose` command
 */
export function createDiagnoseCommand(): Command {
  return new Command('diagnose')
    .description(
      'Print a diagnostic snapshot (environment, log file locations, recent errors) for support/self-service debugging'
    )
    .option('-l, --limit <n>', 'Number of recent log records to show', String(DEFAULT_LIMIT))
    .option(
      '--bundle [path]',
      'Write a diagnostic bundle for support (default: ./skillsmith-diagnose-<timestamp>.txt)'
    )
    .action(diagnoseAction)
}
