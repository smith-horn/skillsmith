/**
 * MCP tool-call parsing + error classification (SMI-5309).
 *
 * Extracted from McpClient.ts to keep that file under the 500-line hard gate
 * before Epic D adds wrappers. `McpClient.callTool<T>` is now a thin delegate to
 * `callMcpTool<T>` here, passing its connection status + a `send` closure so the
 * exact test seam (set private `status='connected'`, stub private `sendRequest`)
 * is preserved.
 */
import { McpToolError, type McpToolErrorCode } from './McpToolError.js'

/**
 * SMI-5288: Classify the text of an `isError` MCP tool response into an
 * `McpToolErrorCode`. Tier/plan denials and unknown-tool errors get specific
 * codes so command handlers can branch without string-matching messages.
 *
 * NOTE (SMI-5322): `not found` currently maps to `UnknownTool` — this is a
 * tested contract (`__tests__/mcp/uninstall_skill.test.ts`). A precise
 * `SkillNotFound` code is tracked separately; do not change this here.
 */
export function classifyIsErrorText(errorText: string): McpToolErrorCode {
  if (/tier|plan|denied|forbidden|upgrade/i.test(errorText)) {
    return 'TierDenied'
  }
  if (/unknown tool|not found|no such tool/i.test(errorText)) {
    return 'UnknownTool'
  }
  return 'Unknown'
}

/**
 * Call an MCP tool with defensive response parsing. Throws `McpToolError` on any
 * non-success response (not connected, invalid envelope, isError, unparseable).
 *
 * @param name  MCP tool name (e.g. `skill_compare`)
 * @param args  tool arguments object
 * @param opts.connected  whether the client is currently connected
 * @param opts.send  sends a JSON-RPC request and resolves with `result`
 */
export async function callMcpTool<T>(
  name: string,
  args: Record<string, unknown>,
  opts: {
    connected: boolean
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  }
): Promise<T> {
  if (!opts.connected) {
    throw new McpToolError(name, 'NotConnected', 'MCP client not connected')
  }

  const raw = await opts.send('tools/call', { name, arguments: args })

  const result = raw as Record<string, unknown> | null | undefined
  if (!result || typeof result !== 'object') {
    throw new McpToolError(
      name,
      'InvalidResponse',
      `Invalid MCP response: expected object, got ${typeof raw}`
    )
  }

  const content = result['content']
  if (!Array.isArray(content) || content.length === 0) {
    throw new McpToolError(
      name,
      'InvalidResponse',
      'Invalid MCP response: missing or empty content array'
    )
  }

  if (result['isError']) {
    const errorText = (content[0] as { text?: string })?.text || 'Unknown error'
    throw new McpToolError(name, classifyIsErrorText(errorText), errorText)
  }

  const text = (content[0] as { text?: string })?.text
  if (!text) {
    throw new McpToolError(name, 'InvalidResponse', 'Empty response from MCP server')
  }

  try {
    return JSON.parse(text) as T
  } catch (parseError) {
    throw new McpToolError(
      name,
      'InvalidResponse',
      `Failed to parse MCP response as JSON: ${parseError instanceof Error ? parseError.message : 'unknown error'}`
    )
  }
}
