#!/usr/bin/env node
/**
 * Skillsmith MCP Server
 * Provides skill discovery, installation, and management tools
 *
 * @see SMI-792: Database initialization with tool context
 * @see SMI-XXXX: First-run integration and documentation delivery
 */

import { createRequire } from 'node:module'
import { exec } from 'child_process'

// ESM-compatible require for dynamic module resolution
const require = createRequire(import.meta.url)
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// SMI-2208: Use async context for WASM fallback support
import { getToolContextAsync, type ToolContext } from './context.js'
import { searchToolSchema } from './tools/search.js'
import { getSkillToolSchema } from './tools/get-skill.js'
import { installTool, installSkill } from './tools/install.js'
import { uninstallTool } from './tools/uninstall.js'
import { recommendToolSchema } from './tools/recommend.js'
import { validateToolSchema } from './tools/validate.js'
import { compareToolSchema } from './tools/compare.js'
import { suggestToolSchema } from './tools/suggest.js'
import { indexLocalToolSchema } from './tools/index-local.js'
import { publishToolSchema } from './tools/publish.js'
import { skillUpdatesToolSchema } from './tools/skill-updates.js'
import { skillDiffToolSchema } from './tools/skill-diff.js'
import { skillAuditToolSchema } from './tools/skill-audit.js'
import { dispatchToolCall } from './tool-dispatch.js'
import {
  isFirstRun,
  markFirstRunComplete,
  getWelcomeMessage,
  TIER1_SKILLS,
} from './onboarding/first-run.js'
import { checkForUpdates, formatUpdateNotification } from '@skillsmith/core'
import { createLicenseMiddleware } from './middleware/license.js'
import { createQuotaMiddleware } from './middleware/quota.js'

// Package version - keep in sync with package.json
const PACKAGE_VERSION = '0.4.0'
const PACKAGE_NAME = '@skillsmith/mcp-server'
import {
  installBundledSkills,
  installUserDocs,
  getUserGuidePath,
} from './onboarding/install-assets.js'

// SMI-2679: Quota enforcement middleware — module-level singletons, initialized once
// licenseMiddleware uses a cache (TTL) so the first-call @skillsmith/enterprise lazy-load
// latency (~10-50ms) is not incurred on every tool invocation.
const licenseMiddleware = createLicenseMiddleware()
const quotaMiddleware = createQuotaMiddleware()

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
  publishToolSchema,
  skillUpdatesToolSchema,
  skillDiffToolSchema,
  skillAuditToolSchema,
]

// Create server
const server = new Server(
  {
    name: 'skillsmith',
    version: '0.4.0',
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

// Handle tool calls — dispatch delegated to tool-dispatch.ts (SMI-skill-version-tracking Wave 2)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    return await dispatchToolCall(
      name,
      args as Record<string, unknown> | undefined,
      toolContext,
      licenseMiddleware,
      quotaMiddleware
    )
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
║    SKILLSMITH_FORCE_WASM=true to use WASM SQLite fallback    ║
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

  // SMI-2208: Initialize database asynchronously with WASM fallback
  // CRITICAL: Must complete before any tool handlers access toolContext
  try {
    toolContext = await getToolContextAsync()
    console.error(
      'Database initialized at:',
      process.env.SKILLSMITH_DB_PATH || '~/.skillsmith/skills.db'
    )
  } catch (error) {
    console.error('[skillsmith] Failed to initialize database:')
    console.error(error instanceof Error ? error.message : error)
    console.error('')
    console.error('Troubleshooting:')
    console.error('  - In Docker: Ensure container is running')
    console.error('  - On macOS: sql.js WASM should load automatically')
    console.error('  - Set SKILLSMITH_FORCE_WASM=true to use the WASM SQLite fallback')
    console.error('')
    process.exit(1)
  }

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
