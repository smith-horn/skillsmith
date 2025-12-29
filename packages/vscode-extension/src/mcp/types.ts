/**
 * MCP Client Type Definitions
 * Types for communicating with the Skillsmith MCP server
 */

/**
 * Skill search result from MCP search tool
 */
export interface McpSkillSearchResult {
  id: string
  name: string
  description: string
  author: string
  category: string
  trustTier: 'verified' | 'community' | 'standard' | 'unverified'
  score: number
}

/**
 * Search filters for MCP search tool
 */
export interface McpSearchFilters {
  category?: string
  trustTier?: string
  minScore?: number
}

/**
 * Response from MCP search tool
 */
export interface McpSearchResponse {
  results: McpSkillSearchResult[]
  total: number
  query: string
  filters: McpSearchFilters
  timing: {
    searchMs: number
    totalMs: number
  }
}

/**
 * Score breakdown for a skill
 */
export interface McpScoreBreakdown {
  quality: number
  popularity: number
  maintenance: number
  security: number
  documentation: number
}

/**
 * Full skill details from MCP get_skill tool
 */
export interface McpSkillDetails {
  id: string
  name: string
  description: string
  author: string
  repository?: string
  version?: string
  category: string
  trustTier: 'verified' | 'community' | 'standard' | 'unverified'
  score: number
  scoreBreakdown?: McpScoreBreakdown
  tags?: string[]
  installCommand?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Response from MCP get_skill tool
 */
export interface McpGetSkillResponse {
  skill: McpSkillDetails
  installCommand: string
  timing: {
    totalMs: number
  }
}

/**
 * Security scan finding
 */
export interface McpSecurityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  message: string
  line?: number
}

/**
 * Security scan report
 */
export interface McpSecurityReport {
  passed: boolean
  findings: McpSecurityFinding[]
  scannedAt: string
}

/**
 * Response from MCP install_skill tool
 */
export interface McpInstallResponse {
  success: boolean
  skillId: string
  installPath: string
  securityReport?: McpSecurityReport
  tips?: string[]
  error?: string
}

/**
 * Response from MCP uninstall_skill tool
 */
export interface McpUninstallResponse {
  success: boolean
  skillId: string
  error?: string
}

/**
 * MCP connection status
 */
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * MCP tool call parameters
 */
export interface McpToolCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * MCP tool result content
 */
export interface McpToolResultContent {
  type: 'text'
  text: string
}

/**
 * MCP tool result
 */
export interface McpToolResult {
  content: McpToolResultContent[]
  isError?: boolean
}

/**
 * Configuration for MCP client
 * @public Exported for use in extension settings
 */
export interface McpClientConfig {
  /** Path to the MCP server executable or command */
  serverCommand: string
  /** Arguments for the server command */
  serverArgs: string[]
  /** Connection timeout in milliseconds */
  connectionTimeout: number
  /** Whether to auto-reconnect on disconnect */
  autoReconnect: boolean
  /** Maximum reconnection attempts */
  maxReconnectAttempts: number
}

/**
 * Default MCP client configuration
 */
export const DEFAULT_MCP_CONFIG: McpClientConfig = {
  serverCommand: 'npx',
  serverArgs: ['@skillsmith/mcp-server'],
  connectionTimeout: 30000,
  autoReconnect: true,
  maxReconnectAttempts: 3,
}
