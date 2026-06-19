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
})
