/**
 * HTML generation for the Skill Diff / update-advisor panel (SMI-5316 / #1457).
 *
 * Product framing (owner decision D-B): this is an UPDATE ADVISOR. The panel
 * LEADS with the `recommendation` verdict + `changeType` badge, then shows the
 * section changes / risk delta / changelog as supporting detail. Mirrors
 * skill-panel-html.ts: host-built, every untrusted field escaped, shared
 * `.section` / `.badge` component vocabulary. Read-only — inbound message is
 * only `retry`.
 */

import { escapeHtml } from '../utils/security.js'
import { getSkillDiffCsp } from '../utils/csp.js'
import type { McpSkillDiffResponse } from '../mcp/types.js'

/** Friendly verdict copy for each recommendation value. */
function getVerdictCopy(recommendation: McpSkillDiffResponse['recommendation']): {
  title: string
  badgeClass: string
} {
  switch (recommendation) {
    case 'auto-update':
      return { title: 'Safe to update', badgeClass: 'verdict-safe' }
    case 'review-then-update':
      return { title: 'Review before updating', badgeClass: 'verdict-review' }
    case 'manual-review-required':
      return { title: 'Manual review required', badgeClass: 'verdict-manual' }
    default:
      return { title: 'Review before updating', badgeClass: 'verdict-review' }
  }
}

/** Map changeType to a badge color class. */
function getChangeTypeBadgeClass(changeType: McpSkillDiffResponse['changeType']): string {
  switch (changeType) {
    case 'major':
      return 'change-major'
    case 'minor':
      return 'change-minor'
    case 'patch':
      return 'change-patch'
    default:
      return 'change-unknown'
  }
}

/** Render one section-changes list, or '' when the list is empty. */
function getSectionListHtml(title: string, entries: string[]): string {
  if (!entries || entries.length === 0) {
    return ''
  }
  const items = entries.map((e) => `<li>${escapeHtml(e)}</li>`).join('')
  return `
    <div class="section">
      <h2>${escapeHtml(title)}</h2>
      <ul class="section-list">${items}</ul>
    </div>`
}

/** Styles for the diff panel — uses VS Code CSS variables (no nonce needed). */
function getDiffStyles(): string {
  return `
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background); padding: 20px; line-height: 1.5; }
    h1 { font-size: 1.4em; font-weight: 600; margin-bottom: 4px; }
    .skill-name { color: var(--vscode-descriptionForeground); font-size: 0.95em; margin-bottom: 16px; }
    .verdict { padding: 16px; border-radius: 8px; margin-bottom: 8px;
      background: var(--vscode-textBlockQuote-background); }
    .verdict-title { font-size: 1.2em; font-weight: 600; display: flex; align-items: center; gap: 10px; }
    .verdict-safe { border-left: 4px solid #2e7d32; }
    .verdict-review { border-left: 4px solid #f9a825; }
    .verdict-manual { border-left: 4px solid #b71c1c; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .change-major { background: #b71c1c; color: #fff; }
    .change-minor { background: #f9a825; color: #000; }
    .change-patch { background: #2e7d32; color: #fff; }
    .change-unknown { background: #455a64; color: #fff; }
    .section { margin-top: 20px; }
    .section h2 { font-size: 1.05em; font-weight: 600; margin-bottom: 6px; }
    .section-list { margin: 0; padding-left: 20px; }
    .section-list li { margin: 2px 0; }
    .meta-row { margin-top: 16px; }
    .meta-label { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .changelog { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background);
      padding: 12px; border-radius: 6px; font-size: 0.9em; }
    .no-changes { margin-top: 20px; color: var(--vscode-descriptionForeground); }
    .text-diff-btn { margin-top: 8px; background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground); border: none; padding: 8px 16px;
      border-radius: 4px; font-size: 13px; font-weight: 500; cursor: pointer; }
    .text-diff-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .text-diff-btn:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }`
}

/** Render the risk-score-delta row when present. */
function getRiskDeltaHtml(delta: number | null): string {
  if (delta === null) {
    return ''
  }
  const sign = delta > 0 ? '+' : ''
  return `
    <div class="meta-row">
      <span class="meta-label">Risk score change:</span> ${sign}${escapeHtml(String(delta))}
    </div>`
}

/** Render the changelog block when present. */
function getChangelogHtml(changelog: string | null): string {
  if (!changelog) {
    return ''
  }
  return `
    <div class="section">
      <h2>Changelog</h2>
      <div class="changelog">${escapeHtml(changelog)}</div>
    </div>`
}

/**
 * Build the complete Diff / update-advisor panel HTML. Leads with the verdict
 * and changeType badge. All untrusted fields escaped.
 */
export function getDiffHtml(
  skillName: string,
  response: McpSkillDiffResponse,
  nonce: string
): string {
  const csp = getSkillDiffCsp(nonce)
  const verdict = getVerdictCopy(response.recommendation)
  const changeBadgeClass = getChangeTypeBadgeClass(response.changeType)
  const safeName = escapeHtml(skillName)
  const safeChangeType = escapeHtml(response.changeType)

  const added = getSectionListHtml('Sections added', response.sectionsAdded)
  const removed = getSectionListHtml('Sections removed', response.sectionsRemoved)
  const modified = getSectionListHtml('Sections modified', response.sectionsModified)
  const noSemanticChanges =
    response.sectionsAdded.length === 0 &&
    response.sectionsRemoved.length === 0 &&
    response.sectionsModified.length === 0

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Check for Updates</title>
  <style>${getDiffStyles()}</style>
</head>
<body>
  <h1>Update Check</h1>
  <div class="skill-name">${safeName}</div>

  <div class="verdict ${verdict.badgeClass}" aria-live="polite">
    <div class="verdict-title">
      ${escapeHtml(verdict.title)}
      <span class="badge ${changeBadgeClass}">${safeChangeType}</span>
    </div>
  </div>

  <div class="meta-row">
    <button id="textDiffBtn" class="text-diff-btn">View full text diff</button>
  </div>

  ${added}
  ${removed}
  ${modified}
  ${noSemanticChanges ? '<div class="no-changes">No semantic changes detected.</div>' : ''}

  ${getRiskDeltaHtml(response.riskScoreDelta)}
  ${getChangelogHtml(response.changelog)}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const textDiffBtn = document.getElementById('textDiffBtn');
    if (textDiffBtn) {
      textDiffBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'viewTextDiff' });
      });
    }
  </script>
</body>
</html>`
}

/**
 * Build a local error page for the Diff panel. Mirrors the detail panel's
 * getErrorHtml: aria-live region + a Retry button wired via nonce.
 */
export function getDiffErrorHtml(message: string, nonce: string, rawError?: string): string {
  const csp = getSkillDiffCsp(nonce)
  const detailsBlock =
    rawError && rawError !== message
      ? `<details style="margin-top: 12px; color: var(--vscode-descriptionForeground);">
        <summary>Technical details</summary>
        <pre style="white-space: pre-wrap; font-size: 12px; margin-top: 8px;">${escapeHtml(rawError)}</pre>
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
    <h1 style="font-size: 1.4em; font-weight: 600;">Couldn't Check for Updates</h1>
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
