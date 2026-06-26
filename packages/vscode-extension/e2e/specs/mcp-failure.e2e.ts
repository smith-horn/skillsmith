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
import { InventoryAuditPage } from '../pageobjects/inventory-audit.page.js'
import { readFakeMcpLog } from '../fixtures/fake-mcp-log.js'

const auditToolWasCalled = (): boolean =>
  readFakeMcpLog().some((e) => e['t'] === 'tools/call' && e['name'] === 'skill_inventory_audit')

/** A fake server with the given scenario has started (logs {start, scenario} after truncating). */
const serverStarted = (scenario: string): boolean =>
  readFakeMcpLog().some((e) => e['t'] === 'start' && e['scenario'] === scenario)

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

    const logLenBefore = readFakeMcpLog().length
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.auditInventory')
    )
    await browser.pause(1_000)

    // No audit call must reach the fake server — the bad command never spawned it
    // and the isConnected() guard short-circuits first.
    const newAuditCalls = readFakeMcpLog()
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

  it('failure detection + direct reconnect (F1 — no toast click)', async () => {
    // Leg added for SMI-5398 F1: verifies that (a) setting an unreachable serverCommand
    // drives the client into an error state (getStatus()==='error', proxied here via the
    // audit early-return guard) and (b) a direct config-change reconnect — NOT a toast
    // button click, which WDIO cannot reach — recovers the connection.
    const origCmd = (await browser.executeWorkbench((vscode) =>
      vscode.workspace.getConfiguration('skillsmith').get('mcp.serverCommand')
    )) as string | undefined

    // Point at an unreachable binary; onDidChangeConfiguration fires → connectWithProgress
    // → ENOENT → client.status = 'error'.
    await browser.executeWorkbench((vscode) =>
      vscode.workspace
        .getConfiguration('skillsmith')
        .update(
          'mcp.serverCommand',
          '/nonexistent/smi-5398-unreachable-bin',
          vscode.ConfigurationTarget.Workspace
        )
    )
    await browser.pause(3_000)

    // Proxy for getStatus()==='error': the audit command early-returns (isConnected()===false),
    // so no new call reaches the fake server.
    const logLenAfterBreak = readFakeMcpLog().length
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.auditInventory')
    )
    await browser.pause(1_000)
    const newCallsDuringError = readFakeMcpLog()
      .slice(logLenAfterBreak)
      .filter((e) => e['t'] === 'tools/call' && e['name'] === 'skill_inventory_audit')
    expect(newCallsDuringError.length).toBe(0)

    // Direct reconnect: restore the original serverCommand via config update
    // (mirrors what the toast self-heal button writes, but driven from the test
    // directly — no WDIO toast-button interaction needed).
    await browser.executeWorkbench(
      (vscode, cmd) =>
        vscode.workspace
          .getConfiguration('skillsmith')
          .update('mcp.serverCommand', cmd, vscode.ConfigurationTarget.Workspace),
      origCmd
    )
    await browser.waitUntil(() => serverStarted('ok'), {
      timeout: 20_000,
      interval: 1_000,
      timeoutMsg: 'F1 direct-reconnect: fake server never restarted after config restore',
    })
    // Confirm the extension is functional again: audit reaches the server.
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.auditInventory')
    )
    await browser.waitUntil(auditToolWasCalled, {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: 'F1 direct-reconnect: audit never reached fake server after restore',
    })
  })

  it('isError scenario: audit failure handled gracefully; host survives + recovers', async () => {
    // NB: no page.forceConnect() — test 1 leaves the client connected, and
    // skillsmith.mcpReconnect on a connected client opens a blocking
    // Reconnect/Disconnect picker (McpStatusBar.ts:85-90) that hangs
    // executeWorkbench. Each serverArgs change below drives a reconnect via the
    // onDidChangeConfiguration handler (extension.ts:219-224), the same path a
    // user hits editing settings. Assertions are at the MCP-call-log + host-
    // liveness level — robust against panel/editor timing; the panel DOM
    // round-trip is covered by the interactive-apply spec.
    const origArgs = (await browser.executeWorkbench((vscode) =>
      vscode.workspace.getConfiguration('skillsmith').get('mcp.serverArgs')
    )) as string[] | undefined

    const fakeServerPath = origArgs?.[0] ?? ''
    expect(fakeServerPath.length).toBeGreaterThan(0)

    // Restart the fake server with --scenario isError: every tools/call returns an
    // isError envelope; callMcpTool throws McpToolError and auditInventoryCommand
    // surfaces showErrorMessage (fake-mcp-server.mjs:91-95, callTool.ts:87-89,
    // auditInventoryCommand.ts:56-58). Sequence on the isError server's own start
    // marker, not the previous server's entries.
    await browser.executeWorkbench(
      (vscode, args) =>
        vscode.workspace
          .getConfiguration('skillsmith')
          .update('mcp.serverArgs', args, vscode.ConfigurationTarget.Workspace),
      [fakeServerPath, '--scenario', 'isError']
    )
    await browser.waitUntil(() => serverStarted('isError'), {
      timeout: 20_000,
      interval: 1_000,
      timeoutMsg: 'isError scenario: isError fake server never started',
    })

    // The audit runs against the isError server; the extension must reach it (the
    // call is attempted) and handle the isError response without crashing.
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.auditInventory')
    )
    await browser.waitUntil(auditToolWasCalled, {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: 'isError scenario: audit call never reached the isError server',
    })

    // Graceful degradation: the extension host is still alive after the isError
    // response — a crashed host would fail executeWorkbench or drop the command.
    const stillAlive = await browser.executeWorkbench(async (vscode) => {
      const cmds = await vscode.commands.getCommands(true)
      return cmds.includes('skillsmith.auditInventory')
    })
    expect(stillAlive).toBe(true)

    // Recovery: restore the ok server and confirm a fresh audit reaches it (the
    // extension reconnected and is functional again after the failure).
    await browser.executeWorkbench(
      (vscode, args) =>
        vscode.workspace
          .getConfiguration('skillsmith')
          .update('mcp.serverArgs', args, vscode.ConfigurationTarget.Workspace),
      origArgs
    )
    await browser.waitUntil(() => serverStarted('ok'), {
      timeout: 20_000,
      interval: 1_000,
      timeoutMsg: 'recovery: ok fake server never restarted',
    })
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.auditInventory')
    )
    await browser.waitUntil(auditToolWasCalled, {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: 'recovery: audit never reached the restored ok server',
    })
  })
})
