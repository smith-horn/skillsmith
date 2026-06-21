/**
 * Inventory-audit interactive apply (SMI-5331 Phase 2a — the named headline
 * requirement, no stubbing). Exercises the SMI-5325 round-trip that unit tests
 * cannot reach: a real click inside the webview iframe → the native confirm
 * modal → a `confirmed: true` apply call to the (fake) MCP server → the panel
 * re-auditing to the resolved state.
 */
import { browser, $, expect } from '@wdio/globals'
import { readFileSync } from 'node:fs'
import { InventoryAuditPage } from '../pageobjects/inventory-audit.page.js'
import { FAKE_MCP_LOG } from '../fixtures/fake-mcp-log-path.mjs'

/** The collision id the fake server's first audit surfaces (fake-mcp-server.mjs). */
const COLLISION_ID = 'col-e2e-1'

/** Parse the fake MCP server's JSONL call log (empty if not yet written). */
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

/** The extension applied for real (preview is confirmed:false; apply is confirmed:true). */
const appliedWithConfirm = (): boolean =>
  readLog().some((e) => {
    const args = e['args'] as { confirmed?: boolean } | undefined
    return (
      e['t'] === 'tools/call' && e['name'] === 'apply_namespace_rename' && args?.confirmed === true
    )
  })

describe('Inventory audit — interactive apply (SMI-5325)', () => {
  const page = new InventoryAuditPage()

  it('webview click → native modal → confirmed apply → re-audit clean', async () => {
    // [E2E-TRACE] step logs (greppable in CI stdout under the [0-N] worker prefix)
    // pinpoint which step hangs; the log dumps survive the shared-log overwrite by
    // a later spec because they go to stdout, not the (truncated) fake log file.
    const trace = (msg: string): void => {
      // eslint-disable-next-line no-console
      console.log(`[E2E-TRACE] apply: ${msg}`)
    }

    // autoConnect is skipped on first activation, so force a connection first.
    await page.forceConnect()
    trace('forceConnect done')

    // Open the audit panel (retries the command until MCP is connected + the
    // panel renders the collision report).
    const webview = await page.openAuditPanel()
    trace(`openAuditPanel done; log=${JSON.stringify(readLog())}`)

    // The rename suggestion renders inside the iframe with an Apply button.
    await expect($(`.apply-rename-btn[data-collision="${COLLISION_ID}"]`)).toBeExisting()
    trace('apply-rename button exists')
    await page.clickApplyRename(COLLISION_ID)
    trace('clickApplyRename done')

    // Back to the main (top) frame so keystrokes reach the modal, not the iframe.
    await webview.close()
    trace(`webview.close done; log=${JSON.stringify(readLog())}`)

    // Accept the confirm modal (showWarningMessage({modal:true}, 'Apply')). Its DOM
    // cannot be queried under WebDriver on Linux — findElement against the live modal
    // times out — so accept the focused primary button via the keyboard. Wait a beat
    // for the modal to render + grab focus after the preview round-trip, then send
    // Enter until the confirmed:true apply lands (a stray Enter before the modal is
    // up is a harmless no-op in the empty throwaway workspace).
    await browser.pause(1_500)
    await browser.waitUntil(
      async () => {
        if (appliedWithConfirm()) return true
        await page.acceptConfirmModal()
        return appliedWithConfirm()
      },
      {
        timeout: 20_000,
        interval: 2_000,
        timeoutMsg: 'confirm modal never accepted: no apply_namespace_rename {confirmed:true}',
      }
    )
    trace(`modal accepted; log=${JSON.stringify(readLog())}`)

    // After a successful apply the panel re-audits; the fake server returns a clean
    // report on the second call, so the resolved-state hero should render.
    const cleanView = await page.enterWebview()
    trace('enterWebview done')
    await expect($('.hero h2')).toHaveText(/No namespace collisions found/i)
    trace('hero asserted')
    await cleanView.close()
  })
})
