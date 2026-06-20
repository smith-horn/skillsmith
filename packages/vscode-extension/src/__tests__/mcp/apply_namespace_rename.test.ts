/**
 * apply_namespace_rename is UNGATED (Community-tier) and ALWAYS registered. The
 * dispatcher wraps its result with `okBody` (isError:false), so application-level
 * failure arrives as `success:false` + `errorCode` INSIDE the parsed envelope —
 * NOT a thrown McpToolError. (SMI-5325)
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

/** Wrap a JSON payload in the MCP tools/call success envelope (non-isError). */
function ok(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** Returns a connected McpClient whose private `sendRequest` resolves to `raw`. */
function connectedClient(raw: unknown): McpClient {
  const client = new McpClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(client as any).status = 'connected'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(client as any).sendRequest = vi.fn().mockResolvedValue(raw)
  return client
}

const ARGS = { auditId: 'aud_1', collisionId: 'c1', action: 'apply' as const }

describe('McpClient.applyNamespaceRename (SMI-5325)', () => {
  it('preview (confirmed:false) returns the preview envelope unchanged', async () => {
    const client = connectedClient(
      ok({
        success: true,
        preview: true,
        collisionId: 'c1',
        action: 'rename_skill_dir_and_frontmatter',
        target: '/home/u/.claude/skills/org/foo',
        before: 'foo',
        after: 'foo-2',
        applied: false,
      })
    )

    const result = await client.applyNamespaceRename({ ...ARGS, confirmed: false })

    expect(result.success).toBe(true)
    expect(result.preview).toBe(true)
    expect(result.applied).toBe(false)
    expect(result.before).toBe('foo')
    expect(result.after).toBe('foo-2')
  })

  it('apply (confirmed:true) returns success with the Wave-2 result', async () => {
    const client = connectedClient(
      ok({ success: true, collisionId: 'c1', result: { fromPath: '/a', toPath: '/b' } })
    )

    const result = await client.applyNamespaceRename({ ...ARGS, confirmed: true })

    expect(result.success).toBe(true)
    expect(result.collisionId).toBe('c1')
  })

  it('structured failure is RETURNED (success:false + errorCode), not thrown', async () => {
    const client = connectedClient(
      ok({
        success: false,
        collisionId: 'c1',
        errorCode: 'namespace.audit.collision_not_found',
        error: 'Collision c1 not found in audit aud_1.',
      })
    )

    const result = await client.applyNamespaceRename({ ...ARGS, confirmed: true })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('namespace.audit.collision_not_found')
    expect(result.error).toContain('not found')
  })

  it('subcall failure preserves the rename errorCode in the envelope', async () => {
    const client = connectedClient(
      ok({
        success: false,
        collisionId: 'c1',
        errorCode: 'namespace.rename.subcall_failed',
        error: 'namespace.rename.target_exists: target already exists',
      })
    )

    const result = await client.applyNamespaceRename({ ...ARGS, confirmed: true })

    expect(result.errorCode).toBe('namespace.rename.subcall_failed')
    expect(result.error).toContain('target_exists')
  })

  it('calling before connect throws NotConnected', async () => {
    const client = new McpClient()
    await expect(client.applyNamespaceRename(ARGS)).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(client.applyNamespaceRename(ARGS)).rejects.toBeInstanceOf(McpToolError)
  })
})
