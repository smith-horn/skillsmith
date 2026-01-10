/**
 * SMI-1283: CLI Analyze Command
 *
 * Analyzes a codebase to understand its structure, frameworks, and dependencies.
 * Returns context useful for skill recommendations.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { CodebaseAnalyzer, type CodebaseContext, type FrameworkInfo } from '@skillsmith/core'
import { sanitizeError } from '../utils/sanitize.js'

/**
 * Format analysis results for terminal display
 */
function formatAnalysisResults(context: CodebaseContext, analyzer: CodebaseAnalyzer): string {
  const lines: string[] = []

  lines.push('')
  lines.push(chalk.bold.blue('=== Codebase Analysis ==='))
  lines.push('')

  // Stats
  lines.push(
    `${chalk.bold('Files:')} ${context.stats.totalFiles} | ${chalk.bold('Lines:')} ${context.stats.totalLines.toLocaleString()}`
  )
  lines.push(`${chalk.bold('Duration:')} ${context.metadata.durationMs}ms`)
  lines.push('')

  // File types
  const fileTypes = Object.entries(context.stats.filesByExtension)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(', ')
  lines.push(`${chalk.bold('File types:')} ${fileTypes || 'None detected'}`)
  lines.push('')

  // Frameworks
  if (context.frameworks.length > 0) {
    lines.push(chalk.bold('Frameworks detected:'))
    for (const fw of context.frameworks.slice(0, 5)) {
      const confidence = Math.round(fw.confidence * 100)
      const color = confidence >= 80 ? chalk.green : confidence >= 50 ? chalk.yellow : chalk.gray
      lines.push(`  ${color('\u2022')} ${fw.name} (${color(`${confidence}%`)} confidence)`)
    }
    lines.push('')
  } else {
    lines.push(chalk.dim('No frameworks detected'))
    lines.push('')
  }

  // Dependencies
  const prodDeps = context.dependencies.filter((d) => !d.isDev)
  const devDeps = context.dependencies.filter((d) => d.isDev)

  if (prodDeps.length > 0) {
    lines.push(`${chalk.bold('Dependencies')} (${prodDeps.length}):`)
    lines.push(
      `  ${prodDeps
        .slice(0, 10)
        .map((d) => d.name)
        .join(', ')}`
    )
    if (prodDeps.length > 10) {
      lines.push(chalk.dim(`  ... and ${prodDeps.length - 10} more`))
    }
    lines.push('')
  }

  if (devDeps.length > 0) {
    lines.push(`${chalk.bold('Dev dependencies')} (${devDeps.length}):`)
    lines.push(
      `  ${devDeps
        .slice(0, 10)
        .map((d) => d.name)
        .join(', ')}`
    )
    if (devDeps.length > 10) {
      lines.push(chalk.dim(`  ... and ${devDeps.length - 10} more`))
    }
    lines.push('')
  }

  if (prodDeps.length === 0 && devDeps.length === 0) {
    lines.push(chalk.dim('No dependencies found (no package.json)'))
    lines.push('')
  }

  // Summary
  lines.push(chalk.dim('---'))
  const summary = analyzer.getSummary(context)
  lines.push(`${chalk.bold('Summary:')} ${summary}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * Format analysis results as JSON
 */
function formatAsJson(context: CodebaseContext): string {
  const frameworks = context.frameworks.slice(0, 10).map((f: FrameworkInfo) => ({
    name: f.name,
    confidence: Math.round(f.confidence * 100),
  }))

  const dependencies = context.dependencies.slice(0, 20).map((d) => ({
    name: d.name,
    is_dev: d.isDev,
  }))

  // Get unique import modules (external only)
  const uniqueImports = new Set<string>()
  for (const imp of context.imports) {
    // Skip relative imports
    if (!imp.module.startsWith('.') && !imp.module.startsWith('/')) {
      // Get base package name (e.g., '@scope/pkg' or 'pkg')
      const parts = imp.module.split('/')
      const firstPart = parts[0]
      const secondPart = parts[1]
      if (firstPart !== undefined) {
        const basePkg = imp.module.startsWith('@') && secondPart !== undefined
          ? `${firstPart}/${secondPart}`
          : firstPart
        uniqueImports.add(basePkg)
      }
    }
  }

  const output = {
    frameworks,
    dependencies,
    imports: Array.from(uniqueImports).slice(0, 50),
    stats: {
      total_files: context.stats.totalFiles,
      total_lines: context.stats.totalLines,
      file_types: context.stats.filesByExtension,
    },
    timing: {
      duration_ms: context.metadata.durationMs,
    },
  }

  return JSON.stringify(output, null, 2)
}

/**
 * Run codebase analysis
 */
async function runAnalyze(
  targetPath: string,
  options: {
    maxFiles: number
    excludeDirs: string[] | undefined
    includeDevDeps: boolean
    json: boolean
  }
): Promise<void> {
  const analyzer = new CodebaseAnalyzer()

  // Build analyze options - only add excludeDirs when defined (exactOptionalPropertyTypes)
  const analyzeOptions: import('@skillsmith/core').AnalyzeOptions = {
    maxFiles: options.maxFiles,
    includeDevDeps: options.includeDevDeps,
  }
  if (options.excludeDirs !== undefined) {
    analyzeOptions.excludeDirs = options.excludeDirs
  }

  const context = await analyzer.analyze(targetPath, analyzeOptions)

  if (options.json) {
    console.log(formatAsJson(context))
  } else {
    console.log(formatAnalysisResults(context, analyzer))
  }
}

/**
 * Create analyze command
 */
export function createAnalyzeCommand(): Command {
  const cmd = new Command('analyze')
    .description('Analyze a codebase to detect frameworks, dependencies, and patterns')
    .argument('[path]', 'Path to the codebase to analyze', '.')
    .option('-m, --max-files <number>', 'Maximum files to analyze', '1000')
    .option('-e, --exclude <dirs...>', 'Directories to exclude (in addition to defaults)')
    .option('--no-dev-deps', 'Exclude dev dependencies from analysis')
    .option('-j, --json', 'Output results as JSON')
    .action(async (targetPath: string, opts: Record<string, string | boolean | string[] | undefined>) => {
      try {
        const maxFiles = parseInt(opts['max-files'] as string, 10)
        const excludeDirs = opts['exclude'] as string[] | undefined
        const includeDevDeps = opts['devDeps'] !== false
        const json = (opts['json'] as boolean) === true

        await runAnalyze(targetPath, {
          maxFiles,
          excludeDirs,
          includeDevDeps,
          json,
        })
      } catch (error) {
        if (opts['json']) {
          console.error(JSON.stringify({ error: sanitizeError(error) }))
        } else {
          console.error(chalk.red('Analysis error:'), sanitizeError(error))
        }
        process.exit(1)
      }
    })

  return cmd
}

export default createAnalyzeCommand
