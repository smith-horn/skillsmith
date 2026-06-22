/**
 * Unit tests for views/CreateSkillPanel.ts (SMI-5313 / GH #1454).
 *
 * Mirrors the mocking style of SkillDetailPanel.test.ts (vi.hoisted for
 * spies that must exist before the vi.mock factory runs, vi.waitFor for
 * the async panel work that is fired via `void _handleMessage(...)` — the
 * webview message handler is fire-and-forget so sendMessage resolves before
 * the async handler chain completes).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── vi.hoisted: spies that must exist before the vi.mock factory runs ─────────
const {
  createWebviewPanel,
  showWarningMessage,
  openTextDocument,
  showTextDocument,
  trackMock,
  validateSkillNameMock,
  runCliMock,
  existsMock,
} = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
  showWarningMessage: vi.fn(),
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
  trackMock: vi.fn(),
  validateSkillNameMock: vi.fn(),
  runCliMock: vi.fn(),
  existsMock: vi.fn(),
}))

// ── vscode mock ──────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((_base: unknown, ...segments: string[]) => ({
      fsPath: segments.join('/'),
    })),
    file: vi.fn((s: string) => ({ fsPath: s, scheme: 'file' })),
    parse: vi.fn((s: string) => ({ toString: () => s })),
  },
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel,
    activeTextEditor: undefined,
    showWarningMessage,
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    openTextDocument,
    showTextDocument,
  },
  workspace: { openTextDocument },
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
  Disposable: class {
    constructor(private cb: () => void) {}
    dispose() {
      this.cb()
    }
  },
}))

// ── helpers mock ─────────────────────────────────────────────────────────────
vi.mock('../utils/createSkill.helpers.js', () => ({
  buildCreateArgs: (fields: {
    author: string
    name: string
    description: string
    type: string
  }) => [
    'create',
    fields.name,
    '-a',
    fields.author,
    '-d',
    fields.description,
    '--type',
    fields.type,
    '-y',
  ],
  targetDirFor: (name: string) => `/home/user/.claude/skills/${name}`,
  runCli: runCliMock,
  exists: existsMock,
}))

// ── CSP / nonce mock ─────────────────────────────────────────────────────────
vi.mock('../utils/csp.js', () => ({
  generateCspNonce: () => 'test-nonce-123',
  getCreateSkillCsp: () => "default-src 'none';",
}))

// ── HTML mock ─────────────────────────────────────────────────────────────────
vi.mock('../views/create-panel-html.js', () => ({
  getCreateSkillHtml: () => '<html><body>mock</body></html>',
}))

// ── Telemetry mock ───────────────────────────────────────────────────────────
vi.mock('../services/Telemetry.js', () => ({
  track: trackMock,
}))

// ── validateSkillName mock ────────────────────────────────────────────────────
vi.mock('../utils/skillNameValidation.js', () => ({
  validateSkillName: validateSkillNameMock,
}))

// ── SkillTreeDataProvider mock ────────────────────────────────────────────────
const refreshAndWait = vi.fn(async () => {})
// SMI-5346: the post-create toast was replaced by the sidebar "Next steps"
// section — the panel now calls `treeProvider.showNextSteps(name, targetDir)`.
const showNextStepsMock = vi.fn()
vi.mock('../sidebar/SkillTreeDataProvider.js', () => ({
  SkillTreeDataProvider: class {
    refreshAndWait = refreshAndWait
    showNextSteps = showNextStepsMock
  },
}))

// ── Imports under test (after all mocks) ─────────────────────────────────────
import * as vscode from 'vscode'
import type { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import type { CreatePanelInbound } from '../views/create-panel-types.js'
import { CreateSkillPanel } from '../views/CreateSkillPanel.js'

// ── Test helpers ─────────────────────────────────────────────────────────────
type MessageHandler = (msg: CreatePanelInbound) => void | Promise<void>

/**
 * Creates a mock webview panel.
 *
 * Key design notes:
 * 1. `panel.dispose()` just records the call (does NOT fire disposeHandler).
 *    This breaks the infinite recursion: CreateSkillPanel.dispose() →
 *    this._panel.dispose() → disposeHandler() → CreateSkillPanel.dispose().
 *    In real VS Code, panel.dispose() fires onDidDispose asynchronously after
 *    the call, and CreateSkillPanel guards re-entry with `_disposed`.
 *
 * 2. The onDidReceiveMessage handler is fired with `void _handleMessage(...)` —
 *    fire-and-forget. So `sendMessage` returns before async work completes.
 *    Tests that trigger async work (submit, cancel) MUST use `vi.waitFor()`
 *    to await the expected side-effect rather than awaiting sendMessage itself.
 */
function createMockPanel() {
  let messageHandler: MessageHandler | undefined
  let disposeHandler: (() => void) | undefined
  const postedMessages: unknown[] = []

  const panel = {
    reveal: vi.fn(),
    // panel.dispose() just records — does NOT fire disposeHandler (breaks recursion).
    dispose: vi.fn(),
    title: 'Create Skill',
    webview: {
      html: '',
      onDidReceiveMessage: vi.fn(
        (handler: MessageHandler, _ctx: unknown, subs: { dispose: () => void }[]) => {
          messageHandler = handler
          const d = { dispose: vi.fn() }
          if (Array.isArray(subs)) subs.push(d)
          return d
        }
      ),
      postMessage: vi.fn((msg: unknown) => {
        postedMessages.push(msg)
        return Promise.resolve(true)
      }),
      asWebviewUri: vi.fn((uri: unknown) => uri),
    },
    onDidDispose: vi.fn((handler: () => void, _ctx: unknown, subs: { dispose: () => void }[]) => {
      disposeHandler = handler
      const d = { dispose: vi.fn() }
      if (Array.isArray(subs)) subs.push(d)
      return d
    }),
  }

  return {
    panel: panel as unknown as vscode.WebviewPanel,
    /** Fire the onDidReceiveMessage handler (returns before async work completes). */
    sendMessage: (msg: CreatePanelInbound) => {
      messageHandler?.(msg)
    },
    getPostedMessages: () => postedMessages,
    /**
     * Simulate an external close (user closes the webview tab).
     * Fires onDidDispose directly — does NOT go through panel.dispose().
     */
    triggerExternalClose: () => {
      disposeHandler?.()
    },
  }
}

