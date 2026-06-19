/**
 * Tests for compareCommand.ts (SMI-5315 / #1456).
 *
 * Covers: happy path (two picks → skillCompare → panel), first-pick cancelled,
 * TierDenied from skillCompare.
 *
 * createQuickPick is driven by capturing the onDidAccept / onDidHide handlers
 * and calling them synchronously after a small tick.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── hoisted spies ─────────────────────────────────────────────────────────────
const showInformationMessage = vi.hoisted(() => vi.fn())
const showErrorMessage = vi.hoisted(() => vi.fn())
const showWarningMessage = vi.hoisted(() => vi.fn())
const createQuickPickFn = vi.hoisted(() => vi.fn())

// ── vscode mock ───────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  window: {
    showInformationMessage,
    showErrorMessage,
    showWarningMessage,
    createQuickPick: createQuickPickFn,
    showQuickPick: vi.fn(),
  },
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
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
  getTrustTierLabel: () => 'Verified',
}))

// ── MCP Client mock ───────────────────────────────────────────────────────────
const mcpIsConnected = vi.hoisted(() => vi.fn(() => true))
const mcpSkillCompare = vi.hoisted(() => vi.fn())

vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({
    isConnected: mcpIsConnected,
    skillCompare: mcpSkillCompare,
  }),
}))

// ── tierDenied mock ───────────────────────────────────────────────────────────
const handleTierDenied = vi.hoisted(() => vi.fn())
vi.mock('../mcp/tierDenied.js', () => ({ handleTierDenied }))

// ── CompareSkillsPanel mock ───────────────────────────────────────────────────
const compareCreateOrShow = vi.hoisted(() => vi.fn())
vi.mock('../views/CompareSkillsPanel.js', () => ({
  CompareSkillsPanel: { createOrShow: compareCreateOrShow },
}))

// ── McpToolError: real class so instanceof works ──────────────────────────────
import { McpToolError } from '../mcp/McpToolError.js'
import type * as vscode from 'vscode'
import type { SkillService } from '../services/SkillService.js'

// ── SUT ───────────────────────────────────────────────────────────────────────
import { compareCommandAction } from '../commands/compareCommand.js'

/** Cast the partial mocks to the action's param types without `any`. */
const asDeps = (): { skillService: SkillService; context: vscode.ExtensionContext } => ({
  skillService: FAKE_SKILL_SERVICE as unknown as SkillService,
  context: FAKE_CONTEXT as unknown as vscode.ExtensionContext,
})

// ── Fixtures ──────────────────────────────────────────────────────────────────
const SKILL_A = {
  id: 'org/skill-a',
  name: 'Skill A',
  author: 'org',
  description: 'first',
  trustTier: 'verified',
  version: '1.0.0',
}
const SKILL_B = {
  id: 'org/skill-b',
  name: 'Skill B',
  author: 'org',
  description: 'second',
  trustTier: 'community',
  version: '2.0.0',
}

const FAKE_COMPARE_RESPONSE = { skill_a: SKILL_A.id, skill_b: SKILL_B.id, comparison: 'diff text' }

/**
 * Build a minimal fake QuickPick that immediately resolves with the given skill
 * on `.show()`, simulating the user accepting the first item in the list.
 * Pass `skill: null` to simulate the user dismissing the picker (onDidHide).
 */
function makeQuickPickStub(skill: typeof SKILL_A | null) {
  let acceptHandler: (() => void) | undefined
  let hideHandler: (() => void) | undefined

  const qp = {
    title: '',
    placeholder: '',
    matchOnDescription: false,
    matchOnDetail: false,
    busy: false,
    items: [] as { skill: typeof SKILL_A | null }[],
    selectedItems: [] as { skill: typeof SKILL_A | null }[],
    value: '',
    onDidChangeValue: vi.fn((_cb: (v: string) => void) => ({ dispose: vi.fn() })),
    onDidAccept: vi.fn((cb: () => void) => {
      acceptHandler = cb
      return { dispose: vi.fn() }
    }),
    onDidHide: vi.fn((cb: () => void) => {
      hideHandler = cb
      return { dispose: vi.fn() }
    }),
    show: vi.fn(() => {
      if (skill) {
        qp.selectedItems = [{ skill }]
        acceptHandler?.()
      } else {
        hideHandler?.()
      }
    }),
    hide: vi.fn(() => {
      hideHandler?.()
    }),
    dispose: vi.fn(),
  }
  return qp
}

