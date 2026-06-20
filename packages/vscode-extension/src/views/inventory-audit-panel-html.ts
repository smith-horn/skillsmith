/**
 * HTML generation for the Skill Inventory Audit panel (SMI-5318 / #1459).
 *
 * Host-builds all HTML, escaping every untrusted field. Reuses the compare
 * panel's `.badge` / `.section` / `.tag` CSS vocabulary plus three severity
 * badge classes. The per-section renderers live in
 * `inventory-audit-sections-html.ts` to keep this file under the 500-line cap.
 *
 * The webview is read-only: inbound messages are `retry`, `openReport`, and
 * `copyRename` (copy a suggested name). The inventory audit tool is ungated —
 * there is no tier-denied path here.
 */

import { escapeHtml } from '../utils/security.js'
import { getInventoryAuditCsp } from '../utils/csp.js'
import type { McpInventoryAuditResponse } from '../mcp/types.js'
import {
  getExactCollisionsSection,
  getGenericFlagsSection,
  getRecommendedEditsSection,
  getRenameSuggestionsSection,
  getSemanticSection,
  getSummarySection,
} from './inventory-audit-sections-html.js'

/** Styles for the inventory-audit panel — VS Code CSS variables + severity badges. */
function getStyles(): string {
  return `
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background); padding: 20px; line-height: 1.5; }
    h1 { font-size: 1.4em; font-weight: 600; margin-bottom: 8px; }
    h2 { font-size: 1.05em; font-weight: 600; margin: 24px 0 8px; }
    section { margin-top: 8px; }
    .summary { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0 16px;
      color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .summary-error { color: #ff6b6b; font-weight: 600; }
    .summary-warning { color: #ffb74d; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8em;
      font-weight: 600; }
    .badge-error { background: #b71c1c; color: #fff; }
    .badge-warning { background: #e65100; color: #fff; }
    .badge-default { background: #455a64; color: #fff; }
    .collision-row, .rename-row, .edit-row { border: 1px solid var(--vscode-panel-border);
      border-radius: 6px; padding: 12px; margin-bottom: 10px; }
    .row-header { display: flex; align-items: center; gap: 8px; }
    .row-identifier, .rename-current, .rename-suggested, .entry-id { font-weight: 600; }
    .row-reason { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 6px; }
    .entry-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .entry-path { color: var(--vscode-descriptionForeground); font-size: 0.85em;
      font-family: var(--vscode-editor-font-family, monospace); }
    .entry-list { margin-top: 4px; }
    .tag { display: inline-block; padding: 1px 6px; border-radius: 3px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.8em; }
    .matched-tokens { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
    .muted { color: var(--vscode-descriptionForeground); }
    .semantic-entries { margin-top: 6px; }
    .cosine-score { font-size: 0.85em; margin-top: 6px; }
    .phrase-list { margin-top: 6px; }
    .phrase-line { display: flex; align-items: center; gap: 8px; font-size: 0.85em; }
    .phrase-sep, .phrase-sim { color: var(--vscode-descriptionForeground); }
    .rename-names { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .rename-arrow, .edit-label { color: var(--vscode-descriptionForeground); }
    .edit-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
    .edit-before pre, .edit-after pre { white-space: pre-wrap; font-size: 12px; margin: 4px 0 0;
      padding: 8px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); }
    .edit-file { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em;
      color: var(--vscode-descriptionForeground); }
    .hero { padding: 24px; border-radius: 6px; text-align: center;
      background: var(--vscode-textBlockQuote-background); margin: 16px 0; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 8px 16px; border-radius: 4px; font-size: 13px; font-weight: 500;
      cursor: pointer; }
    button:hover { background-color: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .copy-btn { padding: 2px 10px; font-size: 12px; }
    /* SMI-5325: apply buttons use the secondary treatment so the consequential
       (file-mutating) action is visually distinct from the benign Copy. */
    .apply-btn { padding: 2px 10px; font-size: 12px;
      background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .apply-btn:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
    .edit-actions { margin-top: 8px; }
    .edit-hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; font-style: italic; }
    .status-node { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0; min-height: 1.2em; }
    .status-node:empty { margin: 0; min-height: 0; }
    .actions { display: flex; gap: 8px; margin-top: 24px; }`
}

/**
 * Inline script: wires Retry, Open-Report, delegated `.copy-btn` / `.apply-btn`
 * clicks, and — SMI-5325 — moves focus to the status node after a re-render so a
 * screen-reader user is re-oriented and hears the apply result.
 */
