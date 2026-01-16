/**
 * SMI-1433: MCP Server Scaffolding
 *
 * Initialize new MCP server projects with proper structure.
 */

import { Command } from 'commander'
import { input, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir, writeFile, stat } from 'fs/promises'
import { dirname, join, resolve } from 'path'

import { renderMcpServerTemplates, type McpToolDefinition } from '../../templates/index.js'
import { sanitizeError } from '../../utils/sanitize.js'

export interface McpInitOptions {
  output?: string | undefined
  tools?: string | undefined
  force?: boolean | undefined
}

/**
 * SMI-1433: Initialize a new MCP server project
 */
export async function initMcpServer(
  name: string | undefined,
  options: McpInitOptions
): Promise<void> {
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
