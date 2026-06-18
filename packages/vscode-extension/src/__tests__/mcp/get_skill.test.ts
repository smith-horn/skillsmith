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

describe('McpClient.getSkill (SMI-5288)', () => {
  it('happy path returns the typed McpGetSkillResponse shape', async () => {
    const response = {
      skill: {
        id: 'a/b',
        name: 'B',
        description: 'd',
        author: 'a',
        category: 'c',
        trustTier: 'verified',
        score: 90,
      },
      installCommand: 'npx @skillsmith/cli install a/b',
      timing: { totalMs: 5 },
    }
    const client = connectedClient(ok(response))

    const result = await client.getSkill('a/b')

    expect(result.skill.id).toBe('a/b')
    expect(result.installCommand).toBe('npx @skillsmith/cli install a/b')
  })

  it('tier-denied isError response throws McpToolError code TierDenied', async () => {
    const client = connectedClient(isErr('Upgrade required to view this skill'))
    await expect(client.getSkill('a/b')).rejects.toMatchObject({
      code: 'TierDenied',
      toolName: 'get_skill',
    })
  })

  it('unknown-tool isError response throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('No such tool: get_skill'))
    await expect(client.getSkill('a/b')).rejects.toMatchObject({ code: 'UnknownTool' })
  })

  it('calling before connect throws NotConnected with the exact message', async () => {
    const client = new McpClient()
    await expect(client.getSkill('a/b')).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(client.getSkill('a/b')).rejects.toBeInstanceOf(McpToolError)
  })
})
