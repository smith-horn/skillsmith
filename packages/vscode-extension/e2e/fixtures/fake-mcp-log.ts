/**
 * Shared reader for the fake MCP server's JSONL call log (SMI-5331).
 *
 * The fake server (a child of the VS Code extension host) appends one JSON object
 * per received tool call / notification; specs (in the wdio runner) read it back to
 * assert what the extension actually sent and to sequence on server (re)starts. See
 * fake-mcp-log-path.mjs for why the path is location-derived rather than
 * os.tmpdir-based. Keeps the parse logic in one place as Phase 2b adds more specs.
 */
import { readFileSync } from 'node:fs'
import { FAKE_MCP_LOG } from './fake-mcp-log-path.mjs'

/** Parse the fake MCP server's JSONL call log (empty array if not yet written). */
export function readFakeMcpLog(): Array<Record<string, unknown>> {
  try {
    return readFileSync(FAKE_MCP_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null)
  } catch {
    return []
  }
}
