/**
 * SMI-1433: MCP Server Template Handlers
 *
 * Code generation helpers for MCP server scaffolding.
 *
 * @module mcp-template-handlers
 */

import type { McpToolDefinition } from './mcp-template-types.js'

/**
 * Escape single quotes in strings for safe template interpolation
 */
export function escapeQuotes(str: string): string {
  return str.replace(/'/g, "\\'")
}

/**
 * Generate tool definition code for a single tool
 */
export function generateToolDefinition(tool: McpToolDefinition, indent: string = '  '): string {
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
export function generateToolCase(tool: McpToolDefinition): string {
  const handlerName = `handle${tool.name.charAt(0).toUpperCase()}${tool.name.slice(1).replace(/-/g, '')}Tool`
  const argsType = `${tool.name.charAt(0).toUpperCase()}${tool.name.slice(1).replace(/-/g, '')}ToolArgs`
  return `    case '${tool.name}':
      return ${handlerName}(args as unknown as ${argsType})`
}

/**
 * Generate tool import statement
 */
export function generateToolImport(tool: McpToolDefinition): string {
  const baseName = tool.name.charAt(0).toUpperCase() + tool.name.slice(1).replace(/-/g, '')
  return `import { handle${baseName}Tool, type ${baseName}ToolArgs } from './${tool.name}.js'`
}

/**
 * Generate a stub implementation file for a custom tool
 */
export function generateToolImplementation(tool: McpToolDefinition): string {
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
export function generateToolDocs(tools: McpToolDefinition[]): string {
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