const EXTENSION_URI = { fsPath: '/ext' } as vscode.Uri
const FAKE_OUTPUT = {
  append: vi.fn(),
  appendLine: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
} as unknown as vscode.OutputChannel

function makeTreeProvider(): SkillTreeDataProvider {
  return {
    refreshAndWait,
    getInstalledSkills: vi.fn(() => []),
    showNextSteps: showNextStepsMock,
  } as unknown as SkillTreeDataProvider
}

const VALID_FIELDS = {
  author: 'my-author',
  name: 'my-skill',
  description: 'A great skill',
  type: 'basic' as const,
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('CreateSkillPanel', () => {
  beforeEach(() => {
    vi.mocked(createWebviewPanel).mockReset()
    trackMock.mockReset()
    validateSkillNameMock.mockReset().mockReturnValue(true)
    runCliMock.mockReset().mockResolvedValue(0)
    existsMock.mockReset().mockResolvedValue(false)
    showNextStepsMock.mockReset()
    refreshAndWait.mockReset().mockResolvedValue(undefined)
    showWarningMessage.mockReset()
    openTextDocument.mockReset().mockRejectedValue(new Error('not found'))
    showTextDocument.mockReset()
  })

  afterEach(() => {
    CreateSkillPanel.resetForTests()
  })

  // ── (a) validateName ────────────────────────────────────────────────────────
  describe('validateName message', () => {
    it('posts nameValidity with valid=true when name is valid', async () => {
      validateSkillNameMock.mockReturnValue(true)
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({ command: 'validateName', value: 'good-skill' })

      // validateName is synchronous in _handleMessage — posts immediately
      await vi.waitFor(() => {
        expect(mock.getPostedMessages()).toContainEqual({ command: 'nameValidity', valid: true })
      })
    })

    it('posts nameValidity with valid=false and message when name is invalid', async () => {
      validateSkillNameMock.mockReturnValue('Name must be lowercase')
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({ command: 'validateName', value: 'BadName' })

      await vi.waitFor(() => {
        expect(mock.getPostedMessages()).toContainEqual({
          command: 'nameValidity',
          valid: false,
          message: 'Name must be lowercase',
        })
      })
    })
  })

  // ── (b) submit with invalid fields ─────────────────────────────────────────
  describe('submit with invalid fields', () => {
    it('posts submitError and does not call runCli when fields are invalid', async () => {
      validateSkillNameMock.mockReturnValue('Name is invalid')
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({
        command: 'submit',
        fields: { author: '', name: '', description: '', type: 'basic' },
      })

      await vi.waitFor(() => {
        expect(
          mock.getPostedMessages().some((m) => (m as { command: string }).command === 'submitError')
        ).toBe(true)
      })
      expect(runCliMock).not.toHaveBeenCalled()
      expect(mock.panel.dispose).not.toHaveBeenCalled()
    })
  })

  // ── (c) submit valid, exit 0 ────────────────────────────────────────────────
  describe('submit valid fields, CLI exits 0', () => {
    it('posts creating, calls runCli with buildCreateArgs, tracks complete, disposes, calls checklist', async () => {
      runCliMock.mockResolvedValue(0)
      existsMock.mockResolvedValue(false)
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({ command: 'submit', fields: VALID_FIELDS })

      // Wait for the success path to complete (panel.dispose is the terminal signal)
      await vi.waitFor(() => {
        expect(mock.panel.dispose).toHaveBeenCalled()
      })

      const posted = mock.getPostedMessages()
      expect(posted.some((m) => (m as { command: string }).command === 'creating')).toBe(true)
      expect(runCliMock).toHaveBeenCalledWith(
        ['create', 'my-skill', '-a', 'my-author', '-d', 'A great skill', '--type', 'basic', '-y'],
        FAKE_OUTPUT,
        expect.any(Function)
      )
      expect(trackMock).toHaveBeenCalledWith('vscode_create_complete', { type: 'basic' })
      expect(refreshAndWait).toHaveBeenCalled()
      expect(showNextStepsMock).toHaveBeenCalledWith(
        'my-skill',
        '/home/user/.claude/skills/my-skill'
      )
    })
  })

  // ── (d) CLI exits non-zero ──────────────────────────────────────────────────
  describe('submit valid fields, CLI exits non-zero', () => {
    it('posts createFailed, tracks vscode_create_failed, does not dispose', async () => {
      runCliMock.mockResolvedValue(2)
      existsMock.mockResolvedValue(false)
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({ command: 'submit', fields: VALID_FIELDS })

      await vi.waitFor(() => {
        expect(
          mock
            .getPostedMessages()
            .some((m) => (m as { command: string }).command === 'createFailed')
        ).toBe(true)
      })
      expect(trackMock).toHaveBeenCalledWith('vscode_create_failed', {
        reason: 'cli_nonzero_exit',
        exit_code: 2,
      })
      expect(mock.panel.dispose).not.toHaveBeenCalled()
    })
  })
})
