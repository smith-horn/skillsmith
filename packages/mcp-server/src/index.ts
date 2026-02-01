#!/usr/bin/env node
/**
 * Skillsmith MCP Server
 * Provides skill discovery, installation, and management tools
 *
 * @see SMI-792: Database initialization with tool context
 * @see SMI-XXXX: First-run integration and documentation delivery
 */

import { exec } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { getToolContext, type ToolContext } from './context.js'
import { searchToolSchema, executeSearch, type SearchInput } from './tools/search.js'
import { getSkillToolSchema, executeGetSkill, type GetSkillInput } from './tools/get-skill.js'
import { installTool, installSkill, installInputSchema } from './tools/install.js'
import { uninstallTool, uninstallSkill, uninstallInputSchema } from './tools/uninstall.js'
import { recommendToolSchema, recommendInputSchema, executeRecommend } from './tools/recommend.js'
import { validateToolSchema, validateInputSchema, executeValidate } from './tools/validate.js'
import { compareToolSchema, compareInputSchema, executeCompare } from './tools/compare.js'
import { suggestToolSchema, suggestInputSchema, executeSuggest } from './tools/suggest.js'
import {
  indexLocalToolSchema,
  indexLocalInputSchema,
  executeIndexLocal,
} from './tools/index-local.js'
import {
  isFirstRun,
  markFirstRunComplete,
  getWelcomeMessage,
  TIER1_SKILLS,
} from './onboarding/first-run.js'
import { checkForUpdates, formatUpdateNotification } from '@skillsmith/core'

// Package version - keep in sync with package.json
const PACKAGE_VERSION = '0.3.13'
const PACKAGE_NAME = '@skillsmith/mcp-server'
import {
  installBundledSkills,
  installUserDocs,
  getUserGuidePath,
} from './onboarding/install-assets.js'

// Initialize tool context with database connection
let toolContext: ToolContext

// Tool definitions for MCP
const toolDefinitions = [
  searchToolSchema,
  getSkillToolSchema,
  installTool,
  uninstallTool,
  recommendToolSchema,
  validateToolSchema,
  compareToolSchema,
  suggestToolSchema,
  indexLocalToolSchema,
]

