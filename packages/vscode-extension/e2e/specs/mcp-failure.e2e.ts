/**
 * MCP failure + recovery (SMI-5331 Phase 2a — graceful-degradation leg).
 *
 * Test 1 — spawn failure: serverCommand → nonexistent binary. The audit command
 * early-returns (!isConnected()) showing an info toast, never opening a panel or
 * reaching the fake server.  Restoring the real node path reconnects and the
 * panel opens (recovery).
 * Source: auditInventoryCommand.ts:22-28 — `if (!client.isConnected()) { ... return }`
 *
 * Test 2 — isError scenario: fake server returns isError:true on every tools/call.
 * callMcpTool throws McpToolError; auditInventoryCommand.ts:56-58 catches it and
 * surfaces showErrorMessage — no panel.  Restoring origArgs reconnects + panel opens.
 * Source: fake-mcp-server.mjs:91-95 (isError payload), callTool.ts:87-89 (throw),
 *         auditInventoryCommand.ts:56-58 (catch → showErrorMessage).
 *
 * Config-change auto-reconnect: extension.ts:219-225
 *   `onDidChangeConfiguration → initializeMcpClientFromSettings() + void connectWithProgress()`
 */
import { browser, expect } from '@wdio/globals'
import { readFileSync } from 'node:fs'
import { InventoryAuditPage } from '../pageobjects/inventory-audit.page.js'
import { FAKE_MCP_LOG } from '../fixtures/fake-mcp-log-path.mjs'

function readLog(): Array<Record<string, unknown>> {
  try {
    return readFileSync(FAKE_MCP_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null)
  } catch {
    return []
  }
}

const auditToolWasCalled = (): boolean =>
  readLog().some((e) => e['t'] === 'tools/call' && e['name'] === 'skill_inventory_audit')

const PANEL_TITLE = 'Skill Inventory Audit'

describe('MCP failure + recovery (SMI-5331)', () => {
  const page = new InventoryAuditPage()

  it('spawn failure: audit no-ops gracefully; recovery opens the panel', async () => {
    await page.forceConnect()

    const origCmd = (await browser.executeWorkbench((vscode) =>
      vscode.workspace.getConfiguration('skillsmith').get('mcp.serverCommand')
    )) as string | undefined

    // Point serverCommand at a non-existent path (SAFE_SPAWN_CHARS-clean).
    // onDidChangeConfiguration fires → connectWithProgress() → ENOENT → status 'error'.
    await browser.executeWorkbench((vscode) =>
      vscode.workspace
        .getConfiguration('skillsmith')
        .update(
          'mcp.serverCommand',
          '/nonexistent/skillsmith-e2e-no-such-bin',
          vscode.ConfigurationTarget.Workspace
        )
    )
    await browser.pause(3_000)

    const logLenBefore = readLog().length
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.auditInventory')
    )
    await browser.pause(1_000)

    // No audit call must reach the fake server — the bad command never spawned it
    // and the isConnected() guard short-circuits first.
    const newAuditCalls = readLog()
      .slice(logLenBefore)
      .filter((e) => e['t'] === 'tools/call' && e['name'] === 'skill_inventory_audit')
    expect(newAuditCalls.length).toBe(0)

    // Panel must NOT open on the disconnected path.
    const workbench = await browser.getWorkbench()
    let panelOpened = false
    try {
      await workbench.getWebviewByTitle(PANEL_TITLE)
      panelOpened = true
    } catch {
      /* expected */
    }
    expect(panelOpened).toBe(false)

    // Recovery: restore the real node binary; config-change triggers reconnect.
    await browser.executeWorkbench(
      (vscode, cmd) =>
        vscode.workspace
          .getConfiguration('skillsmith')
          .update('mcp.serverCommand', cmd, vscode.ConfigurationTarget.Workspace),
      origCmd
    )

    const webview = await page.openAuditPanel()
    await webview.close()
    await browser.waitUntil(auditToolWasCalled, {
      timeout: 15_000,
      timeoutMsg: 'recovery: fake server never received skill_inventory_audit',
    })
  })

  it('isError scenario: error notification surfaced; recovery re-opens panel', async () => {
    // NB: do NOT call page.forceConnect() here. This `it` runs after test 1 in the
    // same VS Code session, where the client is already connected — and
    // skillsmith.mcpReconnect on a connected client opens a blocking "Already
    // connected" Reconnect/Disconnect picker (McpStatusBar.ts:85-90) that would
    // hang executeWorkbench. The serverArgs change below drives a reconnect via the
    // onDidChangeConfiguration handler (extension.ts:219-224) unconditionally — the
    // same path a user hits by editing settings.
    const origArgs = (await browser.executeWorkbench((vscode) =>
      vscode.workspace.getConfiguration('skillsmith').get('mcp.serverArgs')
    )) as string[] | undefined

    const fakeServerPath = origArgs?.[0] ?? ''
    expect(fakeServerPath.length).toBeGreaterThan(0)

    // Restart fake server with --scenario isError: every tools/call returns
    //   { isError: true, content: [{text:"Error: <name> failed (e2e isError scenario)"}] }
    // callMcpTool throws McpToolError; auditInventoryCommand.ts catch shows showErrorMessage.
    await browser.executeWorkbench(
      (vscode, args) =>
        vscode.workspace
          .getConfiguration('skillsmith')
          .update('mcp.serverArgs', args, vscode.ConfigurationTarget.Workspace),
      [fakeServerPath, '--scenario', 'isError']
    )

    // Wait for handshake with the new server process (isError server handles initialize normally).
    await browser.waitUntil(
      () =>
        readLog().some(
          (e) => e['t'] === 'notification' && e['method'] === 'notifications/initialized'
        ),
      { timeout: 20_000, interval: 1_000, timeoutMsg: 'isError scenario: handshake timeout' }
    )

    const logLenBeforeError = readLog().length
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.auditInventory')
    )

    // The client IS connected; the audit call reaches the server and gets isError back.
    await browser.waitUntil(
      () =>
        readLog()
          .slice(logLenBeforeError)
          .some((e) => e['t'] === 'tools/call' && e['name'] === 'skill_inventory_audit'),
      {
        timeout: 15_000,
        interval: 500,
        timeoutMsg: 'isError scenario: audit call never reached fake server',
      }
    )

    // Panel must NOT open — the error is caught and shown as showErrorMessage, not rendered.
    const wb = await browser.getWorkbench()
    let panelOpenedOnError = false
    try {
      await wb.getWebviewByTitle(PANEL_TITLE)
      panelOpenedOnError = true
    } catch {
      /* expected */
    }
    expect(panelOpenedOnError).toBe(false)

    // Recovery: restore original serverArgs; config-change reconnects to ok-scenario server.
    await browser.executeWorkbench(
      (vscode, args) =>
        vscode.workspace
          .getConfiguration('skillsmith')
          .update('mcp.serverArgs', args, vscode.ConfigurationTarget.Workspace),
      origArgs
    )

    const recoveryWebview = await page.openAuditPanel()
    await recoveryWebview.close()
  })
})
