import { describe, it, expect, vi } from 'vitest'

vi.mock('vscode', () => ({
  Disposable: class {
    constructor(private cb: () => void) {}
    dispose() {
      this.cb()
    }
  },
}))

import { McpClient } from '../../mcp/McpClient.js'
import { McpToolError } from '../../mcp/McpToolError.js'

/** Wrap a JSON payload in the MCP tools/call success envelope. */
function ok(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** Build an isError tools/call envelope with the given text. */
function isErr(text: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * Returns a connected McpClient whose private `sendRequest` resolves to `raw`.
 * Tests only — reaches into private members via an `any` cast.
 */
function connectedClient(raw: unknown): McpClient {
  const client = new McpClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(client as any).status = 'connected'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(client as any).sendRequest = vi.fn().mockResolvedValue(raw)
  return client
}

describe('McpClient.search (SMI-5288)', () => {
  it('happy path returns the typed McpSearchResponse shape', async () => {
    const response = {
      results: [
        {
          id: 'a/b',
          name: 'B',
          description: 'd',
          author: 'a',
          category: 'c',
          trustTier: 'verified',
          score: 90,
        },
      ],
      total: 1,
      query: 'b',
      filters: {},
      timing: { searchMs: 1, totalMs: 2 },
    }
    const client = connectedClient(ok(response))

    const result = await client.search('b')

    expect(result.total).toBe(1)
    expect(result.results[0]?.id).toBe('a/b')
  })

  it('tier-denied isError response throws McpToolError code TierDenied', async () => {
    const client = connectedClient(isErr('TierDenied: requires the Team plan'))
    await expect(client.search('b')).rejects.toMatchObject({
      name: 'McpToolError',
      code: 'TierDenied',
      toolName: 'search',
    })
  })

  it('unknown-tool isError response throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('Unknown tool: search'))
    await expect(client.search('b')).rejects.toMatchObject({ code: 'UnknownTool' })
  })

  it('calling before connect throws NotConnected with the exact message', async () => {
    const client = new McpClient()
    await expect(client.search('b')).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(client.search('b')).rejects.toBeInstanceOf(McpToolError)
  })
})
