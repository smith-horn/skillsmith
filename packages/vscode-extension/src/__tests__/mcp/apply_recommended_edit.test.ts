/**
 * apply_recommended_edit is UNGATED but CONDITIONALLY registered server-side
 * (`APPLY_TEMPLATE_REGISTRY`). When the registry is empty the tool is absent →
 * an `Unknown tool` isError envelope → McpToolError code 'UnknownTool'. Otherwise
 * its result is `okBody`-wrapped, so application failure is `success:false` +
 * `errorCode` inside the parsed envelope, not a throw. (SMI-5325)
 */
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

const ARGS = { auditId: 'aud_1', collisionId: 'c3' }

describe('McpClient.applyRecommendedEdit (SMI-5325)', () => {
  it('preview (confirmed:false) returns the preview envelope unchanged', async () => {
    const client = connectedClient(
      ok({
        success: true,
        preview: true,
        collisionId: 'c3',
        target: '/home/u/.claude/skills/org/foo/SKILL.md',
        before: 'Use this for foo.',
        after: 'Use this for foo (org domain).',
        applied: false,
      })
    )

    const result = await client.applyRecommendedEdit({ ...ARGS, confirmed: false })

    expect(result.success).toBe(true)
    expect(result.preview).toBe(true)
    expect(result.after).toContain('org domain')
  })

  it('apply (confirmed:true) returns success', async () => {
    const client = connectedClient(
      ok({ success: true, collisionId: 'c3', result: { filePath: '/p' } })
    )

    const result = await client.applyRecommendedEdit({ ...ARGS, confirmed: true })

    expect(result.success).toBe(true)
  })

  it('template-not-in-registry failure is returned, not thrown', async () => {
    const client = connectedClient(
      ok({
        success: false,
        collisionId: 'c3',
        errorCode: 'edit.template_not_in_apply_registry',
        error: 'Template narrow_scope is not in the apply registry.',
      })
    )

    const result = await client.applyRecommendedEdit({ ...ARGS, confirmed: true })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('edit.template_not_in_apply_registry')
  })

  it('unregistered tool (empty registry) throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('Unknown tool: apply_recommended_edit'))
    await expect(client.applyRecommendedEdit(ARGS)).rejects.toMatchObject({
      code: 'UnknownTool',
      toolName: 'apply_recommended_edit',
    })
  })

  it('calling before connect throws NotConnected', async () => {
    const client = new McpClient()
    await expect(client.applyRecommendedEdit(ARGS)).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(client.applyRecommendedEdit(ARGS)).rejects.toBeInstanceOf(McpToolError)
  })
})
