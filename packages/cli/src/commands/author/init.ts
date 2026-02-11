/**
 * SMI-746: Skill Initialization Commands
 * SMI-1473: Non-interactive init command flags
 *
 * Commands for creating, validating, and publishing skills.
 */

import { Command } from 'commander'
import { input, confirm, select } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir, writeFile, readFile, stat, readdir } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { createHash } from 'crypto'
import { SkillParser } from '@skillsmith/core'

import { SKILL_MD_TEMPLATE, README_MD_TEMPLATE } from '../../templates/index.js'
import { sanitizeError } from '../../utils/sanitize.js'
import { printValidationResult } from './utils.js'

/**
 * SMI-1473: Options for non-interactive init command
 */
export interface InitOptions {
  description?: string | undefined
  author?: string | undefined
  category?: string | undefined
  yes?: boolean | undefined
}

/**
 * Valid categories for skill initialization
 */
export const VALID_CATEGORIES = [
  'development',
  'productivity',
  'communication',
  'data',
  'security',
  'other',
]

/**
 * Initialize a new skill directory
 */
export async function initSkill(
  name: string | undefined,
  targetPath: string,
  options: InitOptions = {}
): Promise<void> {
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

  // Use provided options or prompt interactively
  const description =
    options.description ||
    (await input({
      message: 'Description:',
      default: `A Claude skill for ${skillName}`,
    }))

  const author =
    options.author ||
    (await input({
      message: 'Author:',
      default: process.env['USER'] || 'author',
    }))

  // Validate category if provided via CLI
  if (options.category && !VALID_CATEGORIES.includes(options.category)) {
    console.error(
      chalk.red(
        `Invalid category: ${options.category}. Valid categories: ${VALID_CATEGORIES.join(', ')}`
      )
    )
    process.exit(1)
  }

  const category =
    options.category ||
    (await select({
      message: 'Category:',
      choices: [
        { name: 'Development', value: 'development' },
        { name: 'Productivity', value: 'productivity' },
        { name: 'Communication', value: 'communication' },
        { name: 'Data', value: 'data' },
        { name: 'Security', value: 'security' },
        { name: 'Other', value: 'other' },
      ],
    }))

  const skillDir = resolve(targetPath, skillName)

  // Check if directory already exists
  try {
    await stat(skillDir)
    // Skip confirmation if --yes flag is set
    if (!options.yes) {
      const overwrite = await confirm({
        message: `Directory ${skillDir} already exists. Overwrite?`,
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
 * Validate a local SKILL.md file
 */
export async function validateSkill(skillPath: string): Promise<boolean> {
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
export async function publishSkill(
  skillPath: string,
  options: { checkReferences?: boolean; referencePatterns?: string[] } = {}
): Promise<boolean> {
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

    // SMI-2439: Check for project-specific references
    if (options.checkReferences) {
      spinner.text = 'Scanning for project-specific references...'

      // Read all .md files in skill directory (max 20)
      const allFiles = await readdir(dirPath, { recursive: true })
      const mdFiles = (allFiles as string[]).filter((f) => f.endsWith('.md')).slice(0, 20)

      if ((allFiles as string[]).filter((f) => f.endsWith('.md')).length > 20) {
        console.log(chalk.yellow('\n  ⚠️  More than 20 .md files found — scanning first 20 only'))
      }

      // Parse custom patterns if provided
      const customPatterns = options.referencePatterns
        ?.map((p) => {
          if (p.length > 200) {
            console.log(
              chalk.yellow(`  ⚠️  Regex pattern too long (max 200 chars): ${p.slice(0, 40)}...`)
            )
            return null
          }
          try {
            return new RegExp(p, 'g')
          } catch {
            console.log(chalk.yellow(`  ⚠️  Invalid regex pattern: ${p}`))
            return null
          }
        })
        .filter((p): p is RegExp => p !== null)

      let totalWarnings = 0

      for (const mdFile of mdFiles) {
        const filePath = join(dirPath, mdFile)
        const fileContent = await readFile(filePath, 'utf-8')
        const result = SkillParser.checkReferences(fileContent, customPatterns)

        if (result.matches.length > 0) {
          totalWarnings += result.matches.length
          spinner.stop()
          console.log(chalk.yellow(`\n  References in ${mdFile}:`))
          for (const match of result.matches) {
            const truncated = match.text.length > 80 ? match.text.slice(0, 80) + '...' : match.text
            console.log(chalk.dim(`    L${match.line}: ${truncated} (${match.pattern})`))
          }
          spinner.start()
        }
      }

      if (totalWarnings > 0) {
        spinner.stop()
        console.log(
          chalk.yellow(
            `\n  ⚠️  Found ${totalWarnings} project-specific reference(s) across ${mdFiles.length} file(s)`
          )
        )
        console.log(
          chalk.dim('  These may leak internal project details. Review before publishing.')
        )
        spinner.start()
      }
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
 * SMI-1473: Added non-interactive flags for E2E testing
 */
export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize a new skill directory')
    .argument('[name]', 'Skill name')
    .option('-p, --path <path>', 'Target directory', '.')
    .option('-d, --description <description>', 'Skill description (non-interactive)')
    .option('-a, --author <author>', 'Skill author (non-interactive)')
    .option(
      '-c, --category <category>',
      'Skill category: development|productivity|communication|data|security|other (non-interactive)'
    )
    .option('-y, --yes', 'Auto-confirm overwrite (non-interactive)')
    .action(
      async (name: string | undefined, opts: Record<string, string | boolean | undefined>) => {
        const targetPath = (opts['path'] as string) || '.'

        try {
          await initSkill(name, targetPath, {
            description: opts['description'] as string | undefined,
            author: opts['author'] as string | undefined,
            category: opts['category'] as string | undefined,
            yes: opts['yes'] as boolean | undefined,
          })
        } catch (error) {
          console.error(chalk.red('Error initializing skill:'), sanitizeError(error))
          process.exit(1)
        }
      }
    )
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
    .option('--check-references', 'Scan for project-specific references before publishing')
    .option(
      '--reference-patterns <patterns>',
      'Additional regex patterns to check (comma-separated)'
    )
    .action(async (skillPath: string, opts: Record<string, string | boolean | undefined>) => {
      try {
        const referencePatterns = opts['referencePatterns']
          ? String(opts['referencePatterns'])
              .split(',')
              .map((p) => p.trim())
          : undefined
        // SMI-2444: Use conditional spread to satisfy exactOptionalPropertyTypes
        const success = await publishSkill(skillPath, {
          ...(opts['checkReferences'] !== undefined && {
            checkReferences: opts['checkReferences'] as boolean,
          }),
          ...(referencePatterns !== undefined && { referencePatterns }),
        })
        process.exit(success ? 0 : 1)
      } catch (error) {
        console.error(chalk.red('Error publishing skill:'), sanitizeError(error))
        process.exit(1)
      }
    })
}
