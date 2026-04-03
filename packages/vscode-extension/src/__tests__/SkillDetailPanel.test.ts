/**
 * Unit tests for SkillDetailPanel error handling
 * Tests the error flow, retry mechanism, and missing-service fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock vscode module before any imports that depend on it
vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((_base: unknown, ...segments: string[]) => ({
      fsPath: segments.join('/'),
    })),
    parse: vi.fn((s: string) => ({ toString: () => s })),
  },
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: vi.fn(),
    activeTextEditor: undefined,
    showWarningMessage: vi.fn(),
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

import * as vscode from 'vscode'
import { SkillDetailPanel } from '../views/SkillDetailPanel.js'
import type { SkillService } from '../services/SkillService.js'

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

const EXTENSION_URI = { fsPath: '/test/extension' } as vscode.Uri

describe('SkillDetailPanel', () => {
  beforeEach(() => {
    // Reset singleton
    SkillDetailPanel.currentPanel = undefined
    vi.mocked(vscode.window.createWebviewPanel).mockReset()
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
})
