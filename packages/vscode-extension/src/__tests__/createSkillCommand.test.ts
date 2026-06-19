/**
 * Tests for createSkillCommand.ts (rewired for SMI-5313 / GH #1454).
 *
 * The command now delegates to CreateSkillPanel instead of runWizard.
 * Wizard-step tests are removed; panel interaction is tested in
 * CreateSkillPanel.test.ts. Checklist tests moved to createSkill.checklist.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vscode mock ───────────────────────────────────────────────────────────────
const showErrorMessage = vi.fn()
const createOutputChannel = vi.fn(() => ({
  appendLine: vi.fn(),
  append: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
}))
const registerCommand = vi.fn()
const FAKE_EXTENSION_URI = { fsPath: '/ext' }

vi.mock('vscode', () => ({
  window: {
    showErrorMessage,
    createOutputChannel,
  },
  commands: { registerCommand },
  env: {
    clipboard: { writeText: vi.fn() },
    openExternal: vi.fn(),
  },
  Uri: {
    file: (s: string) => ({ toString: () => s, fsPath: s }),
    parse: (s: string) => ({ toString: () => s }),
  },
}))

// ── Telemetry mock ────────────────────────────────────────────────────────────
const trackMock = vi.fn()
vi.mock('../services/Telemetry.js', () => ({
  track: trackMock,
}))

// ── telemetry-wrap: use real impl (withTelemetry calls track internally) ──────
// Do NOT mock telemetry-wrap — we want createSkillAction to be the real
// withTelemetry-wrapped version so the telemetry-coverage test stays green.

// ── Sidebar mock ──────────────────────────────────────────────────────────────
const refreshAndWait = vi.fn(async () => {})
vi.mock('../sidebar/SkillTreeDataProvider.js', () => ({
  SkillTreeDataProvider: class {
    refreshAndWait = refreshAndWait
  },
}))

// ── ensureCliAvailable mock ───────────────────────────────────────────────────
const ensureCliAvailableMock = vi.fn()
vi.mock('../utils/createSkill.helpers.js', () => ({
  ensureCliAvailable: ensureCliAvailableMock,
  runCli: vi.fn(),
  exists: vi.fn(),
  buildCreateArgs: vi.fn(),
  targetDirFor: vi.fn(),
  showPostCreateChecklist: vi.fn(),
}))

// ── CreateSkillPanel mock ─────────────────────────────────────────────────────
const createOrShowMock = vi.fn()
let currentPanelRef: undefined | { dispose: () => void } = undefined

vi.mock('../views/CreateSkillPanel.js', () => ({
  CreateSkillPanel: {
    get currentPanel() {
      return currentPanelRef
    },
    createOrShow: createOrShowMock,
    resetForTests: vi.fn(() => {
      currentPanelRef = undefined
    }),
  },
}))

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('createSkillCommand (SMI-5313 rewire)', () => {
  let handler: () => Promise<void>

  beforeEach(async () => {
    showErrorMessage.mockReset()
    createOutputChannel.mockReset().mockReturnValue({
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })
    registerCommand.mockReset()
    refreshAndWait.mockReset().mockResolvedValue(undefined)
    trackMock.mockReset()
    ensureCliAvailableMock.mockReset().mockResolvedValue(true)
    createOrShowMock.mockReset()
    currentPanelRef = undefined

    vi.resetModules()
    const { registerCreateSkillCommand } = await import('../commands/createSkillCommand.js')
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    const context = {
      subscriptions: [],
      extensionUri: FAKE_EXTENSION_URI,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCreateSkillCommand(context as any, provider as any)
    const call = registerCommand.mock.calls[0]
    if (!call) throw new Error('create command not registered')
    handler = call[1] as () => Promise<void>
  })

  it('opens the panel after ensureCliAvailable returns true', async () => {
    ensureCliAvailableMock.mockResolvedValue(true)

    await handler()

    expect(ensureCliAvailableMock).toHaveBeenCalledTimes(1)
    expect(createOrShowMock).toHaveBeenCalledTimes(1)
  })

  it('tracks vscode_create_failed with cli_missing and does not open panel when CLI missing', async () => {
    ensureCliAvailableMock.mockResolvedValue(false)

    await handler()

    expect(trackMock).toHaveBeenCalledWith('vscode_create_failed', { reason: 'cli_missing' })
    expect(createOrShowMock).not.toHaveBeenCalled()
  })

  it('reveals the panel without calling ensureCliAvailable when panel is already open (H5)', async () => {
    currentPanelRef = { dispose: vi.fn() }

    await handler()

    expect(ensureCliAvailableMock).not.toHaveBeenCalled()
    expect(createOrShowMock).toHaveBeenCalledTimes(1)
  })

  it('tracks vscode_create_start before CLI check on first open', async () => {
    ensureCliAvailableMock.mockResolvedValue(true)

    await handler()

    expect(trackMock).toHaveBeenCalledWith('vscode_create_start')
  })

  it('does not track vscode_create_start when panel is already open (H5)', async () => {
    currentPanelRef = { dispose: vi.fn() }

    await handler()

    expect(trackMock).not.toHaveBeenCalledWith('vscode_create_start')
  })
})
