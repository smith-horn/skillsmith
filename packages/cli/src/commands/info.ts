/**
 * SMI-3672: Info Command — Display skill details with SKILL.md content
 *
 * Shows metadata + raw SKILL.md content for a given skill ID.
 * Uses local database with API fallback, same pattern as search command.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import {
  createDatabaseAsync,
  initializeSchema,
  SkillRepository,
  createApiClient,
} from '@skillsmith/core'
import { DEFAULT_DB_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'
import { displaySkillDetails } from './search-formatters.js'

interface InfoOptions {
  db: string
  raw: boolean
  json: boolean
}

/**
 * Create the `info` command
 */
export function createInfoCommand(): Command {
  return new Command('info')
    .description('Show full details and SKILL.md content for a skill')
    .argument('<skill-id>', 'Skill ID (e.g., "anthropic/commit")')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('--raw', 'Output only SKILL.md content (no metadata)')
    .option('--json', 'Output full JSON response')
    .action(async (skillId: string, options: InfoOptions) => {
      const spinner = ora('Looking up skill...').start()

      try {
        const db = await createDatabaseAsync(options.db)
        initializeSchema(db)
        const skillRepo = new SkillRepository(db)

        // Try local DB first
        const skill = skillRepo.findById(skillId)
        if (!skill) {
          spinner.fail(`Skill "${skillId}" not found`)
          process.exit(1)
        }

        // Fetch content from local DB (raw_content column)
        let content: string | undefined
        try {
          const row = db
            .prepare('SELECT raw_content FROM skills WHERE id = ?')
            .get(skillId) as { raw_content: string | null } | undefined
          content = row?.raw_content || undefined
        } catch {
          // raw_content column may not exist in pre-migration databases
          content = undefined
        }

        // Try API for content if not available locally
        if (!content) {
          try {
            const apiClient = createApiClient()
            if (!apiClient.isOffline()) {
              const apiResponse = await apiClient.getSkill(skillId, { includeContent: true })
              content = apiResponse.data.content || undefined
            }
          } catch {
            // API failed — continue without content
          }
        }

        spinner.stop()

        // JSON output
        if (options.json) {
          console.log(JSON.stringify({ skill, content: content || null }, null, 2))
          return
        }

        // Raw content only
        if (options.raw) {
          if (content) {
            console.log(content)
          } else {
            console.log(chalk.gray('No SKILL.md content available for this skill.'))
          }
          return
        }

        // Default: metadata + content
        displaySkillDetails({ skill, rank: 0, highlights: {} })

        if (content) {
          console.log(chalk.bold('\nSkill Content:'))
          console.log(chalk.dim('─'.repeat(60)))
          console.log(content)
          console.log(chalk.dim('─'.repeat(60)))
        } else {
          console.log(chalk.gray('\nNo SKILL.md content available for this skill.'))
        }
      } catch (error) {
        spinner.fail('Failed to retrieve skill info')
        console.error(sanitizeError(error))
        process.exit(1)
      }
    })
}