// Create server
const server = new Server(
  {
    name: 'skillsmith',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }
})

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'search': {
        const input = (args ?? {}) as unknown as SearchInput
        const result = await executeSearch(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      case 'get_skill': {
        const input = (args ?? {}) as unknown as GetSkillInput
        const result = await executeGetSkill(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      case 'install_skill': {
        const input = installInputSchema.parse(args)
        const result = await installSkill(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      case 'uninstall_skill': {
        const input = uninstallInputSchema.parse(args)
        const result = await uninstallSkill(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      case 'skill_recommend': {
        const input = recommendInputSchema.parse(args)
        const result = await executeRecommend(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      case 'skill_validate': {
        const input = validateInputSchema.parse(args)
        const result = await executeValidate(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      case 'skill_compare': {
        const input = compareInputSchema.parse(args)
        const result = await executeCompare(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      case 'skill_suggest': {
        const input = suggestInputSchema.parse(args)
        const result = await executeSuggest(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      case 'index_local': {
        const input = indexLocalInputSchema.parse(args)
        const result = await executeIndexLocal(input, toolContext)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }

      default:
        throw new Error('Unknown tool: ' + name)
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: ' + (error instanceof Error ? error.message : 'Unknown error'),
        },
      ],
      isError: true,
    }
  }
})

/**
 * Handle --docs flag to open user documentation
 */
function handleDocsFlag(): void {
  const userGuidePath = getUserGuidePath()
  const onlineDocsUrl = 'https://skillsmith.app/docs'

  if (userGuidePath) {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} "${userGuidePath}"`)
    console.log(`Opening documentation: ${userGuidePath}`)
  } else {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} "${onlineDocsUrl}"`)
    console.log(`Opening online documentation: ${onlineDocsUrl}`)
  }
  process.exit(0)
}

/**
 * Run first-time setup: install bundled skills and Tier 1 skills from registry
 */
async function runFirstTimeSetup(): Promise<void> {
  console.error('[skillsmith] First run detected, installing essentials...')

  // Install bundled skills (skillsmith documentation skill)
  const bundledSkills = installBundledSkills()

  // Install user documentation
  installUserDocs()

  // Install Tier 1 skills from registry
  const registrySkills: string[] = []
  for (const skill of TIER1_SKILLS) {
    try {
      await installSkill(
        { skillId: skill.id, force: false, skipScan: false, skipOptimize: false },
        toolContext
      )
      registrySkills.push(skill.name)
      console.error(`[skillsmith] Installed: ${skill.name}`)
    } catch (error) {
      console.error(
        `[skillsmith] Failed to install ${skill.name}:`,
        error instanceof Error ? error.message : 'Unknown error'
      )
    }
  }

  // Mark first run as complete
  markFirstRunComplete()

  // Show welcome message
  const allSkills = [...bundledSkills, ...registrySkills]
  console.error(getWelcomeMessage(allSkills))
}

/**
 * SMI-2163: Startup diagnostics for common installation issues
 * Detects native module problems and provides actionable error messages
 */
function runStartupDiagnostics(): void {
  // Check for native module issues by attempting dynamic import simulation
  // The actual check happens when @skillsmith/core loads better-sqlite3
  try {
    // Verify core module can be loaded (will fail if native modules broken)
    require.resolve('@skillsmith/core')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)

    if (msg.includes('NODE_MODULE_VERSION')) {
      console.error(`
╔══════════════════════════════════════════════════════════════╗
║  Skillsmith: Native Module Version Mismatch                  ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Your Node.js version (${process.version.padEnd(10)}) doesn't match the       ║
║  pre-compiled native modules.                                ║
║                                                              ║
║  To fix, run one of:                                         ║
║                                                              ║
║    npm rebuild better-sqlite3                                ║
║                                                              ║
║  Or reinstall completely:                                    ║
║                                                              ║
║    npm uninstall @skillsmith/mcp-server                      ║
║    npm install @skillsmith/mcp-server                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`)
      process.exit(1)
    }

    if (msg.includes('GLIBC') || msg.includes('libc') || msg.includes('GLIBCXX')) {
      console.error(`
╔══════════════════════════════════════════════════════════════╗
║  Skillsmith: Missing System Library (glibc)                  ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Native modules require glibc which is not available on      ║
║  Alpine Linux or some minimal containers.                    ║
║                                                              ║
║  Options:                                                    ║
║    1. Use a Debian/Ubuntu-based environment                  ║
║    2. Use Docker: docker run -it node:22 npx @skillsmith/... ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`)
      process.exit(1)
    }

    if (msg.includes('invalid ELF header')) {
      console.error(`
╔══════════════════════════════════════════════════════════════╗
║  Skillsmith: Architecture Mismatch                           ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Native modules were compiled for a different architecture.  ║
║                                                              ║
║  This can happen when:                                       ║
║    - Copying node_modules between machines                   ║
║    - Running x86 modules on ARM (or vice versa)              ║
║                                                              ║
║  To fix, reinstall:                                          ║
║                                                              ║
║    rm -rf node_modules                                       ║
║    npm install                                               ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`)
      process.exit(1)
    }

    // Unknown module resolution error - log but don't exit
    // The actual error will surface when the module is used
    console.error(`[Skillsmith] Warning: Could not resolve @skillsmith/core: ${msg}`)
  }
}

// Start server
async function main() {
  // SMI-2163: Run startup diagnostics before anything else
  runStartupDiagnostics()

  // Handle --docs flag
  if (process.argv.includes('--docs') || process.argv.includes('-d')) {
    handleDocsFlag()
    return
  }

  // Initialize database and services
  toolContext = getToolContext()
  console.error(
    'Database initialized at:',
    process.env.SKILLSMITH_DB_PATH || '~/.skillsmith/skills.db'
  )

  // Run first-time setup if needed
  if (isFirstRun()) {
    await runFirstTimeSetup()
  }

  // SMI-1952: Auto-update check (non-blocking)
  if (process.env.SKILLSMITH_AUTO_UPDATE_CHECK !== 'false') {
    checkForUpdates(PACKAGE_NAME, PACKAGE_VERSION)
      .then((result) => {
        if (result?.updateAvailable) {
          console.error(formatUpdateNotification(result))
        }
      })
      .catch(() => {
        // Silent failure - don't block server startup
      })
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Skillsmith MCP server running')
}

main().catch(console.error)
