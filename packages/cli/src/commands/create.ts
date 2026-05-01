/**
 * SMI-3083: skillsmith create command
 *
 * Scaffolds a new agent skill into ~/.claude/skills/<name>/ with
 * SKILL.md, README.md, CHANGELOG.md, .gitignore, resources/, and an optional
 * scripts/ directory.
 *
 * Relationship with `skillsmith author init`:
 *   - `create`      → ~/.claude/skills/<name>/  (user-level, publish-oriented,
 *                       CHANGELOG.md + Behavioral Classification included)
 *   - `author init` → current working directory  (in-project skill authoring)
 *
 * Long-term, `create` is the preferred command for publishing new skills to the
 * Skillsmith registry. `author init` is retained for in-project authoring workflows.
 */

import { Command } from 'commander'
import { input, confirm, select } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { getCanonicalInstallPath } from '@skillsmith/core/install'

import { sanitizeError } from '../utils/sanitize.js'
import { validateSkillName } from '../utils/skill-name.js'
import { SKILL_MD_TEMPLATE, README_MD_TEMPLATE, CHANGELOG_MD_TEMPLATE } from '../templates/index.js'

export { validateSkillName }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TYPES = ['basic', 'intermediate', 'advanced'] as const
const VALID_BEHAVIORS = ['autonomous', 'guided', 'interactive', 'configurable'] as const
const VALID_CATEGORIES = [
  'development',
  'productivity',
  'communication',
  'data',
  'security',
  'other',
] as const

type SkillType = (typeof VALID_TYPES)[number]
type SkillBehavior = (typeof VALID_BEHAVIORS)[number]
type SkillCategory = (typeof VALID_CATEGORIES)[number]

/** GitHub username format: alphanumeric and hyphens, must start with alphanumeric. */
const GITHUB_USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a user-supplied string for safe insertion into a YAML scalar value.
 * Strips newlines/carriage returns and double-quotes values containing YAML
 * special characters to prevent frontmatter corruption.
 */
