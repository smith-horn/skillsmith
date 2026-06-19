/**
 * Tests for diffCommand.ts (SMI-5316 / #1457).
 *
 * Covers: happy path, empty local SKILL.md abort, missing registry content abort,
 * TierDenied before panel open, no installed skills guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── hoisted spies ─────────────────────────────────────────────────────────────
const showInformationMessage = vi.hoisted(() => vi.fn())
const showErrorMessage = vi.hoisted(() => vi.fn())
const showQuickPick = vi.hoisted(() => vi.fn())

// ── vscode mock ───────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  window: {
    showInformationMessage,
    showErrorMessage,
    showWarningMessage: vi.fn(),
    showQuickPick,
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
}))

// ── fs/promises mock ──────────────────────────────────────────────────────────
const readFile = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', () => ({ readFile }))

// ── MCP Client mock ───────────────────────────────────────────────────────────
const mcpIsConnected = vi.hoisted(() => vi.fn(() => true))
const mcpGetSkill = vi.hoisted(() => vi.fn())
const mcpSkillDiff = vi.hoisted(() => vi.fn())

vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({
    isConnected: mcpIsConnected,
    getSkill: mcpGetSkill,
    skillDiff: mcpSkillDiff,
  }),
}))

// ── tierDenied mock ───────────────────────────────────────────────────────────
const handleTierDenied = vi.hoisted(() => vi.fn())
vi.mock('../mcp/tierDenied.js', () => ({ handleTierDenied }))

// ── SkillDiffPanel mock ───────────────────────────────────────────────────────
const diffCreateOrShow = vi.hoisted(() => vi.fn())
vi.mock('../views/SkillDiffPanel.js', () => ({
  SkillDiffPanel: { createOrShow: diffCreateOrShow },
}))

// ── McpToolError: real class so instanceof works ──────────────────────────────
import { McpToolError } from '../mcp/McpToolError.js'

// ── SUT ───────────────────────────────────────────────────────────────────────
import { diffCommandAction } from '../commands/diffCommand.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────
const INSTALLED_SKILL = {
  id: 'org/my-skill',
  name: 'My Skill',
  path: '/home/user/.claude/skills/my-skill',
  trustTier: 'verified' as const,
  hasSkillMd: true,
}

const LOCAL_CONTENT = '# My Skill\n\nThis is the installed version.'
const REGISTRY_CONTENT = '# My Skill\n\nThis is the latest registry version with improvements.'
const DIFF_RESPONSE = { changeType: 'minor', verdict: 'update_recommended', diff: '+ improvements' }

/** Stub treeProvider with one installed skill by default. */
function makeTreeProvider(skills: (typeof INSTALLED_SKILL)[] = [INSTALLED_SKILL]) {
  return {
    getInstalledSkills: vi.fn(() => skills),
  }
}

const FAKE_CONTEXT = {
  subscriptions: [],
  extensionUri: { toString: () => '/ext', fsPath: '/ext' },
}

describe('diffCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpIsConnected.mockReturnValue(true)
    readFile.mockResolvedValue(LOCAL_CONTENT)
    mcpGetSkill.mockResolvedValue({ content: REGISTRY_CONTENT })
    mcpSkillDiff.mockResolvedValue(DIFF_RESPONSE)
    showQuickPick.mockResolvedValue({ item: INSTALLED_SKILL })
  })

  it('reads local SKILL.md, fetches registry content, calls skillDiff, and opens SkillDiffPanel', async () => {
    const treeProvider = makeTreeProvider()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('SKILL.md'), 'utf8')
    expect(mcpGetSkill).toHaveBeenCalledWith(INSTALLED_SKILL.id)
    expect(mcpSkillDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: INSTALLED_SKILL.id,
        oldContent: LOCAL_CONTENT,
        newContent: REGISTRY_CONTENT,
      })
    )
    expect(diffCreateOrShow).toHaveBeenCalledWith(
      FAKE_CONTEXT.extensionUri,
      INSTALLED_SKILL.name,
      DIFF_RESPONSE,
      expect.objectContaining({ skillId: INSTALLED_SKILL.id })
    )
    expect(handleTierDenied).not.toHaveBeenCalled()
  })

  it('shows info message and aborts when local SKILL.md is empty', async () => {
    readFile.mockResolvedValue('')

    const treeProvider = makeTreeProvider()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining(INSTALLED_SKILL.name)
    )
  })

  it('shows info message and aborts when registry content is missing (undefined)', async () => {
    mcpGetSkill.mockResolvedValue({ content: undefined })

    const treeProvider = makeTreeProvider()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("isn't in the registry")
    )
  })

  it('shows info message and aborts when registry content is empty string', async () => {
    mcpGetSkill.mockResolvedValue({ content: '' })

    const treeProvider = makeTreeProvider()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("isn't in the registry")
    )
  })

  it('calls handleTierDenied and does NOT open SkillDiffPanel when skillDiff throws TierDenied', async () => {
    const tierErr = new McpToolError('skill_diff', 'TierDenied', 'requires the Individual plan')
    mcpSkillDiff.mockRejectedValue(tierErr)

    const treeProvider = makeTreeProvider()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(handleTierDenied).toHaveBeenCalledWith('skillsmith.diffSkill', tierErr)
    expect(diffCreateOrShow).not.toHaveBeenCalled()
  })

  it('shows info message when there are no installed skills', async () => {
    const treeProvider = makeTreeProvider([])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('No installed skills')
    )
  })

  it('returns early without calling skillDiff when QuickPick is dismissed', async () => {
    showQuickPick.mockResolvedValue(undefined)

    const treeProvider = makeTreeProvider()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
  })

  it('shows info message and aborts when readFile fails', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'))

    const treeProvider = makeTreeProvider()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't read SKILL.md")
    )
  })
})
