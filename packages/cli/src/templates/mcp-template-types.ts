/**
 * SMI-1433: MCP Server Template Types
 *
 * Type definitions for MCP server scaffolding.
 *
 * @module mcp-template-types
 */

/**
 * Input data for rendering MCP server templates
 */
export interface McpServerTemplateData {
  name: string
  description: string
  tools: McpToolDefinition[]
  author: string
}

/**
 * Tool definition for MCP server
 */
export interface McpToolDefinition {
  name: string
  description: string
  parameters?: McpParameterDefinition[]
}

/**
 * Parameter definition for MCP tool
 */
export interface McpParameterDefinition {
  name: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required?: boolean
}

/**
 * Dependency version constants for easier maintenance
 */
export const VERSIONS = {
  MCP_SDK: '^1.0.0',
  TYPES_NODE: '^20.0.0',
  TSX: '^4.0.0',
  TYPESCRIPT: '^5.0.0',
  NODE_ENGINE: '>=18.0.0',
} as const

/**
 * Type for version keys
 */
export type VersionKey = keyof typeof VERSIONS
