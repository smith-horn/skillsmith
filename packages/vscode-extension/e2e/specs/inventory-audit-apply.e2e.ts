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
    // autoConnect is skipped on first activation, so force a connection first.
    await page.forceConnect()

    // Open the audit panel (retries the command until MCP is connected + the
    // panel renders the collision report).
    const webview = await page.openAuditPanel()

    // The rename suggestion renders inside the iframe with an Apply button.
    await expect($(`.apply-rename-btn[data-collision="${COLLISION_ID}"]`)).toBeExisting()
    await page.clickApplyRename(COLLISION_ID)

    // Back to the main frame to accept the native confirm modal.
    await webview.close()
    await page.confirmApply('Apply')

    // The extension must have applied with confirmed:true.
    await browser.waitUntil(appliedWithConfirm, {
      timeout: 15_000,
      timeoutMsg: 'fake MCP server never received apply_namespace_rename {confirmed:true}',
    })

    // After a successful apply the panel re-audits; the fake server returns a clean
    // report on the second call, so the resolved-state hero should render.
    const cleanView = await page.enterWebview()
    await expect($('.hero h2')).toHaveText(/No namespace collisions found/i)
    await cleanView.close()
  })
})
