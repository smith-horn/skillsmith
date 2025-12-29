/**
 * Skillsmith MCP Server
 * Provides skill discovery, installation, and management tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { searchToolSchema, executeSearch, type SearchInput } from './tools/search.js'
import { getSkillToolSchema, executeGetSkill, type GetSkillInput } from './tools/get-skill.js'
import { installTool, installSkill, installInputSchema } from './tools/install.js'
import { uninstallTool, uninstallSkill, uninstallInputSchema } from './tools/uninstall.js'
import { recommendToolSchema, recommendInputSchema, executeRecommend } from './tools/recommend.js'
import { validateToolSchema, validateInputSchema, executeValidate } from './tools/validate.js'
import { compareToolSchema, compareInputSchema, executeCompare } from './tools/compare.js'

// Tool definitions for MCP
const toolDefinitions = [
  searchToolSchema,
  getSkillToolSchema,
  installTool,
  uninstallTool,
  recommendToolSchema,
  validateToolSchema,
  compareToolSchema,
]

// Create server
const server = new Server(
  {
    name: 'skillsmith',
    version: '0.1.0',
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
        const result = await executeSearch(input)
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
        const result = await executeGetSkill(input)
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
        const result = await installSkill(input)
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
        const result = await uninstallSkill(input)
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
        const result = await executeRecommend(input)
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
        const result = await executeValidate(input)
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
        const result = await executeCompare(input)
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

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Skillsmith MCP server running')
}

main().catch(console.error)
