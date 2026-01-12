/**
 * SMI-746: Skill Authoring Commands
 * SMI-1389: Subagent Generation Command
 * SMI-1390: Transform Command
 *
 * Provides CLI commands for creating, validating, publishing skills,
 * and generating companion subagents.
 */

import { Command } from 'commander'
import { input, confirm, select } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir, writeFile, readFile, stat, access } from 'fs/promises'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { SkillParser, type ValidationResult } from '@skillsmith/core'

import {
  SKILL_MD_TEMPLATE,
  README_MD_TEMPLATE,
  SUBAGENT_MD_TEMPLATE,
  CLAUDE_MD_DELEGATION_TEMPLATE,
} from '../templates/index.js'
import { sanitizeError } from '../utils/sanitize.js'

/**
 * Tool detection keyword configuration.
 * Maps tool names to keywords that indicate the tool is needed.
 * SMI-1394: Extracted from inline strings for maintainability.
 */
const TOOL_DETECTION_KEYWORDS: Record<string, string[]> = {
  // File write operations
  Write: ['write', 'create file', 'save'],
  Edit: ['edit', 'modify', 'update file'],
  // Command execution
  Bash: ['bash', 'npm', 'command', 'terminal', 'shell', 'run '],
  // Search operations
  Grep: ['search', 'find', 'grep'],
  Glob: ['glob', 'pattern', 'find files'],
  // Web operations
  WebFetch: ['web', 'fetch', 'url', 'http', 'api'],
}

/**
 * Valid tool names for validation
 */
const VALID_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'TodoRead',
]

/**
 * Subagent generation options
 */
interface SubagentOptions {
  output?: string
  tools?: string
  model?: string
  skipClaudeMd?: boolean
}

/**
 * Transform command options
 */
interface TransformOptions {
  dryRun?: boolean
  force?: boolean
  batch?: string
}

/**
 * Parsed skill metadata for subagent generation
 */
interface SkillMetadata {
  name: string
  description: string
  triggers: string[]
}

/**
 * Resolve a skill path to its SKILL.md file.
 * Handles both directory paths and direct file paths.
 * SMI-1395: Extracted to avoid duplicated path resolution logic.
 *
 * @param inputPath - Path to skill directory or SKILL.md file
 * @returns Resolved path to SKILL.md file
 */
async function resolveSkillPath(inputPath: string): Promise<string> {
  let filePath = resolve(inputPath)

  try {
    const stats = await stat(filePath)
    if (stats.isDirectory()) {
      filePath = join(filePath, 'SKILL.md')
    }
  } catch {
    // Path doesn't exist or can't be accessed - assume it's a directory path
    // and append SKILL.md. The actual file read will fail with a clear error
    // if the file doesn't exist.
    if (!filePath.endsWith('.md')) {
      filePath = join(filePath, 'SKILL.md')
    }
  }

  return filePath
}

/**
 * Validate that provided tools are recognized tool names.
 * SMI-1396: Added tool validation for --tools option.
 *
 * @param tools - Array of tool names to validate
 * @returns Object with valid flag and any invalid tool names
 */
function validateToolNames(tools: string[]): { valid: boolean; invalidTools: string[] } {
  const invalidTools = tools.filter((t) => !VALID_TOOLS.includes(t))
  return {
    valid: invalidTools.length === 0,
    invalidTools,
  }
}

/**
 * Parse YAML frontmatter from SKILL.md content
 */
