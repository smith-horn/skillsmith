/**
 * SMI-1433: MCP Server Template
 *
 * Templates for scaffolding TypeScript MCP servers with stdio transport.
 * Generated servers are npx-ready and follow @modelcontextprotocol/sdk patterns.
 *
 * @example Basic Usage
 * ```typescript
 * import { renderMcpServerTemplates } from './mcp-server.template.js'
 *
 * const files = renderMcpServerTemplates({
 *   name: 'my-mcp-server',
 *   description: 'Does cool things',
 *   author: 'developer',
 *   tools: []
 * })
 *
 * // files is a Map<string, string> of file paths to content
 * // Keys: package.json, tsconfig.json, src/index.ts, src/server.ts,
 * //       src/tools/index.ts, src/tools/example.ts, README.md, .gitignore
 * ```
 *
 * @example With Custom Tools
 * ```typescript
 * const files = renderMcpServerTemplates({
 *   name: 'slack-mcp',
 *   description: 'Slack integration MCP server',
 *   author: 'team',
 *   tools: [
 *     {
 *       name: 'send_message',
 *       description: 'Send a Slack message',
 *       parameters: [
 *         { name: 'channel', type: 'string', description: 'Channel ID', required: true },
 *         { name: 'text', type: 'string', description: 'Message text', required: true }
 *       ]
 *     }
 *   ]
 * })
 * ```
 *
 * @module mcp-server-template
 */

export interface McpServerTemplateData {
  name: string
  description: string
  tools: McpToolDefinition[]
  author: string
}

export interface McpToolDefinition {
  name: string
  description: string
  parameters?: McpParameterDefinition[]
}

export interface McpParameterDefinition {
  name: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required?: boolean
}

/**
 * Dependency version constants for easier maintenance
 */
const VERSIONS = {
  MCP_SDK: '^1.0.0',
  TYPES_NODE: '^20.0.0',
  TSX: '^4.0.0',
  TYPESCRIPT: '^5.0.0',
  NODE_ENGINE: '>=18.0.0',
} as const

/**
 * package.json template for MCP server
 */
export const PACKAGE_JSON_TEMPLATE = `{
  "name": "{{name}}",
  "version": "0.1.0",
  "description": "{{description}}",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "{{name}}": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "watch": "tsc --watch",
    "prepublishOnly": "npm run build"
  },
  "keywords": [
    "mcp",
    "mcp-server",
    "claude",
    "ai"
  ],
  "author": "{{author}}",
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "${VERSIONS.MCP_SDK}"
  },
  "devDependencies": {
    "@types/node": "${VERSIONS.TYPES_NODE}",
    "tsx": "${VERSIONS.TSX}",
    "typescript": "${VERSIONS.TYPESCRIPT}"
  },
  "engines": {
    "node": "${VERSIONS.NODE_ENGINE}"
  }
}
`

/**
 * tsconfig.json template for MCP server
 */
export const TSCONFIG_JSON_TEMPLATE = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
`

/**
 * Main entry point (src/index.ts) template
 */
export const INDEX_TS_TEMPLATE = `#!/usr/bin/env node
/**
 * {{name}} - MCP Server
 *
 * {{description}}
 */

import { createServer, createTransport } from './server.js'

async function main(): Promise<void> {
  const server = createServer()
  const transport = createTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('Server error:', error)
  process.exit(1)
})
`

/**
 * Server setup (src/server.ts) template
 */
export const SERVER_TS_TEMPLATE = `/**
 * MCP Server Configuration
 *
 * Sets up the MCP server with tool handlers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { tools, handleToolCall } from './tools/index.js'

/**
 * Create and configure the MCP server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: '{{name}}',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools }
  })

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      const result = await handleToolCall(name, args || {})
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text', text: \`Error: \${message}\` }],
        isError: true,
      }
    }
  })

  return server
}

/**
 * Create a stdio transport for the server
 */
export function createTransport(): StdioServerTransport {
  return new StdioServerTransport()
}
`

/**
 * Tools index (src/tools/index.ts) template
 */
export const TOOLS_INDEX_TS_TEMPLATE = `/**
 * Tool Definitions and Handlers
 *
 * Register your MCP tools here.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js'
{{toolImports}}

/**
 * Tool definitions exposed by this MCP server
 */
