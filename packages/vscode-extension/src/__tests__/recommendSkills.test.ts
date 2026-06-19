/**
 * Tests for recommendCommand.ts (SMI-5314 / Epic D / PR-D1).
 *
 * Covers: happy path, empty recommendations, not-connected guard, TierDenied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── hoisted spies (needed inside vi.mock factories) ───────────────────────────
const showInformationMessage = vi.hoisted(() => vi.fn())
const showErrorMessage = vi.hoisted(() => vi.fn())
const showQuickPick = vi.hoisted(() => vi.fn())
const executeCommand = vi.hoisted(() => vi.fn())

// ── vscode mock ───────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  window: {
    showInformationMessage,
    showErrorMessage,
    showQuickPick,
    showWarningMessage: vi.fn(),
  },
  commands: { registerCommand: vi.fn(), executeCommand },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })),
  },
  Uri: {
    file: (s: string) => ({ toString: () => s, fsPath: s }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ViewColumn: { One: 1 },
  Disposable: class {
    dispose = vi.fn()
  },
  env: { openExternal: vi.fn(), isTelemetryEnabled: true },
}))

// ── Telemetry mock ────────────────────────────────────────────────────────────
vi.mock('../services/Telemetry.js', () => ({ track: vi.fn() }))

// ── trustTier mock ────────────────────────────────────────────────────────────
vi.mock('../sidebar/trustTier.js', () => ({
  getTrustTierCodicon: () => '$(verified)',
}))

// ── MCP Client mock ───────────────────────────────────────────────────────────
const mcpIsConnected = vi.hoisted(() => vi.fn(() => true))
const mcpSkillRecommend = vi.hoisted(() => vi.fn())

vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({
    isConnected: mcpIsConnected,
    skillRecommend: mcpSkillRecommend,
  }),
}))

// ── tierDenied mock ───────────────────────────────────────────────────────────
const handleTierDenied = vi.hoisted(() => vi.fn())
vi.mock('../mcp/tierDenied.js', () => ({ handleTierDenied }))

// ── McpToolError: import real class so instanceof works ───────────────────────
import { McpToolError } from '../mcp/McpToolError.js'

// ── SUT ───────────────────────────────────────────────────────────────────────
import { recommendCommandAction } from '../commands/recommendCommand.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────
const FAKE_RECOMMENDATION = {
  skill_id: 'test-org/my-skill',
  name: 'My Skill',
  reason: 'Useful for TypeScript projects',
  similarity_score: 0.92,
  trust_tier: 'verified',
  quality_score: 88,
}

describe('recommendCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpIsConnected.mockReturnValue(true)
  })

  it('shows QuickPick with items and navigates to skill details on pick', async () => {
    mcpSkillRecommend.mockResolvedValue({ recommendations: [FAKE_RECOMMENDATION] })
    showQuickPick.mockResolvedValue({ skillId: FAKE_RECOMMENDATION.skill_id })

    await recommendCommandAction()

    expect(mcpSkillRecommend).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }))
    expect(showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ skillId: FAKE_RECOMMENDATION.skill_id })]),
      expect.objectContaining({ title: 'Recommended Skills' })
    )
    expect(executeCommand).toHaveBeenCalledWith(
      'skillsmith.viewSkillDetails',
      FAKE_RECOMMENDATION.skill_id
    )
  })

  it('shows info message and does NOT show QuickPick on empty recommendations', async () => {
    mcpSkillRecommend.mockResolvedValue({ recommendations: [] })

    await recommendCommandAction()

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('No skill recommendations'),
      expect.any(String)
    )
  })

  it('shows info message and does NOT call skillRecommend when not connected', async () => {
    mcpIsConnected.mockReturnValue(false)

    await recommendCommandAction()

    expect(mcpSkillRecommend).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Connect to the Skillsmith MCP server')
    )
  })

  it('calls handleTierDenied and does NOT show error message when skillRecommend throws TierDenied', async () => {
    const tierErr = new McpToolError('skill_recommend', 'TierDenied', 'requires the Team plan')
    mcpSkillRecommend.mockRejectedValue(tierErr)

    await recommendCommandAction()

    expect(handleTierDenied).toHaveBeenCalledWith('skillsmith.recommendSkills', tierErr)
    expect(showErrorMessage).not.toHaveBeenCalled()
  })

  it('does NOT call executeCommand when QuickPick is dismissed without selection', async () => {
    mcpSkillRecommend.mockResolvedValue({ recommendations: [FAKE_RECOMMENDATION] })
    showQuickPick.mockResolvedValue(undefined)

    await recommendCommandAction()

    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('shows error message on unexpected error', async () => {
    mcpSkillRecommend.mockRejectedValue(new Error('network failure'))

    await recommendCommandAction()

    expect(showErrorMessage).toHaveBeenCalledWith('network failure')
    expect(handleTierDenied).not.toHaveBeenCalled()
  })
})