const FAKE_SKILL_SERVICE = {
  search: vi.fn().mockResolvedValue({ results: [SKILL_A, SKILL_B], isOffline: false }),
}

const FAKE_CONTEXT = {
  subscriptions: [],
  extensionUri: { toString: () => '/ext', fsPath: '/ext' },
}

describe('compareCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpIsConnected.mockReturnValue(true)
    mcpSkillCompare.mockResolvedValue(FAKE_COMPARE_RESPONSE)
    FAKE_SKILL_SERVICE.search.mockResolvedValue({ results: [SKILL_A, SKILL_B], isOffline: false })
  })

  it('calls skillCompare and opens CompareSkillsPanel on two distinct picks', async () => {
    // Return first stub for SKILL_A pick, second for SKILL_B pick.
    createQuickPickFn
      .mockReturnValueOnce(makeQuickPickStub(SKILL_A))
      .mockReturnValueOnce(makeQuickPickStub(SKILL_B))

    await compareCommandAction(asDeps())

    expect(mcpSkillCompare).toHaveBeenCalledWith({ skill_a: SKILL_A.id, skill_b: SKILL_B.id })
    expect(compareCreateOrShow).toHaveBeenCalledWith(
      FAKE_CONTEXT.extensionUri,
      FAKE_COMPARE_RESPONSE,
      SKILL_A.id,
      SKILL_B.id
    )
  })

  it('returns early without calling skillCompare when first pick is cancelled', async () => {
    // First pick dismisses (null = hide without accept).
    createQuickPickFn.mockReturnValueOnce(makeQuickPickStub(null))

    await compareCommandAction(asDeps())

    expect(mcpSkillCompare).not.toHaveBeenCalled()
    expect(compareCreateOrShow).not.toHaveBeenCalled()
  })

  it('returns early without calling skillCompare when second pick is cancelled', async () => {
    createQuickPickFn
      .mockReturnValueOnce(makeQuickPickStub(SKILL_A))
      .mockReturnValueOnce(makeQuickPickStub(null))

    await compareCommandAction(asDeps())

    expect(mcpSkillCompare).not.toHaveBeenCalled()
    expect(compareCreateOrShow).not.toHaveBeenCalled()
  })

  it('shows info message and skips skillCompare when MCP is not connected', async () => {
    mcpIsConnected.mockReturnValue(false)
    createQuickPickFn
      .mockReturnValueOnce(makeQuickPickStub(SKILL_A))
      .mockReturnValueOnce(makeQuickPickStub(SKILL_B))

    await compareCommandAction(asDeps())

    expect(mcpSkillCompare).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('not connected'))
  })

  it('calls handleTierDenied and does NOT open panel when skillCompare throws TierDenied', async () => {
    const tierErr = new McpToolError('skill_compare', 'TierDenied', 'requires the Team plan')
    mcpSkillCompare.mockRejectedValue(tierErr)

    createQuickPickFn
      .mockReturnValueOnce(makeQuickPickStub(SKILL_A))
      .mockReturnValueOnce(makeQuickPickStub(SKILL_B))

    await compareCommandAction(asDeps())

    expect(handleTierDenied).toHaveBeenCalledWith('skillsmith.compareSkills', tierErr)
    expect(compareCreateOrShow).not.toHaveBeenCalled()
  })

  it('shows generic error message on non-TierDenied McpToolError', async () => {
    const err = new McpToolError('skill_compare', 'Unknown', 'something went wrong')
    mcpSkillCompare.mockRejectedValue(err)

    createQuickPickFn
      .mockReturnValueOnce(makeQuickPickStub(SKILL_A))
      .mockReturnValueOnce(makeQuickPickStub(SKILL_B))

    await compareCommandAction(asDeps())

    expect(showErrorMessage).toHaveBeenCalledWith('something went wrong')
    expect(compareCreateOrShow).not.toHaveBeenCalled()
  })
})