function sanitizeYamlScalar(value: string): string {
  const safe = value.replace(/[\r\n]/g, ' ').trim()
  // Wrap in double quotes when value contains YAML-special characters
  if (/[:#[\]{}&|>'"*?!%@`]/.test(safe) || safe.startsWith(' ') || safe.endsWith(' ')) {
    return `"${safe.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return safe
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function behaviorDescription(behavior: string): string {
  switch (behavior) {
    case 'autonomous':
      return 'This skill operates autonomously — it executes its full workflow without requiring user input at each step.'
    case 'guided':
      return 'This skill is guided — it asks for your input on key decisions, then executes based on your choices.'
    case 'interactive':
      return 'This skill is interactive — it maintains a back-and-forth dialogue throughout execution.'
    case 'configurable':
      return 'This skill is configurable — behavior is controlled by settings you provide upfront.'
    default:
      return ''
  }
}

/** Build the SKILL.md content, sanitizing YAML frontmatter values. */
function buildSkillMd(opts: {
  name: string
  description: string
  author: string
  category: string
  type: string
  behavior: string
  date: string
}): string {
  const behavioralClassification = `\n## Behavioral Classification\n\n**Type**: ${capitalize(opts.type)}\n**Behavior**: ${capitalize(opts.behavior)}\n\n${behaviorDescription(opts.behavior)}\n`

  return SKILL_MD_TEMPLATE.replace(/\{\{name\}\}/g, opts.name)
    .replace(/\{\{description\}\}/g, sanitizeYamlScalar(opts.description))
    .replace(/\{\{author\}\}/g, sanitizeYamlScalar(opts.author))
    .replace(/\{\{category\}\}/g, opts.category)
    .replace(/\{\{date\}\}/g, opts.date)
    .replace(/\{\{behavioralClassification\}\}/g, behavioralClassification)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateOptions {
  output?: string | undefined
  type?: string | undefined
  behavior?: string | undefined
  description?: string | undefined
  author?: string | undefined
  category?: string | undefined
  scripts?: boolean | undefined
  yes?: boolean | undefined
  dryRun?: boolean | undefined
}

/**
 * Scaffold a new agent skill at ~/.claude/skills/<name>/ (or --output).
 */
export async function createSkill(
  name: string | undefined,
  options: CreateOptions = {}
): Promise<void> {
  // 1. Skill name
  const skillName =
    name ??
    (await input({
      message: 'Skill name (lowercase, hyphens only):',
      validate: validateSkillName,
    }))

  const nameValidation = validateSkillName(skillName)
  if (nameValidation !== true) {
    console.error(chalk.red(`Invalid skill name: ${nameValidation}`))
    process.exit(1)
  }

  // 2. Description (identity fields first, so user understands context before technical choices)
  const description =
    options.description ??
    (await input({
      message: 'Description:',
      default: `An agent skill for ${skillName}`,
      validate: (v: string) => (v.trim() ? true : 'Description is required'),
    }))

  if (!description.trim()) {
    console.error(chalk.red('Description is required'))
    process.exit(1)
  }

  // 3. Author (GitHub username) — validated for URL safety
  const rawAuthor =
    options.author ??
    (await input({
      message: 'Author (GitHub username):',
      default: process.env['USER'] ?? process.env['USERNAME'] ?? 'author',
      validate: (v: string) => {
        if (!v.trim()) return 'Author is required'
        if (!GITHUB_USERNAME_RE.test(v.trim()))
          return 'Must be a valid GitHub username (alphanumeric and hyphens only)'
        return true
      },
    }))

  if (!rawAuthor.trim() || !GITHUB_USERNAME_RE.test(rawAuthor.trim())) {
    console.error(
      chalk.red('Invalid author: must be a valid GitHub username (alphanumeric and hyphens only)')
    )
    process.exit(1)
  }
  const author = rawAuthor.trim()

  // 4. Category — validate CLI flag; select prompt constrains to valid values
  if (options.category && !VALID_CATEGORIES.includes(options.category as SkillCategory)) {
    console.error(
      chalk.red(`Invalid category: ${options.category}. Valid: ${VALID_CATEGORIES.join(', ')}`)
    )
    process.exit(1)
  }
  const category =
    options.category ??
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

  // 5. Skill type — validate CLI flag
  if (options.type && !VALID_TYPES.includes(options.type as SkillType)) {
    console.error(chalk.red(`Invalid type: ${options.type}. Valid: ${VALID_TYPES.join(', ')}`))
    process.exit(1)
  }
  const skillType =
    options.type ??
    (await select({
      message: 'Skill type:',
      choices: [
        { name: 'Basic — simple, single-purpose skill', value: 'basic' },
        { name: 'Intermediate — multi-step with some decisions', value: 'intermediate' },
        { name: 'Advanced — complex orchestration or agent delegation', value: 'advanced' },
      ],
    }))

  // 6. Behavioral classification — validate CLI flag
  if (options.behavior && !VALID_BEHAVIORS.includes(options.behavior as SkillBehavior)) {
    console.error(
      chalk.red(`Invalid behavior: ${options.behavior}. Valid: ${VALID_BEHAVIORS.join(', ')}`)
    )
    process.exit(1)
  }
  const behavior =
    options.behavior ??
    (await select({
      message: 'Behavioral classification:',
      choices: [
        { name: 'Autonomous — runs without user input', value: 'autonomous' },
        { name: 'Guided — asks key questions then executes', value: 'guided' },
        {
          name: 'Interactive — back-and-forth dialogue throughout execution',
          value: 'interactive',
        },
        { name: 'Configurable — settings-driven, provided upfront', value: 'configurable' },
      ],
    }))

  // 7. Scripts directory
  const includeScripts =
    options.scripts ??
    (await confirm({
      message: 'Include a scripts/ directory?',
      default: false,
    }))

  // 8. Resolve output directory — lazy (never baked in at module load time).
  //    SMI-4578: routes through canonical install path so default-client
  //    directory is defined in exactly one place.
  const outputDir = options.output ?? getCanonicalInstallPath()
  const skillDir = join(outputDir, skillName)

  // 9. Overwrite check — after all prompts so user knows what they committed to
  let exists = false
  try {
    await stat(skillDir)
    exists = true
  } catch {
    // Directory does not exist — proceed
  }

  if (exists && !options.yes) {
    // --yes semantics: always overwrite without prompt
    const overwrite = await confirm({
      message: `${skillDir} already exists. Overwrite?`,
      default: false,
    })
    if (!overwrite) {
      console.log(chalk.yellow('Cancelled.'))
      return
    }
  }

  const date = new Date().toISOString().split('T')[0] ?? new Date().toISOString().slice(0, 10)

  // Build file contents
  const skillMdContent = buildSkillMd({
    name: skillName,
    description,
    author,
    category,
    type: skillType,
    behavior,
    date,
  })

  const readmeContent = README_MD_TEMPLATE.replace(/\{\{author\}\}/g, sanitizeYamlScalar(author))
    .replace(/\{\{name\}\}/g, skillName)
    .replace(/\{\{description\}\}/g, description)

  const changelogContent = CHANGELOG_MD_TEMPLATE.replace(/\{\{name\}\}/g, skillName).replace(
    /\{\{date\}\}/g,
    date
  )

  // JSON.stringify prevents skill names containing single-quotes from breaking generated JS
  const scriptContent = `#!/usr/bin/env node\n/**\n * ${skillName} - Example Script\n */\nconsole.log(${JSON.stringify(`${skillName} script executed`)})\n`

  const gitignoreContent = `# Dependencies\nnode_modules/\n\n# Build output\ndist/\n\n# Environment\n.env\n.env.local\n\n# OS files\n.DS_Store\nThumbs.db\n`

  // 10. Dry run — preview scaffold output without writing any files
  if (options.dryRun) {
    console.log()
    console.log(chalk.bold(`Dry run — would scaffold: ${skillDir}/`))
    console.log(chalk.dim('  SKILL.md'))
    console.log(chalk.dim('  README.md'))
    console.log(chalk.dim('  CHANGELOG.md'))
    console.log(chalk.dim('  .gitignore'))
    console.log(chalk.dim('  resources/'))
    if (includeScripts) {
      console.log(chalk.dim('  scripts/'))
      console.log(chalk.dim('  scripts/example.js'))
    }
    console.log()
    console.log(chalk.bold('SKILL.md preview:'))
    const preview =
      skillMdContent.length > 500 ? skillMdContent.slice(0, 500) + '\n…' : skillMdContent
    console.log(chalk.dim(preview))
    console.log()
    return
  }

  const spinner = ora('Scaffolding skill...').start()

  try {
    await mkdir(skillDir, { recursive: true })
    await mkdir(join(skillDir, 'resources'), { recursive: true })
    if (includeScripts) {
      await mkdir(join(skillDir, 'scripts'), { recursive: true })
    }

    await writeFile(join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8')
    await writeFile(join(skillDir, 'README.md'), readmeContent, 'utf-8')
    await writeFile(join(skillDir, 'CHANGELOG.md'), changelogContent, 'utf-8')
    await writeFile(join(skillDir, '.gitignore'), gitignoreContent, 'utf-8')

    if (includeScripts) {
      await writeFile(join(skillDir, 'scripts', 'example.js'), scriptContent, 'utf-8')
    }

    spinner.succeed(`Skill scaffolded at ${skillDir}`)
  } catch (error) {
    spinner.fail(`Failed to scaffold skill: ${sanitizeError(error)}`)
    throw error
  }

  // Publishing checklist — aligned with v1.1.0 publish gate requirements
  // (README filled, CHANGELOG filled, release tag, registry submit)
  console.log()
  console.log(chalk.bold('Publishing checklist:'))
  console.log(chalk.dim(`  1. Edit SKILL.md — write your skill's instructions and trigger phrases`))
  console.log(
    chalk.dim(`  2. Complete README.md — problem statement, usage examples, requirements`)
  )
  console.log(chalk.dim(`  3. Update CHANGELOG.md — confirm the [1.0.0] entry is accurate`))
  console.log(chalk.dim('  4. Test your skill locally with your MCP-compatible agent'))
  console.log(chalk.dim('  5. Publish to GitHub:'))
  console.log(chalk.cyan(`       gh repo create ${skillName} --public`))
  console.log(
    chalk.cyan(
      `       cd ${skillDir} && git init && git add . && git commit -m "feat: initial skill"`
    )
  )
  console.log(chalk.cyan(`       git remote add origin https://github.com/${author}/${skillName}`))
  console.log(chalk.cyan('       git push -u origin main'))
  console.log(
    chalk.cyan('       gh release create v1.0.0 --title "v1.0.0" --notes "Initial release"')
  )
  console.log(chalk.dim('  6. Submit to Skillsmith registry: skillsmith publish'))
  console.log()
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Create the `skillsmith create` command.
 * SMI-3083: Scaffold new agent skills without a separate skill install.
 *
 * See also: `skillsmith author init` — scaffolds into the CWD for in-project
 * skill authoring (no CHANGELOG.md or Behavioral Classification section).
 */
export function createCreateCommand(): Command {
  return new Command('create')
    .description(
      'Scaffold a new agent skill at ~/.claude/skills/<name>/ (see also: skillsmith author init)'
    )
    .argument('[name]', 'Skill name (lowercase, hyphens only)')
    .option('-o, --output <dir>', 'Output directory (default: ~/.claude/skills)')
    .option('--type <type>', 'Skill type: basic|intermediate|advanced')
    .option(
      '--behavior <behavior>',
      'Behavioral classification: autonomous|guided|interactive|configurable'
    )
    .option('-d, --description <description>', 'Skill description (skips prompt)')
    .option('-a, --author <author>', 'Author GitHub username (skips prompt)')
    .option(
      '-c, --category <category>',
      'Category: development|productivity|communication|data|security|other (skips prompt)'
    )
    .option('--scripts', 'Include a scripts/ directory')
    .option('-y, --yes', 'Auto-confirm overwrite — always overwrites if skill directory exists')
    .option('--dry-run', 'Preview scaffold output without writing files')
    .action(
      async (name: string | undefined, opts: Record<string, string | boolean | undefined>) => {
        try {
          await createSkill(name, {
            output: opts['output'] as string | undefined,
            type: opts['type'] as string | undefined,
            behavior: opts['behavior'] as string | undefined,
            description: opts['description'] as string | undefined,
            author: opts['author'] as string | undefined,
            category: opts['category'] as string | undefined,
            scripts: opts['scripts'] as boolean | undefined,
            yes: opts['yes'] as boolean | undefined,
            dryRun: opts['dryRun'] as boolean | undefined,
          })
        } catch (error) {
          console.error(chalk.red('Error creating skill:'), sanitizeError(error))
          process.exit(1)
        }
      }
    )
}
