/**
 * SMI-3083: skillsmith create command
 *
 * Scaffolds a new Claude Code skill into ~/.claude/skills/<name>/ with
 * SKILL.md, README.md, CHANGELOG.md, and an optional scripts/ directory.
 * Embeds the skill-builder workflow directly — no separate skill install required.
 */

import { Command } from 'commander'
import { input, confirm, select } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { sanitizeError } from '../utils/sanitize.js'
import { CHANGELOG_MD_TEMPLATE } from '../templates/index.js'

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/** Lowercase letters, digits, and hyphens only. Must start with a letter. */
const NAME_RE = /^[a-z][a-z0-9-]*$/

export function validateSkillName(name: string): true | string {
  if (!name.trim()) return 'Skill name is required'
  if (!NAME_RE.test(name)) {
    return 'Skill name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (e.g. my-skill)'
  }
  return true
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function buildSkillMd(opts: {
  name: string
  description: string
  author: string
  category: string
  type: string
  behavior: string
  date: string
}): string {
  return `---
name: ${opts.name}
description: ${opts.description}
author: ${opts.author}
version: 1.0.0
category: ${opts.category}
tags:
  - claude-skill
  - ${opts.category}
license: MIT
created: ${opts.date}
---

# ${opts.name}

${opts.description}

## Behavioral Classification

**Type**: ${capitalize(opts.type)}
**Behavior**: ${capitalize(opts.behavior)}

${behaviorDescription(opts.behavior)}

## Features

- Feature 1: Description of feature
- Feature 2: Description of feature
- Feature 3: Description of feature

## Installation

\`\`\`bash
skillsmith install ${opts.author}/${opts.name}
\`\`\`

Or manually:

\`\`\`bash
cp -r . ~/.claude/skills/${opts.name}
\`\`\`

## Usage

Describe how to use this skill with examples.

### Trigger Phrases

The skill responds to:
- "example phrase 1"
- "example phrase 2"

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| \`setting1\` | \`value\` | Description |

## Dependencies

This skill requires:
- No external dependencies

## Changelog

### 1.0.0 (${opts.date})
- Initial release
`
}

function buildReadmeMd(opts: {
  name: string
  description: string
  author: string
  date: string
}): string {
  return `# ${opts.name}

${opts.description}

## Problem Statement

Describe the problem this skill solves for Claude Code users.

## Installation

### Via Skillsmith

\`\`\`bash
skillsmith install ${opts.author}/${opts.name}
\`\`\`

### Manual Installation

\`\`\`bash
cp -r ${opts.name} ~/.claude/skills/
\`\`\`

## Usage

\`\`\`
/example-command
\`\`\`

Or use trigger phrases:
- "example phrase 1"
- "example phrase 2"

## Contents

| File | Description |
|------|-------------|
| \`SKILL.md\` | Skill definition and Claude Code instructions |
| \`README.md\` | This file |
| \`CHANGELOG.md\` | Version history |

## Requirements

- Claude Code (latest)
- No external dependencies

## Author

${opts.author}

## License

MIT
`
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateOptions {
  output?: string | undefined
  type?: string | undefined
  behavior?: string | undefined
  scripts?: boolean | undefined
  yes?: boolean | undefined
}

/**
 * Scaffold a new Claude Code skill at ~/.claude/skills/<name>/ (or --output).
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

  // 2. Output directory
  const outputDir = options.output ?? join(homedir(), '.claude', 'skills')
  const skillDir = join(outputDir, skillName)

  // 3. Overwrite check
  let exists = false
  try {
    await stat(skillDir)
    exists = true
  } catch {
    // Directory does not exist — proceed
  }

  if (exists) {
    if (!options.yes) {
      const overwrite = await confirm({
        message: `${skillDir} already exists. Overwrite?`,
        default: false,
      })
      if (!overwrite) {
        console.log(chalk.yellow('Cancelled.'))
        return
      }
    }
  }

  // 4. Skill type
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

  // 5. Behavioral classification
  const behavior =
    options.behavior ??
    (await select({
      message: 'Behavioral classification:',
      choices: [
        { name: 'Autonomous — runs without user input', value: 'autonomous' },
        { name: 'Guided — asks key questions then executes', value: 'guided' },
        { name: 'Interactive — back-and-forth dialogue', value: 'interactive' },
        { name: 'Configurable — settings-driven behavior', value: 'configurable' },
      ],
    }))

  // 6. Scripts directory
  const includeScripts =
    options.scripts ??
    (await confirm({
      message: 'Include a scripts/ directory?',
      default: false,
    }))

  // 7. Description
  const description = await input({
    message: 'Description:',
    default: `A Claude Code skill for ${skillName}`,
  })

  // 8. Author
  const author = await input({
    message: 'Author (GitHub username):',
    default: process.env['USER'] ?? 'author',
  })

  // 9. Category
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

  const date = new Date().toISOString().split('T')[0] ?? new Date().toISOString().slice(0, 10)

  const spinner = ora('Scaffolding skill...').start()

  try {
    // Create directories
    await mkdir(skillDir, { recursive: true })
    if (includeScripts) {
      await mkdir(join(skillDir, 'scripts'), { recursive: true })
    }

    // SKILL.md
    await writeFile(
      join(skillDir, 'SKILL.md'),
      buildSkillMd({
        name: skillName,
        description,
        author,
        category,
        type: skillType,
        behavior,
        date,
      }),
      'utf-8'
    )

    // README.md
    await writeFile(
      join(skillDir, 'README.md'),
      buildReadmeMd({ name: skillName, description, author, date }),
      'utf-8'
    )

    // CHANGELOG.md
    const changelogContent = CHANGELOG_MD_TEMPLATE.replace(/\{\{name\}\}/g, skillName).replace(
      /\{\{date\}\}/g,
      date
    )
    await writeFile(join(skillDir, 'CHANGELOG.md'), changelogContent, 'utf-8')

    // Optional scripts placeholder
    if (includeScripts) {
      await writeFile(
        join(skillDir, 'scripts', 'example.js'),
        `#!/usr/bin/env node\n/**\n * ${skillName} - Example Script\n */\nconsole.log('${skillName} script executed')\n`,
        'utf-8'
      )
    }

    spinner.succeed(`Skill scaffolded at ${skillDir}`)
  } catch (error) {
    spinner.fail(`Failed to scaffold skill: ${sanitizeError(error)}`)
    throw error
  }

  // Publishing checklist
  console.log()
  console.log(chalk.bold('Next steps:'))
  console.log(chalk.dim(`  1. Edit SKILL.md with your skill's instructions`))
  console.log(chalk.dim('  2. Update README.md with usage examples'))
  console.log(chalk.dim('  3. Test your skill with Claude Code'))
  console.log(chalk.dim('  4. Publish to GitHub:'))
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
  console.log(chalk.dim('  5. Submit to registry: skillsmith publish'))
  console.log()
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Create the `skillsmith create` command.
 * SMI-3083: Scaffold new Claude Code skills without a separate skill install.
 */
export function createCreateCommand(): Command {
  return new Command('create')
    .description('Scaffold a new Claude Code skill at ~/.claude/skills/<name>/')
    .argument('[name]', 'Skill name (lowercase, hyphens only)')
    .option(
      '-o, --output <dir>',
      'Output directory (default: ~/.claude/skills)',
      join(homedir(), '.claude', 'skills')
    )
    .option('--type <type>', 'Skill type: basic|intermediate|advanced')
    .option(
      '--behavior <behavior>',
      'Behavioral classification: autonomous|guided|interactive|configurable'
    )
    .option('--scripts', 'Include a scripts/ directory')
    .option('-y, --yes', 'Auto-confirm overwrite if skill directory already exists')
    .action(
      async (name: string | undefined, opts: Record<string, string | boolean | undefined>) => {
        try {
          await createSkill(name, {
            output: opts['output'] as string | undefined,
            type: opts['type'] as string | undefined,
            behavior: opts['behavior'] as string | undefined,
            scripts: opts['scripts'] as boolean | undefined,
            yes: opts['yes'] as boolean | undefined,
          })
        } catch (error) {
          console.error(chalk.red('Error creating skill:'), sanitizeError(error))
          process.exit(1)
        }
      }
    )
}
