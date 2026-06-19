/**
 * JSON-RPC 2.0 envelope types for the MCP stdio transport.
 *
 * Extracted from McpClient.ts (SMI-5318 / PR-D3) as a leaf module to keep
 * McpClient.ts under the 500-line gate. Leaf — imports nothing from McpClient,
 * so there is no import cycle.
 */

/**
 * JSON-RPC request structure
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown> | undefined
}

/**
 * JSON-RPC response structure
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}