function parseSkillMetadata(content: string): SkillMetadata {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch || !frontmatterMatch[1]) {
    throw new Error('No YAML frontmatter found in SKILL.md')
  }

  const frontmatter = frontmatterMatch[1]
  const lines = frontmatter.split('\n')

  let name = ''
  let description = ''
  const triggers: string[] = []

  for (const line of lines) {
    const nameMatch = line.match(/^name:\s*(.+)$/)
    if (nameMatch && nameMatch[1]) {
      name = nameMatch[1].trim()
    }

    const descMatch = line.match(/^description:\s*(.+)$/)
    if (descMatch && descMatch[1]) {
      description = descMatch[1].trim()
      // Extract trigger phrases from description
      const triggerMatch = description.match(/"([^"]+)"/g)
      if (triggerMatch) {
        for (const t of triggerMatch) {
          triggers.push(t.replace(/"/g, ''))
        }
      }
    }
  }

  if (!name) {
    throw new Error('No name found in SKILL.md frontmatter')
  }

  return { name, description, triggers }
}

/**
 * Analyze skill content to determine required tools.
 * Uses TOOL_DETECTION_KEYWORDS configuration for keyword matching.
 * SMI-1394: Refactored to use configurable keywords.
 *
 * @param content - The SKILL.md content to analyze
 * @returns Array of required tool names
 */
function analyzeRequiredTools(content: string): string[] {
  const tools = new Set<string>()
  const contentLower = content.toLowerCase()

  // Always include Read - all subagents need to read files
  tools.add('Read')

  // Check each tool's keywords against the content
  for (const [toolName, keywords] of Object.entries(TOOL_DETECTION_KEYWORDS)) {
    const hasKeyword = keywords.some((keyword) => contentLower.includes(keyword))
    if (hasKeyword) {
      tools.add(toolName)
      // Write and Edit are typically used together
      if (toolName === 'Write') {
        tools.add('Edit')
      } else if (toolName === 'Edit') {
        tools.add('Write')
      }
      // Grep and Glob are typically used together
      if (toolName === 'Grep') {
        tools.add('Glob')
      } else if (toolName === 'Glob') {
        tools.add('Grep')
      }
    }
  }

  return Array.from(tools)
}

/**
 * Generate subagent content from template
 */
function generateSubagentContent(metadata: SkillMetadata, tools: string[], model: string): string {
  const triggersStr =
    metadata.triggers.length > 0
      ? metadata.triggers.map((t) => `"${t}"`).join(', ')
      : 'delegated tasks for this skill'

  return SUBAGENT_MD_TEMPLATE.replace(/\{\{name\}\}/g, metadata.name)
    .replace(/\{\{description\}\}/g, metadata.description)
    .replace(/\{\{triggers\}\}/g, triggersStr)
    .replace(/\{\{tools\}\}/g, tools.join(', '))
    .replace(/\{\{model\}\}/g, model)
}

/**
 * Generate CLAUDE.md delegation snippet
 */
function generateClaudeMdSnippet(metadata: SkillMetadata): string {
  const triggersStr =
    metadata.triggers.length > 0 ? `"${metadata.triggers.join('", "')}"` : '"skill-specific tasks"'

  return CLAUDE_MD_DELEGATION_TEMPLATE.replace(/\{\{name\}\}/g, metadata.name).replace(
    /\{\{triggers\}\}/g,
    triggersStr
  )
}

/**
 * Generate a companion subagent for a skill.
 * SMI-1389: Main implementation for `skillsmith author subagent` command.
 *
 * @param skillPath - Path to skill directory or SKILL.md
 * @param opts - Generation options
 */
