/**
 * Message + view-data types for the Compare Skills panel (SMI-5315 / #1456).
 *
 * Split out of CompareSkillsPanel.ts / compare-panel-html.ts so each file stays
 * under the 500-line cap.
 */

/**
 * Messages posted from the Compare webview back to the extension host.
 * The compare panel is read-only, so the only inbound message is `retry`
 * (re-run the comparison after a transient `McpToolError`).
 */
export interface ComparePanelMessage {
  command: 'retry'
}
