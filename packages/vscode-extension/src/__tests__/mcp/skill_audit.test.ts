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

const HAPPY_PAYLOAD = {
  advisoriesAvailable: true,
  summary: { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
  advisories: [
    {
      skillName: 'org/foo',
      severity: 'critical',
      title: 'X',
      id: 'SSA-2026-001',
      fixAvailable: true,
    },
  ],
}

describe('McpClient.skillAudit (SMI-5317)', () => {
  it('happy path returns the typed McpSkillAuditResponse shape', async () => {
    const client = connectedClient(ok(HAPPY_PAYLOAD))

    const result = await client.skillAudit({ skillIds: ['org/foo'] })

    expect(result.advisoriesAvailable).toBe(true)
    expect(result.advisories?.[0]?.id).toBe('SSA-2026-001')
    expect(result.summary?.critical).toBe(1)
    expect(result.summary?.total).toBe(1)
  })

  it('default args (no skillIds) on a connected client returns the happy shape', async () => {
    const client = connectedClient(ok(HAPPY_PAYLOAD))

    // skillAudit() with no args — default param is {}
    const result = await client.skillAudit()

    expect(result.advisoriesAvailable).toBe(true)
    expect(result.advisories?.[0]?.id).toBe('SSA-2026-001')
  })

  it('tier-denied isError response throws McpToolError code TierDenied', async () => {
    const client = connectedClient(
      isErr('Security Audit requires Team tier. Upgrade at https://skillsmith.app/upgrade')
    )
    await expect(client.skillAudit({ skillIds: ['org/foo'] })).rejects.toMatchObject({
      name: 'McpToolError',
      code: 'TierDenied',
      toolName: 'skill_audit',
    })
  })

  it('unknown-tool isError response throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('Unknown tool: skill_audit'))
    await expect(client.skillAudit({ skillIds: ['org/foo'] })).rejects.toMatchObject({
      code: 'UnknownTool',
    })
  })

  it('calling before connect throws NotConnected with the exact message', async () => {
    const client = new McpClient()
    await expect(client.skillAudit({ skillIds: ['org/foo'] })).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(client.skillAudit({ skillIds: ['org/foo'] })).rejects.toBeInstanceOf(McpToolError)
  })
})
