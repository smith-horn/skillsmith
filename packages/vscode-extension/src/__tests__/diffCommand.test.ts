/**
 * Tests for diffCommand.ts (SMI-5316 / #1457, SMI-5412).
 *
 * Covers: happy path, empty local SKILL.md abort, missing registry content abort,
 * TierDenied before panel open, no installed skills guard.
 * SMI-5412: local-with-source path (manifest entry + raw fetch → skillDiff + panel),
 * local-no-source actionable message, raw fetch failure, TierDenied on local path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── hoisted spies ─────────────────────────────────────────────────────────────
const showInformationMessage = vi.hoisted(() => vi.fn())
const showErrorMessage = vi.hoisted(() => vi.fn())
const showWarningMessage = vi.hoisted(() => vi.fn())
const showQuickPick = vi.hoisted(() => vi.fn())

// ── vscode mock ───────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  window: {
    showInformationMessage,
    showErrorMessage,
    showWarningMessage,
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

// ── manifestReader mock (SMI-5412) ────────────────────────────────────────────
const readManifestEntry = vi.hoisted(() => vi.fn())
const fetchRawSkillMd = vi.hoisted(() => vi.fn())
vi.mock('../services/manifestReader.js', () => ({
  readManifestEntry,
  fetchRawSkillMd,
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
    // SMI-5412: default — no manifest entry (no source tracked)
    readManifestEntry.mockResolvedValue(null)
    fetchRawSkillMd.mockResolvedValue(null)
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

  it('shows a friendly warning and does NOT open SkillDiffPanel on SkillNotFound (SMI-5322)', async () => {
    mcpSkillDiff.mockRejectedValue(
      new McpToolError('skill_diff', 'SkillNotFound', 'Skill "smith-horn/docker" not found')
    )

    const treeProvider = makeTreeProvider()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not be found'))
    expect(handleTierDenied).not.toHaveBeenCalled()
    expect(showErrorMessage).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
  })

  it('shows a local-skill message and skips the registry for a bare-id (local) skill (SMI-5406)', async () => {
    const localSkill = { ...INSTALLED_SKILL, id: 'ci-doctor', name: 'CI Doctor' }
    showQuickPick.mockResolvedValue({ item: localSkill })

    const treeProvider = makeTreeProvider([localSkill])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    // A bare-id local skill short-circuits BEFORE the registry call: no get_skill,
    // no diff, no panel, and NOT the misleading "removed or renamed" warning.
    expect(mcpGetSkill).not.toHaveBeenCalled()
    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
    expect(showWarningMessage).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('is a local skill'))
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

  it('skips the picker and diffs the preselected skill when arg has isInstalled + path', async () => {
    const treeProvider = makeTreeProvider()
    const preselected = {
      skillData: { ...INSTALLED_SKILL, isInstalled: true },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { treeProvider, context: FAKE_CONTEXT, preselected } as any
    await diffCommandAction(deps)

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('SKILL.md'), 'utf8')
    expect(mcpGetSkill).toHaveBeenCalledWith(INSTALLED_SKILL.id)
    expect(diffCreateOrShow).toHaveBeenCalled()
  })

  it('falls back to the picker when preselected arg is installed but has no path', async () => {
    const treeProvider = makeTreeProvider()
    const preselected = {
      skillData: { ...INSTALLED_SKILL, isInstalled: true, path: undefined },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { treeProvider, context: FAKE_CONTEXT, preselected } as any
    await diffCommandAction(deps)

    expect(showQuickPick).toHaveBeenCalled()
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

  // ── SMI-5412: local-skill-with-source path ───────────────────────────────────

  it('SMI-5412: local skill WITH manifest source — fetches raw, calls skillDiff, opens panel', async () => {
    const localSkill = { ...INSTALLED_SKILL, id: 'ci-doctor', name: 'CI Doctor' }
    const RAW_CONTENT = '# CI Doctor\n\nLatest from GitHub.'
    showQuickPick.mockResolvedValue({ item: localSkill })
    readManifestEntry.mockResolvedValue({ source: 'https://github.com/owner/ci-doctor' })
    fetchRawSkillMd.mockResolvedValue(RAW_CONTENT)

    const treeProvider = makeTreeProvider([localSkill])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    // registry getSkill must NOT be called — we fetched from GitHub directly
    expect(mcpGetSkill).not.toHaveBeenCalled()
    expect(readManifestEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ci-doctor', name: 'CI Doctor' })
    )
    expect(fetchRawSkillMd).toHaveBeenCalledWith('https://github.com/owner/ci-doctor')
    expect(mcpSkillDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'ci-doctor',
        oldContent: LOCAL_CONTENT,
        newContent: RAW_CONTENT,
      })
    )
    expect(diffCreateOrShow).toHaveBeenCalledWith(
      FAKE_CONTEXT.extensionUri,
      'CI Doctor',
      DIFF_RESPONSE,
      expect.objectContaining({ skillId: 'ci-doctor' })
    )
    expect(showInformationMessage).not.toHaveBeenCalled()
  })

  it('SMI-5412: local skill WITH source — TierDenied on skillDiff routes to handleTierDenied', async () => {
    const localSkill = { ...INSTALLED_SKILL, id: 'ci-doctor', name: 'CI Doctor' }
    const tierErr = new McpToolError('skill_diff', 'TierDenied', 'requires the Individual plan')
    showQuickPick.mockResolvedValue({ item: localSkill })
    readManifestEntry.mockResolvedValue({ source: 'https://github.com/owner/ci-doctor' })
    fetchRawSkillMd.mockResolvedValue('# CI Doctor')
    mcpSkillDiff.mockRejectedValue(tierErr)

    const treeProvider = makeTreeProvider([localSkill])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(handleTierDenied).toHaveBeenCalledWith('skillsmith.diffSkill', tierErr)
    expect(diffCreateOrShow).not.toHaveBeenCalled()
  })

  it('SMI-5412: local skill WITHOUT manifest source — shows actionable "sklx audit sources" message', async () => {
    const localSkill = { ...INSTALLED_SKILL, id: 'ci-doctor', name: 'CI Doctor' }
    // readManifestEntry returns null by default (no source tracked)
    showQuickPick.mockResolvedValue({ item: localSkill })

    const treeProvider = makeTreeProvider([localSkill])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(fetchRawSkillMd).not.toHaveBeenCalled()
    expect(mcpGetSkill).not.toHaveBeenCalled()
    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('sklx audit sources')
    )
  })

  it('SMI-5412: local skill WITH source — raw fetch failure shows clear info message, no crash', async () => {
    const localSkill = { ...INSTALLED_SKILL, id: 'ci-doctor', name: 'CI Doctor' }
    showQuickPick.mockResolvedValue({ item: localSkill })
    readManifestEntry.mockResolvedValue({ source: 'https://github.com/owner/ci-doctor' })
    // fetchRawSkillMd returns null (both branches 404 or network failure)

    const treeProvider = makeTreeProvider([localSkill])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await diffCommandAction({ treeProvider: treeProvider as any, context: FAKE_CONTEXT as any })

    expect(mcpSkillDiff).not.toHaveBeenCalled()
    expect(diffCreateOrShow).not.toHaveBeenCalled()
    expect(showErrorMessage).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't fetch the latest version from")
    )
  })
})
