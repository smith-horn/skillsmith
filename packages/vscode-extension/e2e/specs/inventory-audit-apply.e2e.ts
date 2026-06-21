/**
 * Inventory-audit interactive apply — webview → extension → MCP round-trip
 * (SMI-5331 Phase 2a). Exercises the SMI-5325 apply path that unit tests (which
 * mock `vscode`) cannot reach: a real click inside the webview iframe drives the
 * extension's `_runApply` preview phase, which sends `apply_namespace_rename
 * {confirmed:false}` to the (fake) MCP server over real stdio before raising the
 * confirm modal.
 *
 * Scope note (validated on x64 ubuntu + xvfb, SMI-5331): the confirm modal itself
 * (`showWarningMessage({ modal: true }, 'Apply')`, InventoryAuditPanel.ts:211-214)
 * cannot be driven by WebDriver on headless Linux — querying or keying the live
 * dialog (DOM selector, keyboard, or the official ModalDialog page object) renders
 * wdio-vscode-service's extension-host bridge unresponsive (60s proxy
 * commandTimeout, then an extension-host crash). The modal-accept →
 * `confirmed:true` → re-audit path is therefore covered by the SMI-5325 unit tests
 * (which mock `showWarningMessage`); this E2E asserts the integration up to the
 * modal, which is precisely the part unit tests cannot cover.
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

/** The extension reached the preview phase: apply_namespace_rename {confirmed:false}. */
const previewFired = (): boolean =>
  readLog().some((e) => {
    const args = e['args'] as { confirmed?: boolean } | undefined
    return (
      e['t'] === 'tools/call' && e['name'] === 'apply_namespace_rename' && args?.confirmed === false
    )
  })

describe('Inventory audit — interactive apply (SMI-5325)', () => {
  const page = new InventoryAuditPage()

  it('webview Apply click drives the extension → MCP preview round-trip', async () => {
    // autoConnect is skipped on first activation, so force a connection first.
    await page.forceConnect()

    // Open the audit panel (retries the command until MCP is connected + the
    // panel renders the collision report).
    const webview = await page.openAuditPanel()

    // The rename suggestion renders inside the iframe with an Apply button.
    await expect($(`.apply-rename-btn[data-collision="${COLLISION_ID}"]`)).toBeExisting()
    await page.clickApplyRename(COLLISION_ID)

    // Exit the webview iframe immediately (before the confirm modal renders — the
    // preview MCP round-trip is still in flight, so this frame switch is not yet
    // blocked by the modal). The modal is left for VS Code to dismiss on window
    // close at session teardown; it cannot be driven here (see file header).
    await webview.close()

    // The click drove _runApply's preview phase: the extension sent
    // apply_namespace_rename {confirmed:false} to the fake MCP server before
    // raising the confirm modal. That call proves the webview → extension → MCP
    // wiring end-to-end (the part unit tests cannot reach).
    await browser.waitUntil(previewFired, {
      timeout: 20_000,
      timeoutMsg: 'extension never sent apply_namespace_rename {confirmed:false} (preview phase)',
    })
  })
})
