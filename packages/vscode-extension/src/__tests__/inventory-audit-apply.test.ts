/**
 * Interactive-apply flow for InventoryAuditPanel (SMI-5325).
 *
 * Drives the panel through real HTML builders + a mocked McpClient, asserting
 * the preview→confirm→apply→re-audit sequence, the re-entrancy guard, the
 * confirm-cancel path, structured-error self-heal, and the UnknownTool collapse.
 * Webview messages are fire-and-forget (`void _handleMessage`), so async work is
 * awaited via `vi.waitFor`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted spies (must exist before the vi.mock factories run) ────────────
const { fakeClient, trackMock, showWarningMessage, showInformationMessage, showErrorMessage } =
  vi.hoisted(() => ({
    fakeClient: {
      isConnected: vi.fn(() => true),
      skillInventoryAudit: vi.fn(),
      applyNamespaceRename: vi.fn(),
      applyRecommendedEdit: vi.fn(),
    },
    trackMock: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  }))

vi.mock('vscode', () => ({
  Uri: { file: vi.fn((s: string) => ({ fsPath: s, scheme: 'file' })) },
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: vi.fn(),
    activeTextEditor: undefined,
    showWarningMessage,
    showInformationMessage,
    showErrorMessage,
  },
  Disposable: class {
    constructor(private cb: () => void) {}
    dispose() {
      this.cb()
    }
  },
}))

vi.mock('../mcp/McpClient.js', () => ({ getMcpClient: () => fakeClient }))
vi.mock('../services/Telemetry.js', () => ({ track: trackMock }))

import * as vscode from 'vscode'
import { McpToolError } from '../mcp/McpToolError.js'
import { InventoryAuditPanel } from '../views/InventoryAuditPanel.js'
import type { McpInventoryAuditResponse } from '../mcp/types.js'

// ── Mock webview panel (captures the message handler) ─────────────────────────
function createMockPanel() {
  let messageHandler: ((msg: unknown) => void) | undefined
  const panel = {
    reveal: vi.fn(),
    dispose: vi.fn(),
    title: '',
    webview: {
      html: '',
      onDidReceiveMessage: vi.fn(
        (handler: (msg: unknown) => void, _ctx: unknown, subs: { dispose: () => void }[]) => {
          messageHandler = handler
          const d = { dispose: vi.fn() }
          if (Array.isArray(subs)) subs.push(d)
          return d
        }
      ),
      postMessage: vi.fn(() => Promise.resolve(true)),
    },
    onDidDispose: vi.fn((_h: () => void, _c: unknown, subs: { dispose: () => void }[]) => {
      const d = { dispose: vi.fn() }
      if (Array.isArray(subs)) subs.push(d)
      return d
    }),
  }
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    send: (msg: unknown) => messageHandler?.(msg),
    html: () => panel.webview.html,
  }
}

const URI = { fsPath: '/ext' } as vscode.Uri

function makeEntry(id = 'org/foo') {
  return {
    kind: 'skill' as const,
    source_path: `/home/u/.claude/skills/${id}`,
    identifier: id,
    triggerSurface: [] as string[],
  }
}

function makeResponse(
  editApplyMode: 'manual_review' | 'apply_with_confirmation' = 'apply_with_confirmation'
): McpInventoryAuditResponse {
  return {
    auditId: 'aud_test',
    inventory: [makeEntry()],
    exactCollisions: [
      {
        kind: 'exact',
        collisionId: 'c1',
        identifier: 'org/foo',
        entries: [makeEntry(), makeEntry('org/bar')],
        severity: 'error',
        reason: 'dup',
      },
    ],
    genericFlags: [],
    semanticCollisions: [],
    renameSuggestions: [
      {
        collisionId: 'c1',
        entry: makeEntry(),
        currentName: 'foo',
        suggested: 'foo-2',
        applyAction: 'rename_skill_dir_and_frontmatter',
        reason: 'collision',
      },
    ],
    recommendedEdits: [
      {
        collisionId: 'c3',
        category: 'description_overlap',
        pattern: 'add_domain_qualifier',
        filePath: '/home/u/.claude/skills/org/foo/SKILL.md',
        lineRange: { start: 1, end: 2 },
        before: 'b',
        after: 'a',
        rationale: 'r',
        applyAction: 'recommended_edit',
        applyMode: editApplyMode,
        otherEntry: { identifier: 'org/bar', sourcePath: '/p' },
      },
    ],
    reportPath: '/home/u/.skillsmith/audits/aud_test/report.md',
    summary: { totalEntries: 2, totalFlags: 1, errorCount: 1, warningCount: 0, durationMs: 5 },
  }
}

const CLEAN_RESPONSE: McpInventoryAuditResponse = {
  ...makeResponse(),
  exactCollisions: [],
  renameSuggestions: [],
  recommendedEdits: [],
  summary: { totalEntries: 2, totalFlags: 0, errorCount: 0, warningCount: 0, durationMs: 5 },
}

describe('InventoryAuditPanel interactive apply (SMI-5325)', () => {
  let mock: ReturnType<typeof createMockPanel>

  beforeEach(() => {
    InventoryAuditPanel.resetForTests()
    fakeClient.isConnected.mockReset().mockReturnValue(true)
    fakeClient.skillInventoryAudit.mockReset().mockResolvedValue(CLEAN_RESPONSE)
    fakeClient.applyNamespaceRename.mockReset()
    fakeClient.applyRecommendedEdit.mockReset()
    trackMock.mockReset()
    showWarningMessage.mockReset()
    showInformationMessage.mockReset()
    showErrorMessage.mockReset()
    mock = createMockPanel()
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mock.panel)
  })

  it('rename happy path: preview(confirmed:false) → modal → apply(confirmed:true) → re-audit', async () => {
    fakeClient.applyNamespaceRename
      .mockResolvedValueOnce({
        success: true,
        preview: true,
        collisionId: 'c1',
        before: 'foo',
        after: 'foo-2',
        applied: false,
      })
      .mockResolvedValueOnce({ success: true, collisionId: 'c1' })
    showWarningMessage.mockResolvedValue('Apply')

    InventoryAuditPanel.createOrShow(URI, makeResponse())
    mock.send({ command: 'applyRename', collisionId: 'c1' })

    await vi.waitFor(() => expect(fakeClient.applyNamespaceRename).toHaveBeenCalledTimes(2))
    expect(fakeClient.applyNamespaceRename).toHaveBeenNthCalledWith(1, {
      auditId: 'aud_test',
      collisionId: 'c1',
      action: 'apply',
      confirmed: false,
    })
    expect(fakeClient.applyNamespaceRename).toHaveBeenNthCalledWith(2, {
      auditId: 'aud_test',
      collisionId: 'c1',
      action: 'apply',
      confirmed: true,
    })
    await vi.waitFor(() => expect(fakeClient.skillInventoryAudit).toHaveBeenCalled())
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('backup was saved'))
    expect(trackMock).toHaveBeenCalledWith('vscode_inventory_apply_applied', { kind: 'rename' })
    // Re-audit rendered the clean state with the announced status message.
    expect(mock.html()).toContain('No namespace collisions found.')
    expect(mock.html()).toContain('a backup was saved')
  })

  it('confirm cancelled: apply(confirmed:true) is NOT called, no re-audit', async () => {
    fakeClient.applyNamespaceRename.mockResolvedValueOnce({
      success: true,
      preview: true,
      collisionId: 'c1',
      before: 'foo',
      after: 'foo-2',
      applied: false,
    })
    showWarningMessage.mockResolvedValue(undefined)

    InventoryAuditPanel.createOrShow(URI, makeResponse())
    mock.send({ command: 'applyRename', collisionId: 'c1' })

    await vi.waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('vscode_inventory_apply_cancelled', { kind: 'rename' })
    )
    expect(fakeClient.applyNamespaceRename).toHaveBeenCalledTimes(1)
    expect(fakeClient.skillInventoryAudit).not.toHaveBeenCalled()
  })

  it('re-entrancy: a second apply while one is in flight is ignored', async () => {
    fakeClient.applyNamespaceRename.mockReturnValue(new Promise(() => {})) // never resolves
    InventoryAuditPanel.createOrShow(URI, makeResponse())

    mock.send({ command: 'applyRename', collisionId: 'c1' })
    mock.send({ command: 'applyRename', collisionId: 'c1' })

    // The guard is set synchronously before the first await, so the second is a no-op.
    expect(fakeClient.applyNamespaceRename).toHaveBeenCalledTimes(1)
  })

  it('retry is ignored while an apply is in flight (no _response swap mid-flow)', async () => {
    // Apply preview never resolves → the flow is parked with _applyInFlight set.
    fakeClient.applyNamespaceRename.mockReturnValue(new Promise(() => {}))
    InventoryAuditPanel.createOrShow(URI, makeResponse())

    mock.send({ command: 'applyRename', collisionId: 'c1' })
    mock.send({ command: 'retry' })

    // The user-retry must NOT re-audit (which would swap _response mid-apply).
    expect(fakeClient.skillInventoryAudit).not.toHaveBeenCalled()
  })

  it('unknown collisionId from the webview is a no-op', async () => {
    InventoryAuditPanel.createOrShow(URI, makeResponse())
    mock.send({ command: 'applyRename', collisionId: 'does-not-exist' })

    expect(fakeClient.applyNamespaceRename).not.toHaveBeenCalled()
  })

  it('collision_not_found on preview self-heals via re-audit (no confirm, no mutation)', async () => {
    fakeClient.applyNamespaceRename.mockResolvedValueOnce({
      success: false,
      collisionId: 'c1',
      errorCode: 'namespace.audit.collision_not_found',
      error: 'gone',
    })

    InventoryAuditPanel.createOrShow(URI, makeResponse())
    mock.send({ command: 'applyRename', collisionId: 'c1' })

    await vi.waitFor(() => expect(fakeClient.skillInventoryAudit).toHaveBeenCalled())
    expect(showWarningMessage).not.toHaveBeenCalled() // never reached the confirm modal
    expect(fakeClient.applyNamespaceRename).toHaveBeenCalledTimes(1) // preview only
    expect(trackMock).toHaveBeenCalledWith('vscode_inventory_apply_failed', {
      kind: 'rename',
      errorCode: 'namespace.audit.collision_not_found',
    })
  })

  it('applyEdit UnknownTool collapses edit buttons to the manual-review hint', async () => {
    fakeClient.applyRecommendedEdit.mockRejectedValueOnce(
      new McpToolError('apply_recommended_edit', 'UnknownTool', 'Unknown tool')
    )

    InventoryAuditPanel.createOrShow(URI, makeResponse('apply_with_confirmation'))
    // The Apply-edit button carries the edit collisionId c3 (the delegated-click
    // script also names `apply-edit-btn`, so assert on the unique data-collision).
    expect(mock.html()).toContain('data-collision="c3"') // edit button present pre-click
    mock.send({ command: 'applyEdit', collisionId: 'c3' })

    await vi.waitFor(() => expect(mock.html()).toContain('Review and apply manually'))
    expect(mock.html()).not.toContain('data-collision="c3"') // collapsed to the hint
    expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("isn't supported"))
  })

  it('not connected: apply surfaces a connect prompt and does not call the tool', async () => {
    fakeClient.isConnected.mockReturnValue(false)
    InventoryAuditPanel.createOrShow(URI, makeResponse())
    mock.send({ command: 'applyRename', collisionId: 'c1' })

    await vi.waitFor(() =>
      expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('not connected'))
    )
    expect(fakeClient.applyNamespaceRename).not.toHaveBeenCalled()
  })
})
