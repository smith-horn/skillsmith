/**
 * Tests for SkillDetailPanel local-skill routing (SMI-5401).
 *
 * In a separate file because SkillDetailPanel.test.ts is already 647 lines
 * (above the 500-line audit:standards gate). Same vi.mock topology as the
 * parent file; localSkillReader.js is additionally mocked so we can spy on
 * loadLocalSkillById without touching the real filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

vi.mock('../commands/uninstallCommand.js', () => ({
  uninstallByTarget: vi.fn(),
}))

vi.mock('../services/Telemetry.js', () => ({
  track: vi.fn(),
}))

vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({
    skillAudit: vi.fn().mockResolvedValue({ advisoriesAvailable: false, advisories: [] }),
    isConnected: vi.fn(() => true),
    onStatusChange: vi.fn(() => ({ dispose: vi.fn() })),
  }),
}))

// Hoist the spy so it is defined before vi.mock runs.
const loadLocalSkillByIdMock = vi.hoisted(() => vi.fn())

vi.mock('../services/localSkillReader.js', () => ({
  resolveSkillsRoot: vi.fn(() => '/home/testuser/.claude/skills'),
  resolveLocalSkillDir: vi.fn((id: string) => `/home/testuser/.claude/skills/${id}`),
  loadLocalSkillById: loadLocalSkillByIdMock,
}))

import * as vscode from 'vscode'
import { SkillDetailPanel } from '../views/SkillDetailPanel.js'
import type { SkillService } from '../services/SkillService.js'
import type { ExtendedSkillData } from '../types/skill.js'

// ── Shared helpers ─────────────────────────────────────────────────────────────

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
      onDidReceiveMessage: vi.fn((_handler: unknown, _ctx: unknown, subs: unknown[]) => {
        const disposable = { dispose: vi.fn() }
        if (Array.isArray(subs)) subs.push(disposable)
        return disposable
      }),
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
  }
}

function createMockSkillService(
  overrides: Partial<Pick<SkillService, 'getRichSkill' | 'isConnected'>> = {}
): SkillService {
  return {
    getRichSkill: vi.fn(),
    isConnected: () => true,
    ...overrides,
  } as unknown as SkillService
}

/** Local skill fixture returned by the mocked reader. */
const LOCAL_SKILL_DATA: ExtendedSkillData = {
  id: 'ci-doctor',
  name: 'CI Doctor',
  description: 'Diagnoses CI pipeline issues',
  author: 'local',
  category: 'local',
  trustTier: 'local',
  score: 45,
  version: undefined,
  tags: ['ci', 'testing'],
  installCommand: undefined,
  scoreBreakdown: undefined,
  content: '# CI Doctor\n\nThis skill diagnoses CI pipeline issues.',
  securityPassed: null,
  securityRiskScore: null,
  securityScannedAt: null,
  securityFindingsCount: null,
}

const EXTENSION_URI = { fsPath: '/test/extension' } as vscode.Uri

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SkillDetailPanel — local skill routing (SMI-5401)', () => {
  beforeEach(() => {
    SkillDetailPanel.currentPanel = undefined
    vi.mocked(vscode.window.createWebviewPanel).mockReset()
    SkillDetailPanel.setTreeProvider(undefined)
    loadLocalSkillByIdMock.mockReset()
  })

  afterEach(() => {
    SkillDetailPanel.resetForTests()
  })

  it('routes a bare-slug id to loadLocalSkillById without calling getRichSkill', async () => {
    const getRichSkill = vi.fn()
    SkillDetailPanel.setSkillService(createMockSkillService({ getRichSkill }))
    loadLocalSkillByIdMock.mockResolvedValue(LOCAL_SKILL_DATA)

    const mock = createMockPanel()
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)

    // 'ci-doctor' is a bare slug → isLocalSkillId returns true → local path
    SkillDetailPanel.createOrShow(EXTENSION_URI, 'ci-doctor')

    await vi.waitFor(() => {
      expect(mock.getHtmlHistory().at(-1) ?? '').toContain('CI Doctor')
    })

    // The local reader was called; the registry was not.
    expect(loadLocalSkillByIdMock).toHaveBeenCalledWith('ci-doctor', undefined)
    expect(getRichSkill).not.toHaveBeenCalled()
  })

  it('renders panel content from the local reader, not the registry', async () => {
    SkillDetailPanel.setSkillService(createMockSkillService())
    loadLocalSkillByIdMock.mockResolvedValue(LOCAL_SKILL_DATA)

    const mock = createMockPanel()
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)

    SkillDetailPanel.createOrShow(EXTENSION_URI, 'ci-doctor')

    await vi.waitFor(() => {
      expect(mock.getHtmlHistory().at(-1) ?? '').toContain('CI Doctor')
    })

    const html = mock.getHtmlHistory().at(-1) ?? ''
    expect(html).toContain('Diagnoses CI pipeline issues')
    expect(html).toContain('CI Doctor')
  })

  it('renders error HTML (with M3 message) when the local reader rejects', async () => {
    SkillDetailPanel.setSkillService(createMockSkillService())
    loadLocalSkillByIdMock.mockRejectedValue(
      new Error('Skill "ci-doctor" has no SKILL.md. Check ~/.claude/skills/ci-doctor/')
    )

    const mock = createMockPanel()
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)

    SkillDetailPanel.createOrShow(EXTENSION_URI, 'ci-doctor')

    await vi.waitFor(() => {
      expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Error Loading Skill')
    })

    const html = mock.getHtmlHistory().at(-1) ?? ''
    expect(html).toContain('has no SKILL.md')
  })

  it('does NOT route an owner/repo id to the local reader', async () => {
    const getRichSkill = vi.fn().mockResolvedValue({
      skill: {
        id: 'smith-horn/governance',
        name: 'Governance',
        description: 'Enforces standards',
        author: 'smith-horn',
        category: 'development',
        trustTier: 'verified',
        score: 95,
        version: undefined,
        tags: [],
        installCommand: undefined,
        scoreBreakdown: undefined,
        securityPassed: null,
        securityRiskScore: null,
        securityScannedAt: null,
        securityFindingsCount: null,
      },
      isOffline: false,
    })
    SkillDetailPanel.setSkillService(createMockSkillService({ getRichSkill }))

    const mock = createMockPanel()
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)

    // 'smith-horn/governance' is owner/repo → isLocalSkillId returns false → registry path
    SkillDetailPanel.createOrShow(EXTENSION_URI, 'smith-horn/governance')

    await vi.waitFor(() => {
      expect(mock.getHtmlHistory().at(-1) ?? '').toContain('Governance')
    })

    expect(loadLocalSkillByIdMock).not.toHaveBeenCalled()
    expect(getRichSkill).toHaveBeenCalledWith('smith-horn/governance')
  })
})
