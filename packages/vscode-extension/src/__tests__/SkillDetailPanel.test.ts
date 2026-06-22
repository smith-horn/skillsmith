/**
 * Unit tests for SkillDetailPanel error handling
 * Tests the error flow, retry mechanism, and missing-service fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock vscode module before any imports that depend on it
vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((_base: unknown, ...segments: string[]) => ({
      fsPath: segments.join('/'),
    })),
    parse: vi.fn((s: string) => ({ toString: () => s })),
    file: vi.fn((s: string) => ({ fsPath: s, scheme: 'file' })),
  },
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: vi.fn(),
    activeTextEditor: undefined,
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  env: {
    openExternal: vi.fn(),
  },
  Disposable: class {
    constructor(private cb: () => void) {}
    dispose() {
      this.cb()
    }
  },
}))

// vi.hoisted so the spy exists before the hoisted vi.mock factory runs.
const { uninstallByTarget } = vi.hoisted(() => ({ uninstallByTarget: vi.fn() }))
vi.mock('../commands/uninstallCommand.js', () => ({
  uninstallByTarget,
}))

vi.mock('../services/Telemetry.js', () => ({
  track: vi.fn(),
}))

// SMI-5317: the panel lazily auto-loads advisories via getMcpClient().skillAudit
// after a successful render. Stub it inert here so these error/action tests stay
// focused; the advisory behaviour itself is covered in
// SkillDetailPanel.advisories.test.ts.
//
// SMI-5341: hoist statusListeners + onStatusChange so tests can fire 'connected'
// events and exercise the auto-refresh guard added in Fix 2.
const { skillAudit, isConnected, statusListeners, onStatusChange } = vi.hoisted(() => {
  const statusListeners: Array<(s: string) => void> = []
  return {
    skillAudit: vi.fn().mockResolvedValue({ advisoriesAvailable: false, advisories: [] }),
    isConnected: vi.fn(() => true),
    statusListeners,
    onStatusChange: vi.fn((cb: (s: string) => void) => {
      statusListeners.push(cb)
      return { dispose: vi.fn() }
    }),
  }
})

vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({ skillAudit, isConnected, onStatusChange }),
}))

/** Fire a status event through all currently-registered listeners. */
const fireStatus = (s: string) => statusListeners.forEach((l) => l(s))

