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

describe('McpClient.skillRecommend (SMI-5314)', () => {
  it('happy path returns the typed McpRecommendResponse shape', async () => {
    const response = {
      recommendations: [
        {
          skill_id: 'smith-horn/docker',
          name: 'docker',
          reason: 'Matches your container-based development workflow',
          similarity_score: 0.87,
          trust_tier: 'verified',
          quality_score: 92,
          roles: ['developer'],
          installable: true,
        },
      ],
      candidates_considered: 50,
      overlap_filtered: 3,
      role_filtered: 0,
      discovery_only_hidden: 2,
      context: {
        installed_count: 5,
        has_project_context: true,
        using_semantic_matching: true,
        auto_detected: false,
        role_filter: 'developer',
      },
      timing: { totalMs: 142 },
    }
    const client = connectedClient(ok(response))

    const result = await client.skillRecommend({ limit: 10, project_context: 'my-app' })

    expect(result.recommendations[0]?.skill_id).toBe('smith-horn/docker')
    expect(result.recommendations[0]?.similarity_score).toBe(0.87)
    expect(result.recommendations[0]?.quality_score).toBe(92)
    expect(result.candidates_considered).toBe(50)
    expect(result.context.has_project_context).toBe(true)
  })

  it('tier-denied isError response throws McpToolError code TierDenied', async () => {
    const client = connectedClient(
      isErr('TierDenied: skill_recommend requires the Team plan ($25/user/mo)')
    )
    await expect(client.skillRecommend({ limit: 10 })).rejects.toMatchObject({
      name: 'McpToolError',
      code: 'TierDenied',
      toolName: 'skill_recommend',
    })
  })

  it('unknown-tool isError response throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('Unknown tool: skill_recommend'))
    await expect(client.skillRecommend({ limit: 10 })).rejects.toMatchObject({
      code: 'UnknownTool',
    })
  })

  it('calling before connect throws NotConnected with the exact message', async () => {
    const client = new McpClient()
    await expect(client.skillRecommend({ limit: 10 })).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(client.skillRecommend({ limit: 10 })).rejects.toBeInstanceOf(McpToolError)
  })
})
