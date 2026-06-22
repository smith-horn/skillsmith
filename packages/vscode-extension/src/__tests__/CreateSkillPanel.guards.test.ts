/**
 * Guard / edge-case unit tests for views/CreateSkillPanel.ts (SMI-5313 / GH #1454).
 *
 * Split out of CreateSkillPanel.test.ts to keep each file under the 500-line
 * check-file-length gate. Covers: C1 re-entrancy lock, overwrite-decline,
 * C2 dispose-after-success vs cancel/external-close, singleton reveal, and
 * cliOutput streaming. The shared vscode/helpers/telemetry mock setup and the
 * message-handler capture harness are intentionally duplicated (inlined) here
 * rather than imported, to avoid a non-test .ts module in __tests__ confusing
 * vitest globbing.
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
  showNextStepsMock,
} = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
  showWarningMessage: vi.fn(),
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
  trackMock: vi.fn(),
  validateSkillNameMock: vi.fn(),
  runCliMock: vi.fn(),
  existsMock: vi.fn(),
  showNextStepsMock: vi.fn(),
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
  runValidate: vi.fn(),
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
    showNextSteps: showNextStepsMock,
    getInstalledSkills: vi.fn(() => []),
  } as unknown as SkillTreeDataProvider
}

const VALID_FIELDS = {
  author: 'my-author',
  name: 'my-skill',
  description: 'A great skill',
  type: 'basic' as const,
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('CreateSkillPanel (guards / edge cases)', () => {
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

  // ── (e) C1: second submit while first in flight is dropped ─────────────────
  describe('C1: re-entrancy lock', () => {
    it('drops a second submit while the first is in flight', async () => {
      existsMock.mockResolvedValue(false)

      let runCliCalled = false
      let resolveRunCli!: (code: number) => void
      runCliMock.mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            runCliCalled = true
            resolveRunCli = resolve
          })
      )

      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)
      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())

      // Start first submit
      mock.sendMessage({ command: 'submit', fields: VALID_FIELDS })

      // Wait until runCli is called (first submit reached the runCli await)
      await vi.waitFor(() => {
        expect(runCliCalled).toBe(true)
      })

      // Fire second submit — should be dropped (re-entrancy lock is set)
      mock.sendMessage({ command: 'submit', fields: VALID_FIELDS })

      // Resolve the first
      resolveRunCli(0)

      // Wait for completion
      await vi.waitFor(() => {
        expect(mock.panel.dispose).toHaveBeenCalled()
      })

      expect(runCliMock).toHaveBeenCalledTimes(1)
    })
  })

  // ── (f) overwrite: user declines ───────────────────────────────────────────
  describe('overwrite: user declines', () => {
    it('tracks vscode_create_cancelled with stage=overwrite and posts createFailed, no runCli', async () => {
      existsMock.mockResolvedValue(true)
      showWarningMessage.mockResolvedValue('Cancel') // anything other than 'Overwrite'
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
      expect(trackMock).toHaveBeenCalledWith('vscode_create_cancelled', { stage: 'overwrite' })
      expect(runCliMock).not.toHaveBeenCalled()
    })
  })

  // ── (g) C2: dispose after success does NOT fire vscode_create_cancelled ────
  describe('C2: dispose after success', () => {
    it('does not fire vscode_create_cancelled when panel disposed after success', async () => {
      runCliMock.mockResolvedValue(0)
      existsMock.mockResolvedValue(false)
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({ command: 'submit', fields: VALID_FIELDS })

      // Wait for success completion
      await vi.waitFor(() => {
        expect(mock.panel.dispose).toHaveBeenCalled()
      })

      const cancelledCalls = trackMock.mock.calls.filter(
        (call: unknown[]) => call[0] === 'vscode_create_cancelled'
      )
      expect(cancelledCalls).toHaveLength(0)
    })

    // SMI-5346: on success, showNextSteps is called instead of the old toast.
    it('calls showNextSteps on the tree provider after a successful create', async () => {
      runCliMock.mockResolvedValue(0)
      existsMock.mockResolvedValue(false)
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({ command: 'submit', fields: VALID_FIELDS })

      await vi.waitFor(() => {
        expect(showNextStepsMock).toHaveBeenCalledWith(
          VALID_FIELDS.name,
          `/home/user/.claude/skills/${VALID_FIELDS.name}`
        )
      })
    })
  })

  // ── (h) cancel / dispose without success → vscode_create_cancelled ─────────
  describe('C2: cancel / dispose without success', () => {
    it('fires vscode_create_cancelled with stage=wizard when cancel message received', async () => {
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({ command: 'cancel' })

      // cancel calls dispose() synchronously inside _handleMessage
      await vi.waitFor(() => {
        expect(trackMock).toHaveBeenCalledWith('vscode_create_cancelled', { stage: 'wizard' })
      })
    })

    it('fires vscode_create_cancelled when panel closes externally without success (onDidDispose)', () => {
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      // Simulate external close (user closes the webview tab) — synchronous
      mock.triggerExternalClose()

      expect(trackMock).toHaveBeenCalledWith('vscode_create_cancelled', { stage: 'wizard' })
      // L1/L3: the dispose() re-entry guard ensures the cancel fires exactly once.
      const cancelledCalls = trackMock.mock.calls.filter(
        (call: unknown[]) => call[0] === 'vscode_create_cancelled'
      )
      expect(cancelledCalls).toHaveLength(1)
    })
  })

  // ── (i) re-createOrShow with currentPanel set → reveal ────────────────────
  describe('singleton reveal', () => {
    it('reveals existing panel without creating a new one on second createOrShow', () => {
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      // First open
      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      expect(vi.mocked(createWebviewPanel)).toHaveBeenCalledTimes(1)

      // Second open — singleton reveal
      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      expect(vi.mocked(createWebviewPanel)).toHaveBeenCalledTimes(1) // no new panel
      expect(mock.panel.reveal).toHaveBeenCalled()
    })
  })

  // ── cliOutput streaming ────────────────────────────────────────────────────
  describe('cliOutput streaming', () => {
    it('posts cliOutput chunks to the webview as runCli fires onChunk', async () => {
      existsMock.mockResolvedValue(false)
      runCliMock.mockImplementation(
        (_args: string[], _output: unknown, onChunk?: (c: string) => void) => {
          onChunk?.('line 1\n')
          onChunk?.('line 2\n')
          return Promise.resolve(0)
        }
      )
      const mock = createMockPanel()
      vi.mocked(createWebviewPanel).mockReturnValue(mock.panel)

      CreateSkillPanel.createOrShow(EXTENSION_URI, FAKE_OUTPUT, makeTreeProvider())
      mock.sendMessage({ command: 'submit', fields: VALID_FIELDS })

      await vi.waitFor(() => {
        const cliOutputMsgs = mock
          .getPostedMessages()
          .filter((m) => (m as { command: string }).command === 'cliOutput') as {
          command: string
          chunk: string
        }[]
        expect(cliOutputMsgs.some((m) => m.chunk.includes('line 1'))).toBe(true)
      })

      const posted = mock.getPostedMessages()
      const cliOutputMsgs = posted.filter(
        (m) => (m as { command: string }).command === 'cliOutput'
      ) as { command: string; chunk: string }[]
      expect(cliOutputMsgs.some((m) => m.chunk.includes('line 2'))).toBe(true)
    })
  })
})
