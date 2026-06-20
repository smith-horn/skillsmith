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

describe('McpClient.skillCompare (SMI-5315)', () => {
  it('happy path returns the typed McpCompareResponse shape', async () => {
    const response = {
      comparison: {
        a: {
          id: 'smith-horn/docker',
          name: 'docker',
          description: 'Container-based development',
          author: 'smith-horn',
          quality_score: 92,
          score_breakdown: null,
          trust_tier: 'verified',
          category: 'development',
          tags: ['docker', 'containers'],
          version: null,
          dependencies: [],
        },
        b: {
          id: 'community/docker-compose',
          name: 'docker-compose',
          description: 'Docker Compose orchestration',
          author: 'community',
          quality_score: 78,
          score_breakdown: null,
          trust_tier: 'community',
          category: 'development',
          tags: ['docker', 'compose'],
          version: null,
          dependencies: [],
        },
      },
      differences: [
        {
          field: 'quality_score',
          a_value: 92,
          b_value: 78,
          winner: 'a',
        },
        {
          field: 'trust_tier',
          a_value: 'verified',
          b_value: 'community',
          winner: 'a',
        },
      ],
      recommendation: 'smith-horn/docker is the stronger choice based on quality and trust tier.',
      winner: 'a',
      timing: { totalMs: 88 },
    }
    const client = connectedClient(ok(response))

    const result = await client.skillCompare({
      skill_a: 'smith-horn/docker',
      skill_b: 'community/docker-compose',
    })

    expect(result.comparison.a.id).toBe('smith-horn/docker')
    expect(result.comparison.b.id).toBe('community/docker-compose')
    expect(result.winner).toBe('a')
    expect(result.differences[0]?.field).toBe('quality_score')
  })

  it('tier-denied isError response throws McpToolError code TierDenied', async () => {
    const client = connectedClient(
      isErr('TierDenied: skill_compare requires the Individual plan ($9.99/mo)')
    )
    await expect(
      client.skillCompare({ skill_a: 'smith-horn/docker', skill_b: 'community/docker-compose' })
    ).rejects.toMatchObject({
      name: 'McpToolError',
      code: 'TierDenied',
      toolName: 'skill_compare',
    })
  })

  it('unknown-tool isError response throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('Unknown tool: skill_compare'))
    await expect(
      client.skillCompare({ skill_a: 'smith-horn/docker', skill_b: 'community/docker-compose' })
    ).rejects.toMatchObject({ code: 'UnknownTool' })
  })

  it('skill-not-found isError response throws McpToolError code SkillNotFound (SMI-5322)', async () => {
    const client = connectedClient(isErr('Error: Skill "community/docker-compose" not found'))
    await expect(
      client.skillCompare({ skill_a: 'smith-horn/docker', skill_b: 'community/docker-compose' })
    ).rejects.toMatchObject({ code: 'SkillNotFound', toolName: 'skill_compare' })
  })

  it('calling before connect throws NotConnected with the exact message', async () => {
    const client = new McpClient()
    await expect(
      client.skillCompare({ skill_a: 'smith-horn/docker', skill_b: 'community/docker-compose' })
    ).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(
      client.skillCompare({ skill_a: 'smith-horn/docker', skill_b: 'community/docker-compose' })
    ).rejects.toBeInstanceOf(McpToolError)
  })
})
