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

function ok(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function isErr(text: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text }] }
}

function connectedClient(raw: unknown): McpClient {
  const client = new McpClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(client as any).status = 'connected'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(client as any).sendRequest = vi.fn().mockResolvedValue(raw)
  return client
}

describe('McpClient.uninstallSkill (SMI-5288)', () => {
  it('happy path returns the typed McpUninstallResponse shape', async () => {
    const response = { success: true, skillId: 'a/b' }
    const client = connectedClient(ok(response))

    const result = await client.uninstallSkill('a/b')

    expect(result.success).toBe(true)
    expect(result.skillId).toBe('a/b')
  })

  it('tier-denied isError response throws McpToolError code TierDenied', async () => {
    const client = connectedClient(isErr('denied: requires the Team plan'))
    await expect(client.uninstallSkill('a/b')).rejects.toMatchObject({
      code: 'TierDenied',
      toolName: 'uninstall_skill',
    })
  })

  it('unknown-tool isError response throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('tool not found'))
    await expect(client.uninstallSkill('a/b')).rejects.toMatchObject({ code: 'UnknownTool' })
  })

  it('calling before connect throws NotConnected with the exact message', async () => {
    const client = new McpClient()
    await expect(client.uninstallSkill('a/b')).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(client.uninstallSkill('a/b')).rejects.toBeInstanceOf(McpToolError)
  })
})
