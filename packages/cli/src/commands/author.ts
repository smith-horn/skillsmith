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
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { SkillParser, type ValidationResult } from '@skillsmith/core'

import { SKILL_MD_TEMPLATE, README_MD_TEMPLATE } from '../templates/index.js'
import { sanitizeError } from '../utils/sanitize.js'

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

export { initSkill, validateSkill, publishSkill }
