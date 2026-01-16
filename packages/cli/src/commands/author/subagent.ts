/**
 * SMI-1389: Subagent Generation Command
 *
 * Generate companion subagent definitions for skills.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { readFile, writeFile, stat } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { SkillParser } from '@skillsmith/core'

import { renderSubagentTemplate, renderClaudeMdSnippet } from '../../templates/index.js'
import { sanitizeError } from '../../utils/sanitize.js'
import {
  analyzeToolRequirements,
  formatToolList,
  parseToolsString,
  validateTools,
} from '../../utils/tool-analyzer.js'
import {
  printValidationResult,
  fileExists,
  ensureAgentsDirectory,
  extractTriggerPhrases,
  validateSubagentDefinition,
} from './utils.js'

export interface SubagentOptions {
  output?: string | undefined
  tools?: string | undefined
  model?: string | undefined
  skipClaudeMd?: boolean | undefined
  force?: boolean | undefined
}

/**
 * SMI-1389: Generate a companion subagent for a skill
 */
export async function generateSubagent(skillPath: string, options: SubagentOptions): Promise<void> {
  const spinner = ora('Generating subagent...').start()

  try {
    // Resolve skill path
    let dirPath = resolve(skillPath || '.')
    let skillMdPath: string

    // Check if it's a directory or file
    try {
      const stats = await stat(dirPath)
      if (stats.isDirectory()) {
        skillMdPath = join(dirPath, 'SKILL.md')
      } else {
        skillMdPath = dirPath
        dirPath = dirname(dirPath)
      }
    } catch {
      // Try adding SKILL.md
      skillMdPath = dirPath.endsWith('.md') ? dirPath : join(dirPath, 'SKILL.md')
    }

    // Read and parse SKILL.md
    spinner.text = 'Reading SKILL.md...'
    const content = await readFile(skillMdPath, 'utf-8')

    const parser = new SkillParser({ requireName: true })
    const { validation, metadata } = parser.parseWithValidation(content)

    if (!validation.valid || !metadata) {
      spinner.fail('SKILL.md validation failed')
      printValidationResult(validation, skillMdPath)
      return
    }

    // Analyze tool requirements
    spinner.text = 'Analyzing tool requirements...'
    const toolAnalysis = analyzeToolRequirements(content)

    // Override tools if specified
    let tools = toolAnalysis.requiredTools
    if (options.tools) {
      const customTools = parseToolsString(options.tools)
      const toolValidation = validateTools(customTools)
      if (!toolValidation.valid) {
        spinner.fail(`Unrecognized tools: ${toolValidation.unrecognized.join(', ')}`)
        return
      }
      tools = customTools
    }

    // Extract trigger phrases
    const triggerPhrases = extractTriggerPhrases(metadata.description || '')

    // Determine model
    const model = (options.model as 'sonnet' | 'opus' | 'haiku') || 'sonnet'
    if (!['sonnet', 'opus', 'haiku'].includes(model)) {
      spinner.fail(`Invalid model: ${model}. Must be sonnet, opus, or haiku.`)
      return
    }

    // Generate subagent content
    spinner.text = 'Generating subagent definition...'
    const subagentContent = renderSubagentTemplate({
      skillName: metadata.name,
      description: metadata.description || `Specialist for ${metadata.name}`,
      triggerPhrases,
      tools,
      model,
    })

    // Validate generated content
    const subagentValidation = validateSubagentDefinition(subagentContent)
    if (!subagentValidation.valid) {
      spinner.fail('Generated subagent is invalid')
      console.log(chalk.red('\nGeneration errors:'))
      for (const error of subagentValidation.errors) {
        console.log(chalk.red(`  - ${error}`))
      }
      return
    }

    // Ensure agents directory exists
    const agentsDir = await ensureAgentsDirectory(options.output)
    const subagentPath = join(agentsDir, `${metadata.name}-specialist.md`)

    // Check if subagent already exists
    if (await fileExists(subagentPath)) {
      if (!options.force) {
        spinner.warn(`Subagent already exists: ${subagentPath}`)
        console.log(chalk.yellow('  Use --force to overwrite'))
        return
      }
    }

    // Write subagent file
    await writeFile(subagentPath, subagentContent, 'utf-8')

    spinner.succeed(`Generated subagent: ${subagentPath}`)

    // Show tool analysis
    console.log(chalk.bold('\nTool Analysis:'))
    console.log(chalk.dim(`  Model: ${model}`))
    console.log(chalk.dim(`  Confidence: ${toolAnalysis.confidence}`))
    console.log(chalk.dim(`  Tools: ${formatToolList(tools)}`))
    if (toolAnalysis.detectedPatterns.length > 0) {
      console.log(chalk.dim('  Detected patterns:'))
      for (const pattern of toolAnalysis.detectedPatterns.slice(0, 5)) {
        console.log(chalk.dim(`    - ${pattern}`))
      }
    }

    // Generate and display CLAUDE.md snippet
    if (!options.skipClaudeMd) {
      const snippet = renderClaudeMdSnippet({
        skillName: metadata.name,
        description: metadata.description || '',
        triggerPhrases,
        tools,
        model,
      })

      console.log(chalk.bold('\nCLAUDE.md Integration Snippet:'))
      console.log(chalk.cyan('─'.repeat(50)))
      console.log(snippet)
      console.log(chalk.cyan('─'.repeat(50)))
      console.log(chalk.dim('\nAdd this snippet to your project CLAUDE.md to enable delegation.'))
    }

    console.log()
  } catch (error) {
    spinner.fail(`Failed to generate subagent: ${sanitizeError(error)}`)
    throw error
  }
}

/**
 * Create subagent command
 */
export function createSubagentCommand(): Command {
  return new Command('subagent')
    .description('Generate a companion subagent for a skill')
    .argument('[path]', 'Path to skill directory', '.')
    .option('-o, --output <path>', 'Output directory', '~/.claude/agents')
    .option('--tools <tools>', 'Override detected tools (comma-separated)')
    .option('--model <model>', 'Model for subagent: sonnet|opus|haiku', 'sonnet')
    .option('--skip-claude-md', 'Skip CLAUDE.md snippet generation')
    .option('--force', 'Overwrite existing subagent definition')
    .action(async (skillPath: string, opts: Record<string, string | boolean | undefined>) => {
      try {
        await generateSubagent(skillPath, {
          output: opts['output'] as string | undefined,
          tools: opts['tools'] as string | undefined,
          model: opts['model'] as string | undefined,
          skipClaudeMd: opts['skipClaudeMd'] as boolean | undefined,
          force: opts['force'] as boolean | undefined,
        })
      } catch (error) {
        console.error(chalk.red('Error generating subagent:'), sanitizeError(error))
        process.exit(1)
      }
    })
}
