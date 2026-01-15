/**
 * SMI-746: Skill Authoring Commands
 *
 * Provides CLI commands for creating, validating, and publishing skills.
 */

import { Command } from 'commander'
import { input, confirm, select } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir, writeFile, readFile, stat } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { createHash } from 'crypto'
import { SkillParser, type ValidationResult } from '@skillsmith/core'

import {
  SKILL_MD_TEMPLATE,
  README_MD_TEMPLATE,
  renderSubagentTemplate,
  renderClaudeMdSnippet,
  renderMcpServerTemplates,
  type McpToolDefinition,
} from '../templates/index.js'
import { sanitizeError } from '../utils/sanitize.js'
import {
  analyzeToolRequirements,
  formatToolList,
  parseToolsString,
  validateTools,
} from '../utils/tool-analyzer.js'
import { homedir } from 'os'
import { access } from 'fs/promises'

/**
 * Initialize a new skill directory
 */
async function initSkill(name: string | undefined, targetPath: string): Promise<void> {
  // Interactive prompts if name not provided
  const skillName =
    name ||
    (await input({
      message: 'Skill name:',
      validate: (value: string) => {
        if (!value.trim()) return 'Name is required'
        if (!/^[a-zA-Z][a-zA-Z0-9-_]*$/.test(value)) {
          return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
        }
        return true
      },
    }))

  const description = await input({
    message: 'Description:',
    default: `A Claude skill for ${skillName}`,
  })

  const author = await input({
    message: 'Author:',
    default: process.env['USER'] || 'author',
  })

  const category = await select({
    message: 'Category:',
    choices: [
      { name: 'Development', value: 'development' },
      { name: 'Productivity', value: 'productivity' },
      { name: 'Communication', value: 'communication' },
      { name: 'Data', value: 'data' },
      { name: 'Security', value: 'security' },
      { name: 'Other', value: 'other' },
    ],
  })

  const skillDir = resolve(targetPath, skillName)

  // Check if directory already exists
  try {
    await stat(skillDir)
    const overwrite = await confirm({
      message: `Directory ${skillDir} already exists. Overwrite?`,
      default: false,
    })
    if (!overwrite) {
      console.log(chalk.yellow('Initialization cancelled'))
      return
    }
  } catch {
    // Directory doesn't exist, continue
  }

  const spinner = ora('Creating skill structure...').start()

  try {
    // Create directory structure
    await mkdir(skillDir, { recursive: true })
    await mkdir(join(skillDir, 'scripts'), { recursive: true })
    await mkdir(join(skillDir, 'resources'), { recursive: true })

    // Generate SKILL.md from template
    const skillMdContent = SKILL_MD_TEMPLATE.replace(/\{\{name\}\}/g, skillName)
      .replace(/\{\{description\}\}/g, description)
      .replace(/\{\{author\}\}/g, author)
      .replace(/\{\{category\}\}/g, category)
      .replace(/\{\{date\}\}/g, new Date().toISOString().split('T')[0] || '')

    await writeFile(join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8')

    // Generate README.md from template
    const readmeContent = README_MD_TEMPLATE.replace(/\{\{name\}\}/g, skillName).replace(
      /\{\{description\}\}/g,
      description
    )

    await writeFile(join(skillDir, 'README.md'), readmeContent, 'utf-8')

    // Create placeholder script
    const placeholderScript = `#!/usr/bin/env node
/**
 * ${skillName} - Example Script
 *
 * Add your skill's automation scripts here.
 */

console.log('${skillName} script executed');
`
    await writeFile(join(skillDir, 'scripts', 'example.js'), placeholderScript, 'utf-8')

    // Create .gitignore
    const gitignore = `# Dependencies
node_modules/

# Build output
dist/

# Environment
.env
.env.local

# OS files
.DS_Store
Thumbs.db
`
    await writeFile(join(skillDir, '.gitignore'), gitignore, 'utf-8')

    spinner.succeed(`Created skill at ${skillDir}`)

    console.log(chalk.bold('\nNext steps:'))
    console.log(chalk.dim(`  1. cd ${skillDir}`))
    console.log(chalk.dim('  2. Edit SKILL.md to customize your skill'))
    console.log(chalk.dim('  3. Add scripts to the scripts/ directory'))
    console.log(chalk.dim('  4. Run skillsmith validate to check your skill'))
    console.log(chalk.dim('  5. Run skillsmith publish to prepare for sharing'))
    console.log()
  } catch (error) {
    spinner.fail(`Failed to create skill: ${sanitizeError(error)}`)
    throw error
  }
}

/**
 * Pretty print validation errors and warnings
 */
function printValidationResult(result: ValidationResult, filePath: string): void {
  console.log(chalk.bold(`\nValidation Result for ${filePath}:\n`))

  if (result.valid) {
    console.log(chalk.green.bold('  VALID'))
  } else {
    console.log(chalk.red.bold('  INVALID'))
  }

  if (result.errors.length > 0) {
    console.log(chalk.red.bold('\nErrors:'))
    for (const error of result.errors) {
      console.log(chalk.red(`  - ${error}`))
    }
  }

  if (result.warnings.length > 0) {
    console.log(chalk.yellow.bold('\nWarnings:'))
    for (const warning of result.warnings) {
      console.log(chalk.yellow(`  - ${warning}`))
    }
  }

  console.log()
}

/**
 * Validate a local SKILL.md file
 */
async function validateSkill(skillPath: string): Promise<boolean> {
  const spinner = ora('Validating skill...').start()

  try {
    // Resolve path
    let filePath = resolve(skillPath)

    // Check if it's a directory, look for SKILL.md
    try {
      const stats = await stat(filePath)
      if (stats.isDirectory()) {
        filePath = join(filePath, 'SKILL.md')
      }
    } catch {
      // If path doesn't exist, try adding SKILL.md
      if (!filePath.endsWith('.md')) {
        filePath = join(filePath, 'SKILL.md')
      }
    }

    // Read file
    const content = await readFile(filePath, 'utf-8')

    // Parse and validate
    const parser = new SkillParser({ requireName: true })
    const { validation, metadata, frontmatter } = parser.parseWithValidation(content)

    spinner.stop()

    printValidationResult(validation, filePath)

    if (metadata) {
      console.log(chalk.bold('Parsed Metadata:'))
      console.log(chalk.dim(`  Name: ${metadata.name}`))
      console.log(chalk.dim(`  Description: ${metadata.description || 'N/A'}`))
      console.log(chalk.dim(`  Author: ${metadata.author || 'N/A'}`))
      console.log(chalk.dim(`  Version: ${metadata.version || 'N/A'}`))
      console.log(chalk.dim(`  Tags: ${metadata.tags.join(', ') || 'None'}`))
      console.log(chalk.dim(`  Trust Tier: ${parser.inferTrustTier(metadata)}`))
      console.log()
    }

    if (frontmatter) {
      console.log(chalk.bold('Frontmatter Fields:'))
      for (const [key, value] of Object.entries(frontmatter)) {
        if (value !== undefined && value !== null) {
          const displayValue = Array.isArray(value) ? value.join(', ') : String(value)
          console.log(chalk.dim(`  ${key}: ${displayValue}`))
        }
      }
      console.log()
    }

    return validation.valid
  } catch (error) {
    spinner.fail(`Validation failed: ${sanitizeError(error)}`)
    return false
  }
}

/**
 * Prepare skill for publishing
 * @returns true if publishing succeeded, false if validation failed
 */
async function publishSkill(skillPath: string): Promise<boolean> {
  const spinner = ora('Preparing skill for publishing...').start()

  try {
    // Resolve path
    let dirPath = resolve(skillPath || '.')

    // Check if it's a file, get directory
    try {
      const stats = await stat(dirPath)
      if (!stats.isDirectory()) {
        dirPath = dirname(dirPath)
      }
    } catch {
      // Path doesn't exist
      spinner.fail(`Directory not found: ${dirPath}`)
      return false
    }

    const skillMdPath = join(dirPath, 'SKILL.md')

    // Validate first
    spinner.text = 'Validating skill...'

    const content = await readFile(skillMdPath, 'utf-8')
    const parser = new SkillParser({ requireName: true })
    const { validation, metadata } = parser.parseWithValidation(content)

    if (!validation.valid) {
      spinner.fail('Skill validation failed')
      printValidationResult(validation, skillMdPath)
      return false
    }

    if (!metadata) {
      spinner.fail('Could not parse skill metadata')
      return false
    }

    // Generate checksum
    spinner.text = 'Generating checksum...'
    const checksum = createHash('sha256').update(content).digest('hex')

    // Create publish info
    const publishInfo = {
      name: metadata.name,
      version: metadata.version || '1.0.0',
      checksum,
      publishedAt: new Date().toISOString(),
      trustTier: parser.inferTrustTier(metadata),
    }

    // Write publish manifest
    const manifestPath = join(dirPath, '.skillsmith-publish.json')
    await writeFile(manifestPath, JSON.stringify(publishInfo, null, 2), 'utf-8')

    spinner.succeed('Skill prepared for publishing')

    console.log(chalk.bold('\nPublish Information:'))
    console.log(chalk.dim(`  Name: ${publishInfo.name}`))
    console.log(chalk.dim(`  Version: ${publishInfo.version}`))
    console.log(chalk.dim(`  Checksum: ${publishInfo.checksum.slice(0, 16)}...`))
    console.log(chalk.dim(`  Trust Tier: ${publishInfo.trustTier}`))
    console.log()

    console.log(chalk.bold('To share this skill:'))
    console.log(chalk.cyan('\n  Option 1: GitHub'))
    console.log(chalk.dim('  1. Push to a GitHub repository'))
    console.log(chalk.dim('  2. Add topic "claude-skill" to the repository'))
    console.log(chalk.dim('  3. The skill will be automatically discovered'))

    console.log(chalk.cyan('\n  Option 2: Manual Installation'))
    console.log(chalk.dim(`  1. Share the ${dirPath} directory`))
    console.log(chalk.dim('  2. Users can copy to ~/.claude/skills/'))

    console.log(chalk.cyan('\n  Option 3: Archive'))
    console.log(chalk.dim(`  1. Create archive: tar -czf ${metadata.name}.tar.gz ${dirPath}`))
    console.log(chalk.dim('  2. Share the archive'))
    console.log()

    return true
  } catch (error) {
    spinner.fail(`Publishing failed: ${sanitizeError(error)}`)
    return false
  }
}

/**
 * Create init command
 */
export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize a new skill directory')
    .argument('[name]', 'Skill name')
    .option('-p, --path <path>', 'Target directory', '.')
    .action(async (name: string | undefined, opts: Record<string, string | undefined>) => {
      const targetPath = opts['path'] || '.'

      try {
        await initSkill(name, targetPath)
      } catch (error) {
        console.error(chalk.red('Error initializing skill:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

/**
 * Create validate command
 */
export function createValidateCommand(): Command {
  return new Command('validate')
    .description('Validate a local SKILL.md file')
    .argument('[path]', 'Path to SKILL.md or skill directory', '.')
    .action(async (skillPath: string) => {
      try {
        const valid = await validateSkill(skillPath)
        process.exit(valid ? 0 : 1)
      } catch (error) {
        console.error(chalk.red('Error validating skill:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

/**
 * Create publish command
 */
export function createPublishCommand(): Command {
  return new Command('publish')
    .description('Prepare skill for sharing')
    .argument('[path]', 'Path to skill directory', '.')
    .action(async (skillPath: string) => {
      try {
        const success = await publishSkill(skillPath)
        process.exit(success ? 0 : 1)
      } catch (error) {
        console.error(chalk.red('Error publishing skill:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

/**
 * SMI-1389: Extract trigger phrases from skill description
 */
function extractTriggerPhrases(description: string): string[] {
  const phrases: string[] = []

  // Pattern: "Use when [phrases]" or "when the user asks to [phrases]"
  const patterns = [
    /use when (?:the user asks to )?["']([^"']+)["']/gi,
    /when (?:the user asks to )?["']([^"']+)["']/gi,
    /trigger(?:ed)? (?:by|when|phrases?)[\s:]+["']([^"']+)["']/gi,
    /invoke when (?:the user )?["']([^"']+)["']/gi,
  ]

  for (const pattern of patterns) {
    const matches = description.matchAll(pattern)
    for (const match of matches) {
      if (match[1]) {
        phrases.push(match[1])
      }
    }
  }

  return phrases
}

/**
 * SMI-1389: Validate subagent definition structure
 */
function validateSubagentDefinition(content: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Check for YAML frontmatter
  if (!content.trim().startsWith('---')) {
    errors.push('Missing YAML frontmatter')
  }

  // Extract and validate frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1] || ''

    const requiredFields = ['name', 'description', 'skills', 'tools', 'model']
    for (const field of requiredFields) {
      if (!frontmatter.includes(`${field}:`)) {
        errors.push(`Missing required field: ${field}`)
      }
    }
  } else {
    errors.push('Could not parse YAML frontmatter')
  }

  // Check for operating protocol section
  if (!content.includes('## Operating Protocol')) {
    warnings.push('Missing Operating Protocol section')
  }

  // Check for output format section
  if (!content.includes('## Output Format')) {
    warnings.push('Missing Output Format section')
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Ensure ~/.claude/agents directory exists
 */
async function ensureAgentsDirectory(customPath?: string): Promise<string> {
  const agentsDir = customPath
    ? resolve(customPath.replace(/^~/, homedir()))
    : join(homedir(), '.claude', 'agents')

  await mkdir(agentsDir, { recursive: true })
  return agentsDir
}

/**
 * Check if file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

interface SubagentOptions {
  output?: string | undefined
  tools?: string | undefined
  model?: string | undefined
  skipClaudeMd?: boolean | undefined
  force?: boolean | undefined
}

/**
 * SMI-1389: Generate a companion subagent for a skill
 */
async function generateSubagent(skillPath: string, options: SubagentOptions): Promise<void> {
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
      const validation = validateTools(customTools)
      if (!validation.valid) {
        spinner.fail(`Unrecognized tools: ${validation.unrecognized.join(', ')}`)
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

interface TransformOptions {
  dryRun?: boolean | undefined
  force?: boolean | undefined
  batch?: boolean | undefined
  tools?: string | undefined
  model?: string | undefined
}

/**
 * SMI-1390: Transform existing skill by generating subagent (non-destructive)
 */
async function transformSkill(skillPath: string, options: TransformOptions): Promise<void> {
  const spinner = ora('Transforming skill...').start()

  try {
    const dirPath = resolve(skillPath || '.')

    // Check if batch mode
    if (options.batch) {
      spinner.text = 'Scanning for skills...'
      const entries = await readFile(dirPath, 'utf-8').catch(() => null)

      if (entries === null) {
        // It's a directory, scan for subdirectories with SKILL.md
        const { readdir } = await import('fs/promises')
        const subdirs = await readdir(dirPath, { withFileTypes: true })

        const skillDirs: string[] = []
        for (const entry of subdirs) {
          if (entry.isDirectory()) {
            const skillMdPath = join(dirPath, entry.name, 'SKILL.md')
            if (await fileExists(skillMdPath)) {
              skillDirs.push(join(dirPath, entry.name))
            }
          }
        }

        if (skillDirs.length === 0) {
          spinner.warn('No skills found in directory')
          return
        }

        spinner.succeed(`Found ${skillDirs.length} skills`)

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
    }

    // Single skill transform
    const skillMdPath = join(dirPath, 'SKILL.md')

    if (!(await fileExists(skillMdPath))) {
      spinner.fail(`No SKILL.md found at: ${skillMdPath}`)
      return
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
      console.log(chalk.dim(`  Subagent: ${subagentPath}`))

      // Show tool analysis
      const toolAnalysis = analyzeToolRequirements(content)
      console.log(chalk.dim(`  Tools: ${formatToolList(toolAnalysis.requiredTools)}`))
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

interface McpInitOptions {
  output?: string | undefined
  tools?: string | undefined
  force?: boolean | undefined
}

/**
 * SMI-1433: Initialize a new MCP server project
 */
async function initMcpServer(name: string | undefined, options: McpInitOptions): Promise<void> {
  // Interactive prompts if name not provided
  const serverName =
    name ||
    (await input({
      message: 'MCP server name:',
      validate: (value: string) => {
        if (!value.trim()) return 'Name is required'
        if (!/^[a-z][a-z0-9-]*$/.test(value)) {
          return 'Name must be lowercase, start with a letter, and contain only letters, numbers, and hyphens'
        }
        return true
      },
    }))

  const description = await input({
    message: 'Description:',
    default: `An MCP server for ${serverName}`,
  })

  const author = await input({
    message: 'Author:',
    default: process.env['USER'] || 'author',
  })

  // Parse initial tools if provided
  const initialTools: McpToolDefinition[] = []
  const toolNameRegex = /^[a-z][a-z0-9_-]*$/

  if (options.tools) {
    const toolNames = options.tools
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    for (const toolName of toolNames) {
      if (!toolNameRegex.test(toolName)) {
        console.log(
          chalk.red(
            `Invalid tool name: ${toolName}. Must be lowercase, start with a letter, and contain only letters, numbers, underscores, and hyphens.`
          )
        )
        return
      }
      initialTools.push({
        name: toolName,
        description: `${toolName} tool`,
        parameters: [],
      })
    }
  }

  // Ask about tools if none specified
  if (initialTools.length === 0) {
    const addTools = await confirm({
      message: 'Would you like to define initial tools interactively?',
      default: false,
    })

    if (addTools) {
      let addMore = true
      while (addMore) {
        const toolName = await input({
          message: 'Tool name:',
          validate: (value: string) => {
            if (!value.trim()) return 'Tool name is required'
            if (!/^[a-z][a-z0-9_-]*$/.test(value)) {
              return 'Tool name must be lowercase with letters, numbers, underscores, and hyphens'
            }
            return true
          },
        })

        const toolDescription = await input({
          message: 'Tool description:',
          default: `${toolName} tool`,
        })

        initialTools.push({
          name: toolName,
          description: toolDescription,
          parameters: [],
        })

        addMore = await confirm({
          message: 'Add another tool?',
          default: false,
        })
      }
    }
  }

  const targetDir = options.output ? resolve(options.output) : resolve('.', serverName)

  // Check if directory already exists
  try {
    await stat(targetDir)
    if (!options.force) {
      const overwrite = await confirm({
        message: `Directory ${targetDir} already exists. Overwrite?`,
        default: false,
      })
      if (!overwrite) {
        console.log(chalk.yellow('Initialization cancelled'))
        return
      }
    }
  } catch {
    // Directory doesn't exist, continue
  }

  const spinner = ora('Creating MCP server...').start()

  try {
    // Generate templates
    const files = renderMcpServerTemplates({
      name: serverName,
      description,
      tools: initialTools,
      author,
    })

    // Create directory structure
    await mkdir(targetDir, { recursive: true })
    await mkdir(join(targetDir, 'src'), { recursive: true })
    await mkdir(join(targetDir, 'src', 'tools'), { recursive: true })

    // Write all files
    for (const [filePath, content] of files) {
      const fullPath = join(targetDir, filePath)
      const dir = dirname(fullPath)
      await mkdir(dir, { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
    }

    spinner.succeed(`Created MCP server at ${targetDir}`)

    console.log(chalk.bold('\nNext steps:'))
    console.log(chalk.dim(`  1. cd ${targetDir}`))
    console.log(chalk.dim('  2. npm install'))
    console.log(chalk.dim('  3. npm run dev  # Run in development mode'))
    console.log(chalk.dim('  4. Edit src/tools/ to add your tool implementations'))
    console.log()

    console.log(chalk.bold('Configure in Claude Code:'))
    console.log(chalk.cyan('─'.repeat(50)))
    console.log(chalk.dim(`Add to ~/.claude/settings.json:`))
    console.log(
      chalk.white(`{
  "mcpServers": {
    "${serverName}": {
      "command": "npx",
      "args": ["tsx", "${join(targetDir, 'src', 'index.ts')}"]
    }
  }
}`)
    )
    console.log(chalk.cyan('─'.repeat(50)))
    console.log()
  } catch (error) {
    spinner.fail(`Failed to create MCP server: ${sanitizeError(error)}`)
    throw error
  }
}

/**
 * Create mcp-init command
 */
export function createMcpInitCommand(): Command {
  return new Command('mcp-init')
    .description('Scaffold a new MCP server project')
    .argument('[name]', 'MCP server name')
    .option('-o, --output <path>', 'Output directory')
    .option('--tools <tools>', 'Initial tools (comma-separated)')
    .option('--force', 'Overwrite existing directory')
    .action(
      async (name: string | undefined, opts: Record<string, string | boolean | undefined>) => {
        try {
          await initMcpServer(name, {
            output: opts['output'] as string | undefined,
            tools: opts['tools'] as string | undefined,
            force: opts['force'] as boolean | undefined,
          })
        } catch (error) {
          console.error(chalk.red('Error creating MCP server:'), sanitizeError(error))
          process.exit(1)
        }
      }
    )
}

export { initSkill, validateSkill, publishSkill, generateSubagent, transformSkill, initMcpServer }
