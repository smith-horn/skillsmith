/**
 * Singleton accessor for the shared {@link McpClient} instance.
 *
 * Split out of `McpClient.ts` (SMI-5325) to keep that file under the 500-line
 * pre-commit gate as new tool wrappers are added. `McpClient.ts` re-exports
 * these for back-compat, so existing `import { getMcpClient } from './McpClient.js'`
 * sites are unaffected.
 *
 * Circular-import safety: this module imports the `McpClient` *class* from
 * `./McpClient.js`, and `McpClient.ts` re-exports the functions below. The
 * class binding is referenced only inside these function bodies (which run at
 * call time, long after both modules finish evaluating), never at module-eval
 * time — so the cycle never hits a TDZ. esbuild/ESM resolve it cleanly.
 */
import { McpClient } from './McpClient.js'
import type { McpClientConfig } from './types.js'

/** Singleton MCP client instance. */
let mcpClientInstance: McpClient | null = null

/** Get the singleton MCP client instance. */
export function getMcpClient(): McpClient {
  if (!mcpClientInstance) {
    mcpClientInstance = new McpClient()
  }
  return mcpClientInstance
}

/** Initialize the MCP client with custom configuration. */
export function initializeMcpClient(config?: Partial<McpClientConfig>): McpClient {
  if (mcpClientInstance) {
    mcpClientInstance.disconnect()
  }
  mcpClientInstance = new McpClient(config)
  return mcpClientInstance
}

/** Dispose the MCP client. */
export function disposeMcpClient(): void {
  if (mcpClientInstance) {
    mcpClientInstance.disconnect()
    mcpClientInstance = null
  }
}
