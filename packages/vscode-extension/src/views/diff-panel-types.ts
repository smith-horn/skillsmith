/**
 * Message + view-data types for the Skill Diff / update-advisor panel
 * (SMI-5316 / #1457).
 *
 * Split out of SkillDiffPanel.ts / diff-panel-html.ts so each file stays under
 * the 500-line cap.
 */

/**
 * Messages posted from the Diff webview back to the extension host.
 * The diff panel is read-only, so the only inbound message is `retry`
 * (re-run the check after a transient `McpToolError`).
 */
export interface DiffPanelMessage {
  command: 'retry'
}

/**
 * Arguments for an MCP `skill_diff` call. Stored on the panel so a `retry`
 * re-runs the same check (e.g. after a transient disconnect). Mirrors the
 * `McpClient.skillDiff` parameter shape.
 */
export interface SkillDiffArgs {
  skillId: string
  oldContent: string
  newContent: string
  oldRiskScore?: number
  newRiskScore?: number
  hasLocalModifications?: boolean
  trustTier?: 'verified' | 'community' | 'experimental'
}
