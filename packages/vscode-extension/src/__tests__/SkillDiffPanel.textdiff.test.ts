/**
 * Tests for SkillDiffPanel's native text-diff action (SMI-5323).
 *
 * Drives the webview `viewTextDiff` message and asserts the panel opens VS
 * Code's built-in diff editor (`vscode.diff`) with the two `skillsmith-diff:`
 * URIs that the (real) content provider serves. Mirrors the createWebviewPanel
 * mock style of CreateSkillPanel.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeCommand = vi.hoisted(() => vi.fn())
const createWebviewPanel = vi.hoisted(() => vi.fn())

vi.mock('vscode', () => ({
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  ViewColumn: { One: 1 },
  window: { createWebviewPanel, activeTextEditor: undefined },
  commands: { executeCommand },
  Disposable: class {
    constructor(private cb: () => void) {}
    dispose() {
      this.cb()
    }
  },
}))

vi.mock('../views/diff-panel-html.js', () => ({
  getDiffHtml: () => '<html><body>diff</body></html>',
  getDiffErrorHtml: () => '<html><body>error</body></html>',
}))
vi.mock('../views/skill-panel-html.js', () => ({ getLoadingHtml: () => '<html>loading</html>' }))
vi.mock('../utils/csp.js', () => ({
  generateCspNonce: () => 'nonce',
  getSkillDiffCsp: () => "default-src 'none';",
}))
vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({
    isConnected: () => true,
    // Present so the retry path resolves cleanly (no unhandled rejection).
    skillDiff: vi.fn().mockResolvedValue({ changeType: 'minor' }),
  }),
}))
vi.mock('../mcp/tierDenied.js', () => ({ handleTierDenied: vi.fn() }))

import * as vscode from 'vscode'
import { SkillDiffPanel } from '../views/SkillDiffPanel.js'
import type { McpSkillDiffResponse } from '../mcp/types.js'
import type { SkillDiffArgs } from '../views/diff-panel-types.js'

type MessageHandler = (msg: { command: string }) => void

function createMockPanel() {
  let messageHandler: MessageHandler | undefined
  const panel = {
    reveal: vi.fn(),
    dispose: vi.fn(),
    title: '',
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
    },
    onDidDispose: vi.fn((_h: () => void, _ctx: unknown, subs: { dispose: () => void }[]) => {
      const d = { dispose: vi.fn() }
      if (Array.isArray(subs)) subs.push(d)
      return d
    }),
  }
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    send: (msg: { command: string }) => messageHandler?.(msg),
  }
}

const RESPONSE = { changeType: 'minor' } as McpSkillDiffResponse
const ARGS: SkillDiffArgs = {
  skillId: 'smith-horn/docker',
  oldContent: 'OLD CONTENT',
  newContent: 'NEW CONTENT',
}

describe('SkillDiffPanel — viewTextDiff (SMI-5323)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    SkillDiffPanel.resetForTests()
  })

  it('opens vscode.diff with installed + latest skillsmith-diff URIs and a titled label', () => {
    const mock = createMockPanel()
    createWebviewPanel.mockReturnValue(mock.panel)

    SkillDiffPanel.createOrShow({} as vscode.Uri, 'docker', RESPONSE, ARGS)
    mock.send({ command: 'viewTextDiff' })

    expect(executeCommand).toHaveBeenCalledTimes(1)
    const [command, oldUri, newUri, title] = executeCommand.mock.calls[0] as [
      string,
      vscode.Uri,
      vscode.Uri,
      string,
    ]
    expect(command).toBe('vscode.diff')
    expect(oldUri.toString()).toBe('skillsmith-diff:smith-horn%2Fdocker/installed.md')
    expect(newUri.toString()).toBe('skillsmith-diff:smith-horn%2Fdocker/latest.md')
    expect(title).toBe('docker: installed ↔ latest')
  })

  it('uses the refreshed args after the singleton panel is reused for another skill', () => {
    const mock = createMockPanel()
    createWebviewPanel.mockReturnValue(mock.panel)

    SkillDiffPanel.createOrShow({} as vscode.Uri, 'docker', RESPONSE, ARGS)
    // Reuse the open panel for a different skill (no new webview created).
    const argsB: SkillDiffArgs = {
      skillId: 'community/kubectl',
      oldContent: 'K8S OLD',
      newContent: 'K8S NEW',
    }
    SkillDiffPanel.createOrShow({} as vscode.Uri, 'kubectl', RESPONSE, argsB)
    expect(createWebviewPanel).toHaveBeenCalledTimes(1)

    mock.send({ command: 'viewTextDiff' })

    const [, oldUri, newUri, title] = executeCommand.mock.calls[0] as [
      string,
      vscode.Uri,
      vscode.Uri,
      string,
    ]
    expect(oldUri.toString()).toBe('skillsmith-diff:community%2Fkubectl/installed.md')
    expect(newUri.toString()).toBe('skillsmith-diff:community%2Fkubectl/latest.md')
    expect(title).toBe('kubectl: installed ↔ latest')
  })

  it('does not open a diff for an unrelated message', () => {
    const mock = createMockPanel()
    createWebviewPanel.mockReturnValue(mock.panel)

    SkillDiffPanel.createOrShow({} as vscode.Uri, 'docker', RESPONSE, ARGS)
    mock.send({ command: 'retry' })

    expect(executeCommand).not.toHaveBeenCalled()
  })
})
