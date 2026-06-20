/**
 * Message types for the Skill Inventory Audit panel (SMI-5318 / #1459).
 *
 * Split out of InventoryAuditPanel.ts / inventory-audit-panel-html.ts so each
 * file stays under the 500-line cap. Inbound messages are `retry` (re-run the
 * audit), `openReport` (open the formatted report in an editor tab), `copyRename`
 * (copy a suggested name to the clipboard), and — SMI-5325 — `applyRename` /
 * `applyEdit` (apply a suggested rename / prose edit by `collisionId`).
 */

/**
 * Messages posted from the Inventory Audit webview back to the extension host.
 */
export type InventoryAuditPanelMessage =
  | { command: 'retry' }
  | { command: 'openReport' }
  | { command: 'copyRename'; text: string }
  | { command: 'applyRename'; collisionId: string }
  | { command: 'applyEdit'; collisionId: string }
