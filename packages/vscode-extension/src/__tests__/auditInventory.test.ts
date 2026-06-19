/**
 * Tests for auditInventoryCommand.ts (SMI-5318 / Epic D / PR-D3).
 *
 * Covers: not-connected guard, connected + populated, connected + clean (totalFlags:0),
 * cancellation, and unexpected error from skillInventoryAudit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Token ref shared by the withProgress mock and per-test overrides ──────────
// Must be a stable object reference so the hoisted fn can read it at call time.
const tokenRef = vi.hoisted(() => ({ isCancellationRequested: false }))

// ── hoisted spies (needed inside vi.mock factories) ───────────────────────────
const showInformationMessage = vi.hoisted(() => vi.fn())
const showErrorMessage = vi.hoisted(() => vi.fn())
const track = vi.hoisted(() => vi.fn())
const mcpIsConnected = vi.hoisted(() => vi.fn(() => true))
const mcpSkillInventoryAudit = vi.hoisted(() => vi.fn())
const inventoryAuditCreateOrShow = vi.hoisted(() => vi.fn())
const withProgress = vi.hoisted(() =>
  vi.fn(async (_opts: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) => {
    return task({ report: vi.fn() }, tokenRef)
  })
)

// ── vscode mock ───────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  window: {
    showInformationMessage,
    showErrorMessage,
    withProgress,
  },
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: () => undefined })),
  },
  Uri: {
    file: (s: string) => ({ toString: () => s, fsPath: s }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ProgressLocation: { Window: 10 },
  ViewColumn: { One: 1 },
  Disposable: class {
    dispose = vi.fn()
  },
  env: { openExternal: vi.fn(), isTelemetryEnabled: true },
}))

// ── Telemetry mock ────────────────────────────────────────────────────────────
vi.mock('../services/Telemetry.js', () => ({ track }))

// ── MCP Client mock ───────────────────────────────────────────────────────────
vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({
    isConnected: mcpIsConnected,
    skillInventoryAudit: mcpSkillInventoryAudit,
  }),
}))

// ── InventoryAuditPanel mock ──────────────────────────────────────────────────
vi.mock('../views/InventoryAuditPanel.js', () => ({
  InventoryAuditPanel: { createOrShow: inventoryAuditCreateOrShow },
}))

// ── SUT ───────────────────────────────────────────────────────────────────────
import { auditInventoryCommandAction } from '../commands/auditInventoryCommand.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────
const BASE_ENTRY = {
  kind: 'skill' as const,
  source_path: '/home/u/.claude/skills/org/foo',
  identifier: 'org/foo',
  triggerSurface: [],
}

function makeResponse(
  overrides: Partial<{
    totalFlags: number
    errorCount: number
    warningCount: number
    totalEntries: number
  }> = {}
) {
  const { totalFlags = 2, errorCount = 1, warningCount = 1, totalEntries = 2 } = overrides
  return {
    auditId: 'aud_test',
    inventory: [BASE_ENTRY],
    exactCollisions: [
      {
        kind: 'exact' as const,
        collisionId: 'c1',
        identifier: 'org/foo',
        entries: [BASE_ENTRY],
        severity: 'error' as const,
        reason: 'duplicate identifier',
      },
    ],
    semanticCollisions: [],
    genericFlags: [],
    renameSuggestions: [],
    recommendedEdits: [],
    reportPath: '/home/u/.skillsmith/audits/aud_test/report.md',
    summary: { totalEntries, totalFlags, errorCount, warningCount, durationMs: 5 },
  }
}

describe('auditInventoryCommand (SMI-5318)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpIsConnected.mockReturnValue(true)
    // Reset the shared token so each test starts with cancellation = false.
    tokenRef.isCancellationRequested = false
    // Restore the default withProgress implementation after vi.clearAllMocks().
    withProgress.mockImplementation(
      async (_opts: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) => {
        return task({ report: vi.fn() }, tokenRef)
      }
    )
  })

  it('not connected: shows info message and does NOT open panel', async () => {
    mcpIsConnected.mockReturnValue(false)

    await auditInventoryCommandAction()

    expect(showInformationMessage).toHaveBeenCalledWith(
      'Connect to the Skillsmith MCP server to audit your inventory.'
    )
    expect(inventoryAuditCreateOrShow).not.toHaveBeenCalled()
  })

  it('connected + populated (totalFlags>0): calls skillInventoryAudit, fires complete telemetry, opens panel', async () => {
    const response = makeResponse({ totalFlags: 2, errorCount: 1, warningCount: 1 })
    mcpSkillInventoryAudit.mockResolvedValue(response)

    await auditInventoryCommandAction()

    expect(mcpSkillInventoryAudit).toHaveBeenCalledWith({})
    expect(track).toHaveBeenCalledWith('vscode_inventory_audit_complete', {
      collisions: 2,
      entries: response.summary.totalEntries,
    })
    expect(track).not.toHaveBeenCalledWith('vscode_inventory_audit_empty')
    expect(inventoryAuditCreateOrShow).toHaveBeenCalledOnce()
  })

  it('connected + clean (totalFlags:0): fires empty telemetry AND still opens panel', async () => {
    const response = makeResponse({ totalFlags: 0, errorCount: 0, warningCount: 0 })
    mcpSkillInventoryAudit.mockResolvedValue(response)

    await auditInventoryCommandAction()

    expect(track).toHaveBeenCalledWith('vscode_inventory_audit_complete', {
      collisions: 0,
      entries: response.summary.totalEntries,
    })
    expect(track).toHaveBeenCalledWith('vscode_inventory_audit_empty')
    expect(inventoryAuditCreateOrShow).toHaveBeenCalledOnce()
  })

  it('cancelled: createOrShow NOT called and complete telemetry NOT fired', async () => {
    tokenRef.isCancellationRequested = true
    const response = makeResponse()
    mcpSkillInventoryAudit.mockResolvedValue(response)

    await auditInventoryCommandAction()

    expect(inventoryAuditCreateOrShow).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalledWith('vscode_inventory_audit_complete', expect.anything())
  })

  it('skillInventoryAudit throws: shows error message and does NOT unhandled-reject', async () => {
    mcpSkillInventoryAudit.mockRejectedValue(new Error('network failure'))

    await auditInventoryCommandAction()

    expect(showErrorMessage).toHaveBeenCalledWith('network failure')
    expect(inventoryAuditCreateOrShow).not.toHaveBeenCalled()
  })
})
