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

const OLD_CONTENT = `# docker\nRun npm commands in Docker containers.\n\n## Usage\nUse for npm install.\n`
const NEW_CONTENT = `# docker\nRun commands in Docker containers with native module support.\n\n## Usage\nUse for npm install, build steps.\n\n## Advanced\nSupports glibc-requiring modules.\n`

describe('McpClient.skillDiff (SMI-5316)', () => {
  it('happy path returns the typed McpSkillDiffResponse shape', async () => {
    const response = {
      skill: 'smith-horn/docker',
      changeType: 'minor',
      sectionsAdded: ['Advanced'],
      sectionsRemoved: [],
      sectionsModified: ['Usage'],
      riskScoreDelta: -2,
      changelog: '- Expanded usage examples\n- Added Advanced section for native modules',
      recommendation: 'review-then-update',
    }
    const client = connectedClient(ok(response))

    const result = await client.skillDiff({
      skillId: 'smith-horn/docker',
      oldContent: OLD_CONTENT,
      newContent: NEW_CONTENT,
      oldRiskScore: 10,
      newRiskScore: 8,
      hasLocalModifications: false,
      trustTier: 'verified',
    })

    expect(result.changeType).toBe('minor')
    expect(result.recommendation).toBe('review-then-update')
    expect(result.sectionsAdded).toContain('Advanced')
    expect(result.riskScoreDelta).toBe(-2)
  })

  it('tier-denied isError response throws McpToolError code TierDenied', async () => {
    const client = connectedClient(
      isErr(
        'Version Tracking requires Individual tier ($9.99/mo). Upgrade at https://skillsmith.app/upgrade'
      )
    )
    await expect(
      client.skillDiff({
        skillId: 'smith-horn/docker',
        oldContent: OLD_CONTENT,
        newContent: NEW_CONTENT,
      })
    ).rejects.toMatchObject({
      name: 'McpToolError',
      code: 'TierDenied',
      toolName: 'skill_diff',
    })
  })

  it('unknown-tool isError response throws McpToolError code UnknownTool', async () => {
    const client = connectedClient(isErr('Unknown tool: skill_diff'))
    await expect(
      client.skillDiff({
        skillId: 'smith-horn/docker',
        oldContent: OLD_CONTENT,
        newContent: NEW_CONTENT,
      })
    ).rejects.toMatchObject({ code: 'UnknownTool' })
  })

  it('calling before connect throws NotConnected with the exact message', async () => {
    const client = new McpClient()
    await expect(
      client.skillDiff({
        skillId: 'smith-horn/docker',
        oldContent: OLD_CONTENT,
        newContent: NEW_CONTENT,
      })
    ).rejects.toMatchObject({
      code: 'NotConnected',
      message: 'MCP client not connected',
    })
    await expect(
      client.skillDiff({
        skillId: 'smith-horn/docker',
        oldContent: OLD_CONTENT,
        newContent: NEW_CONTENT,
      })
    ).rejects.toBeInstanceOf(McpToolError)
  })
})