export const tools: Tool[] = [
{{toolDefinitions}}
]

/**
 * Route tool calls to appropriate handlers
 */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
{{toolCases}}
    default:
      throw new Error(\`Unknown tool: \${name}\`)
  }
}
`

/**
 * Example tool implementation template
 */
export const EXAMPLE_TOOL_TS_TEMPLATE = `/**
 * Example Tool Implementation
 *
 * This is a sample tool to demonstrate the pattern.
 * Replace with your actual tool logic.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js'

export const exampleToolDefinition: Tool = {
  name: 'example',
  description: 'An example tool that echoes input',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Message to echo back',
      },
    },
    required: ['message'],
  },
}

export interface ExampleToolArgs {
  message: string
}

export async function handleExampleTool(args: ExampleToolArgs): Promise<string> {
  return \`Echo: \${args.message}\`
}
`

/**
 * README.md template for MCP server
 */
export const MCP_README_TEMPLATE = `# {{name}}

{{description}}

## Installation

\`\`\`bash
npm install -g {{name}}
\`\`\`

Or use directly with npx:

\`\`\`bash
npx {{name}}
\`\`\`

## Configuration

Add to your Claude configuration (\`~/.claude/settings.json\`):

\`\`\`json
{
  "mcpServers": {
    "{{name}}": {
      "command": "npx",
      "args": ["-y", "{{name}}"]
    }
  }
}
\`\`\`

## Available Tools

{{toolDocs}}

## Development

\`\`\`bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
\`\`\`

## License

MIT
`

/**
 * .gitignore template for MCP server
 */
export const MCP_GITIGNORE_TEMPLATE = `# Dependencies
node_modules/

# Build output
dist/

# Environment
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Test coverage
coverage/
`

/**
 * Escape single quotes in strings for safe template interpolation
 */
function escapeQuotes(str: string): string {
  return str.replace(/'/g, "\\'")
}

/**
 * Generate tool definition code for a single tool
 */
function generateToolDefinition(tool: McpToolDefinition, indent: string = '  '): string {
  const properties: string[] = []
  const required: string[] = []

  for (const param of tool.parameters || []) {
    properties.push(`${indent}      ${param.name}: {
${indent}        type: '${param.type}',
${indent}        description: '${escapeQuotes(param.description)}',
${indent}      },`)
    if (param.required) {
      required.push(`'${param.name}'`)
    }
  }

  const propertiesStr = properties.length > 0 ? properties.join('\n') : ''
  const requiredStr =
    required.length > 0 ? `\n${indent}    required: [${required.join(', ')}],` : ''

  return `${indent}{
${indent}  name: '${escapeQuotes(tool.name)}',
${indent}  description: '${escapeQuotes(tool.description)}',
${indent}  inputSchema: {
${indent}    type: 'object',
${indent}    properties: {
${propertiesStr}
${indent}    },${requiredStr}
${indent}  },
${indent}},`
}

/**
 * Generate tool handler case for switch statement
 */
function generateToolCase(tool: McpToolDefinition): string {
  const handlerName = `handle${tool.name.charAt(0).toUpperCase()}${tool.name.slice(1).replace(/-/g, '')}Tool`
  const argsType = `${tool.name.charAt(0).toUpperCase()}${tool.name.slice(1).replace(/-/g, '')}ToolArgs`
  return `    case '${tool.name}':
      return ${handlerName}(args as unknown as ${argsType})`
}

/**
 * Generate tool import statement
 */
function generateToolImport(tool: McpToolDefinition): string {
  const baseName = tool.name.charAt(0).toUpperCase() + tool.name.slice(1).replace(/-/g, '')
  return `import { handle${baseName}Tool, type ${baseName}ToolArgs } from './${tool.name}.js'`
}

/**
 * Generate a stub implementation file for a custom tool
 */
function generateToolImplementation(tool: McpToolDefinition): string {
  const baseName = tool.name.charAt(0).toUpperCase() + tool.name.slice(1).replace(/-/g, '')
  const params = tool.parameters || []

  // Generate TypeScript interface properties
  const interfaceProps = params
    .map((p) => {
      const tsType =
        p.type === 'array' ? 'unknown[]' : p.type === 'object' ? 'Record<string, unknown>' : p.type
      return `  ${p.name}${p.required ? '' : '?'}: ${tsType}`
    })
    .join('\n')

  // Generate implementation placeholder
  const returnPlaceholder =
    params.length > 0
      ? `\`${tool.name} called with: \${JSON.stringify({ ${params.map((p) => `${p.name}: args.${p.name}`).join(', ')} })}\``
      : `'${tool.name} called'`

  return `/**
 * ${baseName} Tool Implementation
 *
 * ${escapeQuotes(tool.description)}
 * TODO: Implement your tool logic here.
 */

export interface ${baseName}ToolArgs {
${interfaceProps || '  // No parameters'}
}

export async function handle${baseName}Tool(args: ${baseName}ToolArgs): Promise<string> {
  // TODO: Implement ${tool.name} logic
  return ${returnPlaceholder}
}
`
}

/**
 * Generate tool documentation for README
 */
function generateToolDocs(tools: McpToolDefinition[]): string {
  if (tools.length === 0) {
    return '- `example` - An example tool that echoes input'
  }

  return tools
    .map((tool) => {
      const params = tool.parameters?.map((p) => `\`${p.name}\``).join(', ') || 'none'
      return `- \`${tool.name}\` - ${tool.description}\n  - Parameters: ${params}`
    })
    .join('\n')
}

/**
 * Render MCP server templates
 */
export function renderMcpServerTemplates(data: McpServerTemplateData): Map<string, string> {
  const files = new Map<string, string>()

  // Use example tool if no tools specified
  const toolsToUse =
    data.tools.length > 0
      ? data.tools
      : [
          {
            name: 'example',
            description: 'An example tool that echoes input',
            parameters: [
              {
                name: 'message',
                type: 'string' as const,
                description: 'Message to echo back',
                required: true,
              },
            ],
          },
        ]

  // Generate tool-specific code
  const toolImports = toolsToUse.map(generateToolImport).join('\n')
  const toolDefinitions = toolsToUse.map((t) => generateToolDefinition(t)).join('\n')
  const toolCases = toolsToUse.map(generateToolCase).join('\n')
  const toolDocs = generateToolDocs(data.tools)

  // package.json
  files.set(
    'package.json',
    PACKAGE_JSON_TEMPLATE.replace(/\{\{name\}\}/g, data.name)
      .replace(/\{\{description\}\}/g, data.description)
      .replace(/\{\{author\}\}/g, data.author)
  )

  // tsconfig.json
  files.set('tsconfig.json', TSCONFIG_JSON_TEMPLATE)

  // src/index.ts
  files.set(
    'src/index.ts',
    INDEX_TS_TEMPLATE.replace(/\{\{name\}\}/g, data.name).replace(
      /\{\{description\}\}/g,
      data.description
    )
  )

  // src/server.ts
  files.set('src/server.ts', SERVER_TS_TEMPLATE.replace(/\{\{name\}\}/g, data.name))

  // src/tools/index.ts
  files.set(
    'src/tools/index.ts',
    TOOLS_INDEX_TS_TEMPLATE.replace(/\{\{toolImports\}\}/g, toolImports)
      .replace(/\{\{toolDefinitions\}\}/g, toolDefinitions)
      .replace(/\{\{toolCases\}\}/g, toolCases)
  )

  // Generate tool implementation files
  if (data.tools.length > 0) {
    // Generate stub implementations for custom tools
    for (const tool of data.tools) {
      files.set(`src/tools/${tool.name}.ts`, generateToolImplementation(tool))
    }
    // Include example.ts as reference
    files.set('src/tools/example.ts', EXAMPLE_TOOL_TS_TEMPLATE)
  } else {
    // No custom tools - just use example tool (already imported in index.ts)
    files.set('src/tools/example.ts', EXAMPLE_TOOL_TS_TEMPLATE)
  }

  // README.md
  files.set(
    'README.md',
    MCP_README_TEMPLATE.replace(/\{\{name\}\}/g, data.name)
      .replace(/\{\{description\}\}/g, data.description)
      .replace(/\{\{toolDocs\}\}/g, toolDocs)
  )

  // .gitignore
  files.set('.gitignore', MCP_GITIGNORE_TEMPLATE)

  return files
}