import * as vscode from 'vscode'
import { SkillDetailPanel } from '../views/SkillDetailPanel.js'
import type { SkillService } from '../services/SkillService.js'
import type { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'

/** Creates a mock webview panel with spyable html setter */
function createMockPanel() {
  const htmlValues: string[] = []
  const disposables: (() => void)[] = []
  let messageHandler: ((msg: Record<string, unknown>) => void) | undefined

  const panel = {
    reveal: vi.fn(),
    dispose: vi.fn(),
    title: '',
    webview: {
      get html() {
        return htmlValues[htmlValues.length - 1] ?? ''
      },
      set html(value: string) {
        htmlValues.push(value)
      },
      onDidReceiveMessage: vi.fn(
        (handler: (msg: Record<string, unknown>) => void, _ctx: unknown, subs: unknown[]) => {
          messageHandler = handler
          const disposable = { dispose: vi.fn() }
          if (Array.isArray(subs)) subs.push(disposable)
          return disposable
        }
      ),
      asWebviewUri: vi.fn((uri: { fsPath: string }) => uri),
    },
    onDidDispose: vi.fn((_handler: () => void, _ctx: unknown, subs: unknown[]) => {
      const disposable = { dispose: vi.fn() }
      if (Array.isArray(subs)) subs.push(disposable)
      return disposable
    }),
  }

  return {
    panel: panel as unknown as vscode.WebviewPanel,
    getHtmlHistory: () => htmlValues,
    sendMessage: (msg: Record<string, unknown>) => messageHandler?.(msg),
    disposables,
  }
}

/** Creates a mock SkillService */
function createMockSkillService(
  overrides: Partial<Pick<SkillService, 'getRichSkill' | 'isConnected'>> = {}
): SkillService {
  return {
    getRichSkill: vi.fn().mockResolvedValue({
      skill: {
        id: 'test/skill',
        name: 'Test Skill',
        description: 'A test skill',
        author: 'tester',
        category: 'testing',
        trustTier: 'verified',
        score: 85,
      },
      isOffline: false,
    }),
    isConnected: () => true,
    ...overrides,
  } as unknown as SkillService
}

interface InstalledFixture {
  id: string
  name: string
  path?: string
  hasSkillMd?: boolean
  isInstalled: boolean
}

/** Creates a mock SkillTreeDataProvider exposing installed fixtures. */
function createMockTreeProvider(installed: InstalledFixture[]): SkillTreeDataProvider {
  return {
    getInstalledSkills: vi.fn(() => installed),
    refreshAndWait: vi.fn(async () => {}),
  } as unknown as SkillTreeDataProvider
}

const EXTENSION_URI = { fsPath: '/test/extension' } as vscode.Uri

describe('SkillDetailPanel', () => {
  beforeEach(() => {
    // Reset singleton
    SkillDetailPanel.currentPanel = undefined
    vi.mocked(vscode.window.createWebviewPanel).mockReset()
    vi.mocked(vscode.commands.executeCommand).mockReset()
    uninstallByTarget.mockReset()
    SkillDetailPanel.setTreeProvider(undefined)
    // SMI-5341: drain listeners registered by previous tests so they don't
    // cross-contaminate. Mutate in place so the hoisted reference stays valid.
    statusListeners.length = 0
    skillAudit.mockReset()
    skillAudit.mockResolvedValue({ advisoriesAvailable: false, advisories: [] })
    isConnected.mockReset()
    isConnected.mockReturnValue(true)
    onStatusChange.mockClear()
  })

  afterEach(() => {
    // M1: clear both injected statics so they don't leak across files/tests.
    SkillDetailPanel.resetForTests()
  })

  describe('error HTML on service failure', () => {
    it('renders error HTML when getRichSkill throws', async () => {
      const service = createMockSkillService({
        getRichSkill: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3000')),
      })
      SkillDetailPanel.setSkillService(service)

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)

      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')

      // Wait for async _loadAndUpdate to complete
      await vi.waitFor(() => {
        const history = mock.getHtmlHistory()
        const lastHtml = history[history.length - 1] ?? ''
        expect(lastHtml).toContain('Error Loading Skill')
      })

      const lastHtml = mock.getHtmlHistory().at(-1) ?? ''
      expect(lastHtml).toContain('Could not connect to the skill server')
      expect(lastHtml).toContain('ECONNREFUSED')
      expect(lastHtml).toContain('Technical details')
      expect(lastHtml).toContain('role="alert"')
    })

    it('renders error HTML with raw error in details when message differs', async () => {
      const service = createMockSkillService({
        getRichSkill: vi.fn().mockRejectedValue(new Error('Unexpected token < in JSON')),
      })
      SkillDetailPanel.setSkillService(service)

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)

      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')

      await vi.waitFor(() => {
        const lastHtml = mock.getHtmlHistory().at(-1) ?? ''
        expect(lastHtml).toContain('Error Loading Skill')
      })

      const lastHtml = mock.getHtmlHistory().at(-1) ?? ''
      expect(lastHtml).toContain('Received an unexpected response from the server')
    })
  })

  describe('missing service shows error with reload instructions', () => {
    it('renders reload instructions when SkillService is not set', async () => {
      // Clear the service by setting it to undefined via cast
      ;(SkillDetailPanel as unknown as { _skillService: undefined })._skillService = undefined

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)

      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')

      await vi.waitFor(() => {
        const lastHtml = mock.getHtmlHistory().at(-1) ?? ''
        expect(lastHtml).toContain('Error Loading Skill')
      })

      const lastHtml = mock.getHtmlHistory().at(-1) ?? ''
      expect(lastHtml).toContain('Developer: Reload Window')
      expect(lastHtml).toContain('Command Palette')
    })
  })

  describe('retry triggers _loadAndUpdate', () => {
    it('re-fetches skill data when retry message is received', async () => {
      const getRichSkill = vi
        .fn()
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce({
          skill: {
            id: 'test/skill',
            name: 'Test Skill',
            description: 'A test skill',
            author: 'tester',
            category: 'testing',
            trustTier: 'verified',
            score: 85,
          },
          isOffline: false,
        })

      const service = createMockSkillService({ getRichSkill })
      SkillDetailPanel.setSkillService(service)

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)

      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')

      // Wait for first (failed) load
      await vi.waitFor(() => {
        const lastHtml = mock.getHtmlHistory().at(-1) ?? ''
        expect(lastHtml).toContain('Error Loading Skill')
      })

      expect(getRichSkill).toHaveBeenCalledTimes(1)

      // Simulate retry message from webview
      mock.sendMessage({ command: 'retry' })

      // Wait for second (successful) load
      await vi.waitFor(() => {
        expect(getRichSkill).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('conditional action set (SMI-5308)', () => {
    async function showPanel(): Promise<ReturnType<typeof createMockPanel>> {
      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')
      await vi.waitFor(() => {
        const lastHtml = mock.getHtmlHistory().at(-1) ?? ''
        expect(lastHtml).toContain('Test Skill')
      })
      return mock
    }

    it('renders the installed action set when the skill is installed', async () => {
      SkillDetailPanel.setSkillService(createMockSkillService())
      SkillDetailPanel.setTreeProvider(
        createMockTreeProvider([
          {
            id: 'skill',
            name: 'Test Skill',
            path: '/skills/skill',
            hasSkillMd: true,
            isInstalled: true,
          },
        ])
      )

      const mock = await showPanel()
      const html = mock.getHtmlHistory().at(-1) ?? ''
      expect(html).toContain('id="uninstallBtn"')
      expect(html).toContain('id="openFolderBtn"')
      expect(html).toContain('id="openSkillFileBtn"')
      expect(html).not.toContain('id="installBtn"')
    })

    it('renders Install only when the skill is not installed', async () => {
      SkillDetailPanel.setSkillService(createMockSkillService())
      SkillDetailPanel.setTreeProvider(createMockTreeProvider([]))

      const mock = await showPanel()
      const html = mock.getHtmlHistory().at(-1) ?? ''
      expect(html).toContain('id="installBtn"')
      expect(html).not.toContain('id="uninstallBtn"')
    })

    it('treats the skill as available when no provider is injected (C3)', async () => {
      SkillDetailPanel.setSkillService(createMockSkillService())
      // No setTreeProvider — covers tests + the dead revive path.

      const mock = await showPanel()
      const html = mock.getHtmlHistory().at(-1) ?? ''
      expect(html).toContain('id="installBtn"')
      expect(html).not.toContain('id="uninstallBtn"')
    })

    it('omits Open SKILL.md when the installed skill has no SKILL.md', async () => {
      SkillDetailPanel.setSkillService(createMockSkillService())
      SkillDetailPanel.setTreeProvider(
        createMockTreeProvider([
          {
            id: 'skill',
            name: 'Test Skill',
            path: '/skills/skill',
            hasSkillMd: false,
            isInstalled: true,
          },
        ])
      )

      const mock = await showPanel()
      const html = mock.getHtmlHistory().at(-1) ?? ''
      expect(html).toContain('id="uninstallBtn"')
      expect(html).not.toContain('id="openSkillFileBtn"')
    })
  })

  describe('action message handlers (SMI-5308)', () => {
    async function showInstalledPanel(
      hasSkillMd: boolean
    ): Promise<ReturnType<typeof createMockPanel>> {
      SkillDetailPanel.setSkillService(createMockSkillService())
      SkillDetailPanel.setTreeProvider(
        createMockTreeProvider([
          { id: 'skill', name: 'Test Skill', path: '/skills/skill', hasSkillMd, isInstalled: true },
        ])
      )
      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')
      await vi.waitFor(() => {
        expect(mock.getHtmlHistory().at(-1) ?? '').toContain('id="uninstallBtn"')
      })
      return mock
    }

    it('opens SKILL.md via vscode.open when hasSkillMd', async () => {
      const mock = await showInstalledPanel(true)
      mock.sendMessage({ command: 'openSkillFile' })
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.open',
        expect.objectContaining({ fsPath: '/skills/skill/SKILL.md' })
      )
    })

    it('does not open SKILL.md when hasSkillMd is false', async () => {
      const mock = await showInstalledPanel(false)
      mock.sendMessage({ command: 'openSkillFile' })
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'vscode.open',
        expect.anything()
      )
    })

    it('reveals the folder via revealFileInOS', async () => {
      const mock = await showInstalledPanel(true)
      mock.sendMessage({ command: 'openFolder' })
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'revealFileInOS',
        expect.objectContaining({ fsPath: '/skills/skill' })
      )
    })

    it('disposes the panel after a successful in-panel uninstall (H9)', async () => {
      uninstallByTarget.mockResolvedValue(true)
      const mock = await showInstalledPanel(true)
      mock.sendMessage({ command: 'uninstall' })
      await vi.waitFor(() => {
        expect(uninstallByTarget).toHaveBeenCalledWith(
          { skillId: 'test/skill', skillPath: '/skills/skill' },
          expect.anything(),
          'detail-panel'
        )
      })
      await vi.waitFor(() => {
        expect(mock.panel.dispose).toHaveBeenCalled()
      })
    })

    it('does not dispose the panel when uninstall returns false', async () => {
      uninstallByTarget.mockResolvedValue(false)
      const mock = await showInstalledPanel(true)
      mock.sendMessage({ command: 'uninstall' })
      await vi.waitFor(() => {
        expect(uninstallByTarget).toHaveBeenCalled()
      })
      expect(mock.panel.dispose).not.toHaveBeenCalled()
    })

    it('surfaces a generic error and does not dispose when the core throws (H3)', async () => {
      uninstallByTarget.mockRejectedValue(new Error('Unexpected fs error'))
      const mock = await showInstalledPanel(true)
      mock.sendMessage({ command: 'uninstall' })
      await vi.waitFor(() => {
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('Failed to uninstall')
        )
      })
      expect(mock.panel.dispose).not.toHaveBeenCalled()
    })

    it('dispatches skillsmith.diffSkill with a duck-typed installed arg when diffSkill message received', async () => {
      const mock = await showInstalledPanel(true)
      mock.sendMessage({ command: 'diffSkill' })
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'skillsmith.diffSkill',
        expect.objectContaining({
          skillData: expect.objectContaining({
            id: 'test/skill',
            isInstalled: true,
            path: '/skills/skill',
          }),
        })
      )
    })

    it('does not dispatch skillsmith.diffSkill when the skill is not installed', async () => {
      SkillDetailPanel.setSkillService(createMockSkillService())
      SkillDetailPanel.setTreeProvider(createMockTreeProvider([]))
      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')
      await vi.waitFor(() => {
        expect(mock.getHtmlHistory().at(-1) ?? '').toContain('id="installBtn"')
      })

      mock.sendMessage({ command: 'diffSkill' })
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'skillsmith.diffSkill',
        expect.anything()
      )
    })

    it('aborts with a notice when the skill is gone at click time (M2)', async () => {
      SkillDetailPanel.setSkillService(createMockSkillService())
      // Provider reports the skill installed at load, but empty at click time.
      const provider = createMockTreeProvider([
        {
          id: 'skill',
          name: 'Test Skill',
          path: '/skills/skill',
          hasSkillMd: true,
          isInstalled: true,
        },
      ])
      SkillDetailPanel.setTreeProvider(provider)

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')
      await vi.waitFor(() => {
        expect(mock.getHtmlHistory().at(-1) ?? '').toContain('id="uninstallBtn"')
      })

      // The skill vanished in another window.
      vi.mocked(provider.getInstalledSkills).mockReturnValue([])
      mock.sendMessage({ command: 'uninstall' })

      await vi.waitFor(() => {
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
          'Skill no longer installed — refresh the tree'
        )
      })
      expect(uninstallByTarget).not.toHaveBeenCalled()
    })
  })

  describe('reconnect auto-refresh guard (SMI-5341 Fix 2)', () => {
    // (a) After a failed initial load (_skillData === null), 'connected' triggers
    //     exactly one additional getRichSkill call (the auto-recovery reload).
    it('fires one extra getRichSkill call when connected event arrives after a failed load (a)', async () => {
      const getRichSkill = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // initial load fails
        .mockResolvedValueOnce({
          skill: {
            id: 'test/skill',
            name: 'Test Skill',
            description: 'A test skill',
            author: 'tester',
            category: 'testing',
            trustTier: 'verified',
            score: 85,
          },
          isOffline: false,
        }) // retry succeeds
      SkillDetailPanel.setSkillService(createMockSkillService({ getRichSkill }))

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')

      // Wait for error state — _skillData remains null.
      await vi.waitFor(() => {
        expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Error Loading Skill')
      })
      expect(getRichSkill).toHaveBeenCalledTimes(1)

      // Fire 'connected' — the guard should trigger _loadAndUpdate once.
      fireStatus('connected')

      await vi.waitFor(() => {
        expect(getRichSkill).toHaveBeenCalledTimes(2)
      })
      // The panel should now show success content.
      await vi.waitFor(() => {
        expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Test Skill')
      })
    })

    // (b) After a successful initial load (_skillData set), 'connected' does NOT
    //     trigger another getRichSkill call.
    it('does NOT call getRichSkill again when connected fires after a successful load (b)', async () => {
      const getRichSkill = vi.fn().mockResolvedValue({
        skill: {
          id: 'test/skill',
          name: 'Test Skill',
          description: 'A test skill',
          author: 'tester',
          category: 'testing',
          trustTier: 'verified',
          score: 85,
        },
        isOffline: false,
      })
      SkillDetailPanel.setSkillService(createMockSkillService({ getRichSkill }))

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')

      // Wait for successful load — _skillData is now set.
      await vi.waitFor(() => {
        expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Test Skill')
      })
      expect(getRichSkill).toHaveBeenCalledTimes(1)

      // Fire 'connected' — guard should NOT reload since _skillData !== null.
      fireStatus('connected')
      // Allow microtasks to flush.
      await new Promise((r) => setTimeout(r, 0))

      expect(getRichSkill).toHaveBeenCalledTimes(1)
    })

    // (c) A non-'connected' status event ('error') does not trigger a reload
    //     even when the panel is in error state.
    it('does NOT reload on a non-connected status event like error (c)', async () => {
      const getRichSkill = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      SkillDetailPanel.setSkillService(createMockSkillService({ getRichSkill }))

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')

      await vi.waitFor(() => {
        expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Error Loading Skill')
      })
      expect(getRichSkill).toHaveBeenCalledTimes(1)

      // Fire 'error' — guard condition requires status === 'connected', so no reload.
      fireStatus('error')
      await new Promise((r) => setTimeout(r, 0))

      expect(getRichSkill).toHaveBeenCalledTimes(1)
    })

    // (d) After the panel is disposed, a 'connected' event must NOT call
    //     getRichSkill again and must not throw.
    it('does NOT call getRichSkill after disposal when connected fires (d)', async () => {
      const getRichSkill = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      SkillDetailPanel.setSkillService(createMockSkillService({ getRichSkill }))

      const mock = createMockPanel()
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
      SkillDetailPanel.createOrShow(EXTENSION_URI, 'test/skill')

      await vi.waitFor(() => {
        expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Error Loading Skill')
      })
      expect(getRichSkill).toHaveBeenCalledTimes(1)

      // Dispose the panel — _disposed flips to true, listeners are torn down.
      SkillDetailPanel.currentPanel?.dispose()

      // Fire 'connected' — must not call getRichSkill and must not throw.
      expect(() => fireStatus('connected')).not.toThrow()
      await new Promise((r) => setTimeout(r, 0))

      expect(getRichSkill).toHaveBeenCalledTimes(1)
    })
  })
})
