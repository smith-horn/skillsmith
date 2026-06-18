/**
 * Structured error thrown by `McpClient.callTool` on any non-success MCP
 * response (SMI-5288). Command-level handlers branch on `.code` instead of
 * string-matching `.message` — see McpClient.patterns.md § 3.
 */
export type McpToolErrorCode =
  | 'TierDenied'
  | 'UnknownTool'
  | 'NotConnected'
  | 'InvalidResponse'
  | 'Unknown'

export class McpToolError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly code: McpToolErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'McpToolError'
  }
}
