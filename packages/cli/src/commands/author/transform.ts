/**
 * SMI-1390: Transform Command
 *
 * Upgrade existing skills by generating subagent configurations.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { readFile, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { SkillParser } from '@skillsmith/core'

import { sanitizeError } from '../../utils/sanitize.js'
import { analyzeToolRequirements, formatToolList } from '../../utils/tool-analyzer.js'
import { printValidationResult, fileExists } from './utils.js'
import { generateSubagent } from './subagent.js'

export interface TransformOptions {
  dryRun?: boolean | undefined
  force?: boolean | undefined
  batch?: boolean | undefined
  tools?: string | undefined
  model?: string | undefined
}

/**
 * SMI-1390: Transform existing skill by generating subagent (non-destructive)
 */
export async function transformSkill(skillPath: string, options: TransformOptions): Promise<void> {
  const spinner = ora('Transforming skill...').start()

  try {
    const dirPath = resolve(skillPath || '.')

    // Check if batch mode
    if (options.batch) {
      spinner.text = 'Processing batch...'

      let skillDirs: string[] = []

      // Support comma-separated paths
      if (dirPath.includes(',')) {
        skillDirs = dirPath.split(',').map((p) => resolve(p.trim()))
      } else {
        // It's a directory, scan for subdirectories with SKILL.md
        const subdirs = await readdir(dirPath, { withFileTypes: true })

        for (const entry of subdirs) {
          if (entry.isDirectory()) {
            const skillMdPath = join(dirPath, entry.name, 'SKILL.md')
            if (await fileExists(skillMdPath)) {
              skillDirs.push(join(dirPath, entry.name))
            }
          }
        }
      }

      if (skillDirs.length === 0) {
        spinner.warn('No skills found')
        return
      }

      spinner.succeed(`Batch processing ${skillDirs.length} skills`)
      // Also output to stdout for test assertions (spinner goes to stderr)
      console.log(chalk.green(`Batch processing ${skillDirs.length} skills`))

      // Process each skill
      for (const skillDir of skillDirs) {
        console.log(chalk.dim(`\nProcessing: ${skillDir}`))
        await transformSkill(skillDir, {
          ...options,
          batch: false, // Don't recurse
        })
      }
      return
    }

    // Single skill transform
    const skillMdPath = join(dirPath, 'SKILL.md')

    if (!(await fileExists(skillMdPath))) {
      spinner.fail(`No SKILL.md found at: ${skillMdPath}`)
      throw new Error(`No SKILL.md found at: ${skillMdPath}`)
    }

    // Read and parse
    spinner.text = 'Reading SKILL.md...'
    const content = await readFile(skillMdPath, 'utf-8')

    const parser = new SkillParser({ requireName: true })
    const { validation, metadata } = parser.parseWithValidation(content)

    if (!validation.valid || !metadata) {
      spinner.fail('SKILL.md validation failed')
      printValidationResult(validation, skillMdPath)
      return
    }

    // Check if subagent already exists
    const agentsDir = join(homedir(), '.claude', 'agents')
    const subagentPath = join(agentsDir, `${metadata.name}-specialist.md`)

    if (await fileExists(subagentPath)) {
      if (!options.force) {
        spinner.warn(`Subagent already exists: ${subagentPath}`)
        console.log(chalk.yellow('  Use --force to overwrite'))
        return
      }
    }

    if (options.dryRun) {
      spinner.succeed('Dry run - would generate:')
      // Also output to stdout for test assertions (spinner goes to stderr)
      console.log(chalk.green('Dry run - would generate:'))
      console.log(chalk.dim(`  Subagent: ${subagentPath}`))
      console.log(chalk.dim(`  Skill: ${metadata.name}`))

      // Show tool analysis
      const toolAnalysis = analyzeToolRequirements(content)
      console.log(chalk.dim(`  Required Tools: ${formatToolList(toolAnalysis.requiredTools)}`))
      console.log(chalk.dim(`  Confidence: ${toolAnalysis.confidence}`))
      return
    }

    spinner.stop()

    // Generate subagent using existing function
    await generateSubagent(dirPath, {
      force: options.force,
      tools: options.tools,
      model: options.model,
      skipClaudeMd: false,
    })
  } catch (error) {
    spinner.fail(`Failed to transform skill: ${sanitizeError(error)}`)
    throw error
  }
}

/**
 * Create transform command
 */
export function createTransformCommand(): Command {
  return new Command('transform')
    .description('Upgrade existing skill with subagent configuration')
    .argument('[path]', 'Path to skill directory', '.')
    .option('--dry-run', 'Preview what would be generated')
    .option('--force', 'Overwrite existing subagent')
    .option('--batch', 'Process directory of skills')
    .option('--tools <tools>', 'Override detected tools (comma-separated)')
    .option('--model <model>', 'Model for subagent: sonnet|opus|haiku', 'sonnet')
    .action(async (skillPath: string, opts: Record<string, string | boolean | undefined>) => {
      try {
        await transformSkill(skillPath, {
          dryRun: opts['dryRun'] as boolean | undefined,
          force: opts['force'] as boolean | undefined,
          batch: opts['batch'] as boolean | undefined,
          tools: opts['tools'] as string | undefined,
          model: opts['model'] as string | undefined,
        })
      } catch (error) {
        console.error(chalk.red('Error transforming skill:'), sanitizeError(error))
        process.exit(1)
      }
    })
}