async function generateSubagent(skillPath: string, opts: SubagentOptions): Promise<void> {
  const spinner = ora('Generating subagent...').start()

  try {
    // Resolve skill path using shared utility (SMI-1395)
    const filePath = await resolveSkillPath(skillPath)

    // Read skill content
    const content = await readFile(filePath, 'utf-8')

    // Parse metadata
    spinner.text = 'Parsing skill metadata...'
    const metadata = parseSkillMetadata(content)

    // Determine tools
    let tools: string[]
    if (opts.tools) {
      tools = opts.tools.split(',').map((t) => t.trim())
      // Validate tool names (SMI-1396)
      const validation = validateToolNames(tools)
      if (!validation.valid) {
        spinner.warn(`Unknown tools will be included: ${validation.invalidTools.join(', ')}`)
        console.log(chalk.dim(`  Valid tools: ${VALID_TOOLS.join(', ')}`))
      }
    } else {
      spinner.text = 'Analyzing tool requirements...'
      tools = analyzeRequiredTools(content)
    }

    const model = opts.model || 'sonnet'

    // Generate subagent content
    spinner.text = 'Generating subagent definition...'
    const subagentContent = generateSubagentContent(metadata, tools, model)

    // Determine output path
    const outputDir = opts.output ? resolve(opts.output) : join(homedir(), '.claude', 'agents')

    const subagentPath = join(outputDir, `${metadata.name}-specialist.md`)

    // Create output directory if needed
    await mkdir(outputDir, { recursive: true })

    // Write subagent file
    await writeFile(subagentPath, subagentContent, 'utf-8')

    spinner.succeed(`Generated subagent: ${subagentPath}`)

    // Display metadata
    console.log(chalk.bold('\nSubagent Details:'))
    console.log(chalk.dim(`  Name: ${metadata.name}-specialist`))
    console.log(chalk.dim(`  Tools: ${tools.join(', ')}`))
    console.log(chalk.dim(`  Model: ${model}`))
    console.log(chalk.dim(`  Location: ${subagentPath}`))

    // Generate CLAUDE.md snippet
    if (!opts.skipClaudeMd) {
      const claudeSnippet = generateClaudeMdSnippet(metadata)
      console.log(chalk.bold('\nAdd to your CLAUDE.md:'))
      console.log(chalk.cyan('─'.repeat(50)))
      console.log(claudeSnippet)
      console.log(chalk.cyan('─'.repeat(50)))
    }

    console.log(chalk.bold('\nNext steps:'))
    console.log(chalk.dim('  1. Review the generated subagent definition'))
    console.log(chalk.dim('  2. Add the CLAUDE.md snippet for delegation'))
    console.log(chalk.dim('  3. Test delegation with a sample task'))
    console.log()
  } catch (error) {
    spinner.fail(`Failed to generate subagent: ${sanitizeError(error)}`)
    throw error
  }
}

/**
 * Transform an existing skill by generating a subagent (non-destructive)
 */
async function transformSkill(skillPath: string, opts: TransformOptions): Promise<void> {
  // Handle batch mode
  if (opts.batch) {
    const paths = opts.batch.split(',').map((p) => p.trim())
    console.log(chalk.bold(`Batch processing ${paths.length} skills...\n`))

    for (const path of paths) {
      console.log(chalk.cyan(`Processing: ${path}`))
      try {
        await transformSingleSkill(path, opts)
        console.log(chalk.green(`  ✓ Success\n`))
      } catch (error) {
        console.log(chalk.red(`  ✗ Failed: ${sanitizeError(error)}\n`))
      }
    }
    return
  }

  await transformSingleSkill(skillPath, opts)
}

/**
 * Transform a single skill by generating a subagent (non-destructive).
 * SMI-1390: Implementation for `skillsmith author transform` command.
 *
 * @param skillPath - Path to skill directory or SKILL.md
 * @param opts - Transform options
 */