function getScript(nonce: string): string {
  return `
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'retry' });
      });
    }
    const reportBtn = document.getElementById('openReportBtn');
    if (reportBtn) {
      reportBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'openReport' });
      });
    }
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.classList) return;
      const data = target.dataset || {};
      if (target.classList.contains('copy-btn') && typeof data.copy === 'string') {
        vscode.postMessage({ command: 'copyRename', text: data.copy });
      } else if (target.classList.contains('apply-rename-btn') && typeof data.collision === 'string') {
        vscode.postMessage({ command: 'applyRename', collisionId: data.collision });
      } else if (target.classList.contains('apply-edit-btn') && typeof data.collision === 'string') {
        vscode.postMessage({ command: 'applyEdit', collisionId: data.collision });
      }
    });
    const statusNode = document.getElementById('statusNode');
    if (statusNode && statusNode.textContent && statusNode.textContent.trim().length > 0) {
      statusNode.focus();
    }
  </script>`
}

/** The "Open Full Report" + "Retry" action row, shared by clean + populated states. */
function getActionsHtml(): string {
  return `
  <div class="actions">
    <button id="openReportBtn">Open Full Report</button>
    <button id="retryBtn">Re-run Audit</button>
  </div>`
}

/**
 * Build the complete Inventory Audit panel HTML. All untrusted fields are
 * escaped (in the section renderers). When there are no flags, a clean-state
 * hero replaces the collision sections.
 *
 * SMI-5325 options: `editApplyUnavailable` collapses all Apply-edit buttons to
 * the manual-review hint (server's `apply_recommended_edit` is unregistered);
 * `statusMessage` is announced via an `aria-live` status node that the inline
 * script focuses on load (re-orients a screen-reader user after an apply).
 */
export function getInventoryAuditHtml(
  response: McpInventoryAuditResponse,
  nonce: string,
  opts: { editApplyUnavailable?: boolean; statusMessage?: string } = {}
): string {
  const csp = getInventoryAuditCsp(nonce)
  const summary = response.summary
  const totalFlags = Number.isFinite(summary?.totalFlags) ? summary.totalFlags : 0
  const totalEntries = Number.isFinite(summary?.totalEntries) ? summary.totalEntries : 0
  const statusMessage = typeof opts.statusMessage === 'string' ? opts.statusMessage : ''

  const bodyContent =
    totalFlags === 0
      ? `
    ${getSummarySection(summary)}
    <div class="hero">
      <h2>No namespace collisions found.</h2>
      <p>Scanned ${totalEntries} entries.</p>
    </div>`
      : `
    ${getSummarySection(summary)}
    ${getExactCollisionsSection(response.exactCollisions)}
    ${getSemanticSection(response.semanticCollisions)}
    ${getGenericFlagsSection(response.genericFlags)}
    ${getRenameSuggestionsSection(response.renameSuggestions)}
    ${getRecommendedEditsSection(response.recommendedEdits, opts.editApplyUnavailable === true)}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Skill Inventory Audit</title>
  <style>${getStyles()}</style>
</head>
<body>
  <h1>Skill Inventory Audit</h1>
  <div id="statusNode" class="status-node" role="status" aria-live="polite" tabindex="-1">${escapeHtml(statusMessage)}</div>
  ${bodyContent}
  ${getActionsHtml()}
  ${getScript(nonce)}
</body>
</html>`
}

/**
 * Build a local error page for the Inventory Audit panel. Mirrors
 * getCompareErrorHtml: aria-live region + a Retry button wired via nonce.
 */
export function getInventoryAuditErrorHtml(message: string, nonce: string, raw?: string): string {
  const csp = getInventoryAuditCsp(nonce)
  const detailsBlock =
    raw && raw !== message
      ? `<details style="margin-top: 12px; color: var(--vscode-descriptionForeground);">
        <summary>Technical details</summary>
        <pre style="white-space: pre-wrap; font-size: 12px; margin-top: 8px;">${escapeHtml(raw)}</pre>
       </details>`
      : ''

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
  button:hover { background-color: var(--vscode-button-hoverBackground) !important; }
  button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style>
</head>
<body style="font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background-color: var(--vscode-editor-background);">
  <div aria-live="polite">
    <h1 style="font-size: 1.4em; font-weight: 600;">Couldn't Audit Inventory</h1>
    <p role="alert">${escapeHtml(message)}</p>
    ${detailsBlock}
    <button id="retryBtn" style="background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 10px 20px; border-radius: 4px; font-size: 14px; font-weight: 500; cursor: pointer; margin-top: 16px;">
      Retry
    </button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('retryBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Retrying...';
        vscode.postMessage({ command: 'retry' });
      });
    }
  </script>
</body></html>`
}
