/**
 * skill_inventory_audit is UNGATED (Community-tier) — the server never
 * tier-denies it. The TierDenied case below only asserts that callMcpTool's
 * classifier maps a denial-shaped isError envelope to code 'TierDenied'; the
 * command does NOT wire handleTierDenied. (SMI-5318)
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

const ENTRY_A = {
  kind: 'skill' as const,
  source_path: '/home/u/.claude/skills/org/foo',
  identifier: 'org/foo',
  triggerSurface: [],
}

const ENTRY_B = {
  kind: 'skill' as const,
  source_path: '/home/u/.claude/skills/org/bar',
  identifier: 'org/bar',
  triggerSurface: [],
}

const HAPPY_PAYLOAD = {
  auditId: 'aud_1',
  inventory: [ENTRY_A, ENTRY_B],
  exactCollisions: [
    {
      kind: 'exact' as const,
      collisionId: 'c1',
      identifier: 'org/foo',
      entries: [ENTRY_A, ENTRY_B],
      severity: 'error' as const,
      reason: 'dup',
    },
  ],
  semanticCollisions: [
    {
      kind: 'semantic' as const,
      collisionId: 'c2',
      entryA: ENTRY_A,
      entryB: ENTRY_B,
      cosineScore: 0.91,
      overlappingPhrases: [{ phrase1: 'a', phrase2: 'b', similarity: 0.9 }],
      severity: 'warning' as const,
      reason: 'overlap',
    },
  ],
  genericFlags: [],
  renameSuggestions: [
    {
      collisionId: 'c1',
      entry: ENTRY_A,
      currentName: 'foo',
      suggested: 'foo-2',
      applyAction: 'rename_skill_dir_and_frontmatter' as const,
      reason: 'collision',
    },
  ],
  recommendedEdits: [],
  reportPath: '/home/u/.skillsmith/audits/aud_1/report.md',
  summary: {
    totalEntries: 2,
    totalFlags: 2,
    errorCount: 1,
    warningCount: 1,
    durationMs: 5,
  },
}

describe('McpClient.skillInventoryAudit (SMI-5318)', () => {
  it('happy path returns the typed McpInventoryAuditResponse shape', async () => {
    const client = connectedClient(ok(HAPPY_PAYLOAD))

    const result = await client.skillInventoryAudit({ deep: false })

    expect(result.auditId).toBe('aud_1')
    expect(result.exactCollisions[0]?.severity).toBe('error')
    expect(result.semanticCollisions[0]?.cosineScore).toBe(0.91)
    expect(result.renameSuggestions[0]?.suggested).toBe('foo-2')
    expect(result.summary.totalFlags).toBe(2)
    expect(result.reportPath).toMatch(/report\.md$/)
  })

  it('default args (no args) on a connected client returns the happy shape', async () => {
    const client = connectedClient(ok(HAPPY_PAYLOAD))

    // skillInventoryAudit() with no args — default param is {}
    const result = await client.skillInventoryAudit()

    expect(result.auditId).toBe('aud_1')
    expect(result.inventory).toHaveLength(2)
  })

  it('tier-denied isError response throws McpToolError code TierDenied', async () => {
    const client = connectedClient(
      isErr('Inventory Audit requires Team tier. Upgrade at https://skillsmith.app/upgrade')
    )
    await expect(client.skillInventoryAudit()).rejects.toMatchObject({
      name: 'McpToolError',
      code: 'TierDenied',
      toolName: 'skill_inventory_audit',
    })
  })

  it('unknown-tool isError response throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('Unknown tool: skill_inventory_audit'))
    await expect(client.skillInventoryAudit()).rejects.toMatchObject({
      code: 'UnknownTool',
    })
  })

  it('calling before connect throws NotConnected with the exact message', async () => {
    const client = new McpClient()
    await expect(client.skillInventoryAudit()).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(client.skillInventoryAudit()).rejects.toBeInstanceOf(McpToolError)
  })
})