async function transformSingleSkill(skillPath: string, opts: TransformOptions): Promise<void> {
  const spinner = ora('Analyzing skill...').start()

  try {
    // Resolve skill path using shared utility (SMI-1395)
    const filePath = await resolveSkillPath(skillPath)

    // Read skill content
    const content = await readFile(filePath, 'utf-8')

    // Parse metadata
    const metadata = parseSkillMetadata(content)
    const tools = analyzeRequiredTools(content)

    // Determine output path
    const outputDir = join(homedir(), '.claude', 'agents')
    const subagentPath = join(outputDir, `${metadata.name}-specialist.md`)

    // Check if subagent already exists
    let exists = false
    try {
      await access(subagentPath)
      exists = true
    } catch {
      // File doesn't exist
    }

    if (exists && !opts.force && !opts.dryRun) {
      spinner.fail(`Subagent already exists: ${subagentPath}`)
      console.log(chalk.yellow('\nUse --force to overwrite'))
      return
    }

    if (opts.dryRun) {
      spinner.stop()
      console.log(chalk.bold('Dry run - no files will be created\n'))
      console.log(chalk.bold('Analysis Results:'))
      console.log(chalk.dim(`  Skill: ${metadata.name}`))
      console.log(chalk.dim(`  Description: ${metadata.description}`))
      console.log(
        chalk.dim(
          `  Detected Triggers: ${metadata.triggers.length > 0 ? metadata.triggers.join(', ') : 'None detected'}`
        )
      )
      console.log(chalk.dim(`  Required Tools: ${tools.join(', ')}`))
      console.log(chalk.dim(`  Output Path: ${subagentPath}`))
      console.log(chalk.dim(`  Would Overwrite: ${exists ? 'Yes' : 'No'}`))

      console.log(chalk.bold('\nGenerated Content Preview:'))
      console.log(chalk.cyan('─'.repeat(50)))
      console.log(generateSubagentContent(metadata, tools, 'sonnet'))
      console.log(chalk.cyan('─'.repeat(50)))
      return
    }

    // Generate subagent
    spinner.text = 'Generating subagent...'
    const subagentContent = generateSubagentContent(metadata, tools, 'sonnet')

    // Create output directory if needed
    await mkdir(outputDir, { recursive: true })

    // Write subagent file
    await writeFile(subagentPath, subagentContent, 'utf-8')

    spinner.succeed(`Transformed skill: ${metadata.name}`)

    console.log(chalk.bold('\nTransform Results:'))
    console.log(chalk.dim(`  Original: ${filePath} (unchanged)`))
    console.log(chalk.dim(`  Generated: ${subagentPath}`))
    console.log(chalk.dim(`  Tools: ${tools.join(', ')}`))

    // Generate CLAUDE.md snippet
    const claudeSnippet = generateClaudeMdSnippet(metadata)
    console.log(chalk.bold('\nAdd to your CLAUDE.md:'))
    console.log(chalk.cyan('─'.repeat(50)))
    console.log(claudeSnippet)
    console.log(chalk.cyan('─'.repeat(50)))
    console.log()
  } catch (error) {
    spinner.fail(`Failed to transform skill: ${sanitizeError(error)}`)
    throw error
  }
}

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
        dirPath = join(dirPath, '..')
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
 * Create subagent command (SMI-1389)
 */
export function createSubagentCommand(): Command {
  return new Command('subagent')
    .description('Generate a companion subagent for a skill')
    .argument('[path]', 'Path to skill directory or SKILL.md', '.')
    .option('-o, --output <path>', 'Output directory for subagent', '~/.claude/agents')
    .option('--tools <tools>', 'Override default tools (comma-separated)')
    .option('--model <model>', 'Model to use (sonnet, opus, haiku)', 'sonnet')
    .option('--skip-claude-md', 'Skip CLAUDE.md snippet generation')
    .action(async (skillPath: string, opts: SubagentOptions) => {
      try {
        await generateSubagent(skillPath, opts)
      } catch (error) {
        console.error(chalk.red('Error generating subagent:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

/**
 * Create transform command (SMI-1390)
 */
export function createTransformCommand(): Command {
  return new Command('transform')
    .description('Upgrade an existing skill with subagent configuration')
    .argument('[path]', 'Path to skill directory or SKILL.md', '.')
    .option('--dry-run', 'Show what would be generated without creating files')
    .option('--force', 'Overwrite existing subagent definition')
    .option('--batch <paths>', 'Process multiple skills (comma-separated paths)')
    .action(async (skillPath: string, opts: TransformOptions) => {
      try {
        await transformSkill(skillPath, opts)
      } catch (error) {
        console.error(chalk.red('Error transforming skill:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

export { initSkill, validateSkill, publishSkill, generateSubagent, transformSkill }
