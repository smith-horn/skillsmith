/**
 * SMI-5317: lazy Security Advisories auto-load in SkillDetailPanel.
 * Split into its own file (self-contained mock scaffolding) to keep
 * SkillDetailPanel.test.ts under the 500-line gate.
 *
 * Covers: happy-path render + telemetry (H3), stale-skill guard (C1),
 * dispose guard (C2), and session-cached tier denial (M1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((_base: unknown, ...segments: string[]) => ({ fsPath: segments.join('/') })),
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
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
  Disposable: class {
    constructor(private cb: () => void) {}
    dispose() {
      this.cb()
    }
  },
}))

vi.mock('../commands/uninstallCommand.js', () => ({ uninstallByTarget: vi.fn() }))

const { track } = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('../services/Telemetry.js', () => ({ track }))

// The panel branches on `instanceof McpToolError`, so that stays the real class.
const { skillAudit, isConnected } = vi.hoisted(() => ({
  skillAudit: vi.fn(),
  isConnected: vi.fn(() => true),
}))
vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({ skillAudit, isConnected }),
}))

import * as vscode from 'vscode'
import { SkillDetailPanel } from '../views/SkillDetailPanel.js'
import { McpToolError } from '../mcp/McpToolError.js'
import type { SkillService } from '../services/SkillService.js'

function createMockPanel() {
  const htmlValues: string[] = []
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
      onDidReceiveMessage: vi.fn((_h: unknown, _c: unknown, subs: unknown[]) => {
        const d = { dispose: vi.fn() }
        if (Array.isArray(subs)) subs.push(d)
        return d
      }),
      asWebviewUri: vi.fn((uri: { fsPath: string }) => uri),
    },
    onDidDispose: vi.fn((_h: () => void, _c: unknown, subs: unknown[]) => {
      const d = { dispose: vi.fn() }
      if (Array.isArray(subs)) subs.push(d)
      return d
    }),
  }
  return { panel: panel as unknown as vscode.WebviewPanel, getHtmlHistory: () => htmlValues }
}

function createMockSkillService(): SkillService {
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
  } as unknown as SkillService
}

const EXTENSION_URI = { fsPath: '/test/extension' } as vscode.Uri
const ADV = {
  skillName: 'test/skill',
  severity: 'high' as const,
  title: 'A published advisory',
  id: 'SKADV-1',
  fixAvailable: true,
}
const deferred = () => {
  let resolve: (v: unknown) => void = () => {}
  const promise = new Promise((res) => (resolve = res))
  return { promise, resolve }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

async function showPanel(id = 'test/skill'): Promise<ReturnType<typeof createMockPanel>> {
  const mock = createMockPanel()
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
  SkillDetailPanel.createOrShow(EXTENSION_URI, id)
  await vi.waitFor(() => expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Test Skill'))
  return mock
}

describe('SkillDetailPanel lazy advisories (SMI-5317)', () => {
  beforeEach(() => {
    SkillDetailPanel.currentPanel = undefined
    vi.mocked(vscode.window.createWebviewPanel).mockReset()
    track.mockReset()
    skillAudit.mockReset()
    skillAudit.mockResolvedValue({ advisoriesAvailable: false, advisories: [] })
    isConnected.mockReset()
    isConnected.mockReturnValue(true)
    SkillDetailPanel.resetForTests()
    SkillDetailPanel.setTreeProvider(undefined)
  })

  afterEach(() => {
    SkillDetailPanel.resetForTests()
  })

  it('renders advisories after skillAudit resolves and fires telemetry (H3)', async () => {
    SkillDetailPanel.setSkillService(createMockSkillService())
    skillAudit.mockResolvedValue({ advisoriesAvailable: true, advisories: [ADV] })
    const mock = await showPanel()
    await vi.waitFor(() =>
      expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Security Advisories')
    )
    expect(mock.getHtmlHistory().at(-1) ?? '').toContain('A published advisory')
    expect(track).toHaveBeenCalledWith('vscode_advisories_shown', {
      count: 1,
      surface: 'detail-panel',
    })
  })

  it('does NOT apply advisories for a stale skillId (C1)', async () => {
    const first = deferred()
    skillAudit
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ advisoriesAvailable: true, advisories: [] })
    const service = createMockSkillService()
    SkillDetailPanel.setSkillService(service)
    const mock = await showPanel()
    SkillDetailPanel.createOrShow(EXTENSION_URI, 'other/skill')
    await vi.waitFor(() => expect(vi.mocked(service.getRichSkill)).toHaveBeenCalledTimes(2))
    first.resolve({ advisoriesAvailable: true, advisories: [ADV] })
    await tick()
    expect(mock.getHtmlHistory().at(-1) ?? '').not.toContain('A published advisory')
    expect(track).not.toHaveBeenCalledWith('vscode_advisories_shown', expect.anything())
  })

  it('does not re-render when disposed before skillAudit resolves (C2)', async () => {
    const d = deferred()
    skillAudit.mockReturnValue(d.promise)
    SkillDetailPanel.setSkillService(createMockSkillService())
    const mock = await showPanel()
    SkillDetailPanel.currentPanel?.dispose()
    const count = mock.getHtmlHistory().length
    d.resolve({ advisoriesAvailable: true, advisories: [ADV] })
    await tick()
    expect(mock.getHtmlHistory().length).toBe(count)
  })

  it('caches the tier denial and skips the call on the next panel (M1)', async () => {
    SkillDetailPanel.setSkillService(createMockSkillService())
    skillAudit.mockRejectedValue(
      new McpToolError('skill_audit', 'TierDenied', 'Team plan required')
    )
    const mock = await showPanel()
    await vi.waitFor(() => expect(mock.getHtmlHistory().at(-1) ?? '').toContain('advisory-upsell'))
    expect(track).toHaveBeenCalledWith('vscode_advisories_tier_denied', { surface: 'detail-panel' })
    expect(skillAudit).toHaveBeenCalledTimes(1)

    SkillDetailPanel.currentPanel?.dispose()
    skillAudit.mockClear()
    await showPanel()
    await tick()
    expect(skillAudit).not.toHaveBeenCalled()
  })
})
