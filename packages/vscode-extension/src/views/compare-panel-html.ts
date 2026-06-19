/**
 * HTML generation for the Compare Skills panel (SMI-5315 / #1456).
 *
 * Mirrors skill-panel-html.ts: host-builds all HTML, escapes every untrusted
 * field via `escapeHtml`, and uses the shared `.badge badge-${color}` /
 * `.score-bar` / `.score-fill` / `.section` / `.meta-grid` component vocabulary.
 * The webview is read-only; the only inbound message is `retry`.
 */

import { escapeHtml } from '../utils/security.js'
import { getCompareCsp } from '../utils/csp.js'
import { getTrustBadgeColor, getTrustBadgeText } from './trust-badge.js'
import type { McpCompareResponse, McpCompareSummary, McpSkillDifference } from '../mcp/types.js'

/** Clamp a quality score into the 0–100 range for the score bar width. */
function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.min(100, Math.max(0, score))
}

/** Render the two-column summary cell for one skill (name / author / trust / score). */
function getSummaryColumnHtml(summary: McpCompareSummary, label: 'A' | 'B'): string {
  const safeName = escapeHtml(summary.name)
  const safeAuthor = escapeHtml(summary.author)
  const badgeColor = getTrustBadgeColor(summary.trust_tier)
  const badgeText = getTrustBadgeText(summary.trust_tier)
  const score = clampScore(summary.quality_score)
  return `
    <div class="summary-col">
      <div class="summary-label">Skill ${label}</div>
      <h2 class="summary-name">${safeName}</h2>
      <div class="summary-author">by ${safeAuthor}</div>
      <div class="summary-trust">
        <span class="badge badge-${badgeColor}">${badgeText}</span>
      </div>
      <div class="summary-score">
        <span class="score-label">Quality</span>
        <div class="score-bar"><div class="score-fill" style="width: ${score}%"></div></div>
        <span class="score-value">${score}/100</span>
      </div>
    </div>`
}

/**
 * Render the side-by-side tags row. Tags are an array of untrusted strings —
 * each escaped. Empty arrays render an em dash so the grid stays aligned.
 */
function getTagsRowHtml(a: McpCompareSummary, b: McpCompareSummary): string {
  const renderTags = (tags: string[]): string => {
    if (!tags || tags.length === 0) return '<span class="muted">—</span>'
    return tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')
  }
  return `
    <tr>
      <td class="diff-field">Tags</td>
      <td>${renderTags(a.tags)}</td>
      <td>${renderTags(b.tags)}</td>
    </tr>`
}

/**
 * Format an untrusted, `unknown`-typed difference value for display. Avoids the
 * literal "null"/"undefined"/"[object Object]" that bare `String()` would emit
 * (L1) — null/undefined render as an em dash, objects as compact JSON. The
 * result is still escaped by the caller.
 */
function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Render one differences row, highlighting the winner cell. */
function getDifferenceRowHtml(diff: McpSkillDifference): string {
  const safeField = escapeHtml(String(diff.field))
  const safeA = escapeHtml(formatDiffValue(diff.a_value))
  const safeB = escapeHtml(formatDiffValue(diff.b_value))
  const aWin = diff.winner === 'a' ? ' diff-winner' : ''
  const bWin = diff.winner === 'b' ? ' diff-winner' : ''
  return `
    <tr>
      <td class="diff-field">${safeField}</td>
      <td class="diff-value${aWin}">${safeA}</td>
      <td class="diff-value${bWin}">${safeB}</td>
    </tr>`
}

/** Styles for the compare panel — uses VS Code CSS variables (no nonce needed). */
function getCompareStyles(): string {
  return `
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background); padding: 20px; line-height: 1.5; }
    h1 { font-size: 1.4em; font-weight: 600; margin-bottom: 16px; }
    .section { margin-top: 24px; }
    .section h2 { font-size: 1.05em; font-weight: 600; margin-bottom: 8px; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .summary-col { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; }
    .summary-label { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground); }
    .summary-name { font-size: 1.1em; margin: 4px 0; }
    .summary-author { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .summary-trust { margin: 8px 0; }
    .summary-score { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8em;
      font-weight: 600; }
    .badge-official { background: #2e7d32; color: #fff; }
    .badge-verified { background: #1565c0; color: #fff; }
    .badge-curated { background: #6a1b9a; color: #fff; }
    .badge-community { background: #455a64; color: #fff; }
    .badge-unverified { background: #b71c1c; color: #fff; }
    .score-label { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .score-bar { flex: 1; height: 8px; background: var(--vscode-progressBar-background);
      border-radius: 4px; overflow: hidden; }
    .score-fill { height: 100%; background: var(--vscode-progressBar-foreground); }
    .score-value { font-size: 0.85em; min-width: 48px; text-align: right; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);
      vertical-align: top; }
    th { font-weight: 600; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .diff-field { font-weight: 600; }
    .diff-winner { background: var(--vscode-editor-selectionBackground); font-weight: 600; }
    .tag { display: inline-block; padding: 1px 6px; margin: 1px; border-radius: 3px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.8em; }
    .muted { color: var(--vscode-descriptionForeground); }
    .recommendation { margin-top: 24px; padding: 12px; border-radius: 6px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 4px solid var(--vscode-textLink-foreground); }`
}

/**
 * Build the complete Compare panel HTML. All untrusted fields are escaped.
 */
export function getCompareHtml(response: McpCompareResponse, nonce: string): string {
  const csp = getCompareCsp(nonce)
  const a = response.comparison.a
  const b = response.comparison.b

  // OMIT version / score_breakdown / empty-dependencies rows entirely
  // (server always returns null/[] today — never render "null").
  const differenceRows = response.differences.map(getDifferenceRowHtml).join('')
  const safeRecommendation = escapeHtml(response.recommendation)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Compare Skills</title>
  <style>${getCompareStyles()}</style>
</head>
<body>
  <h1>Compare Skills</h1>

  <div class="summary-grid">
    ${getSummaryColumnHtml(a, 'A')}
    ${getSummaryColumnHtml(b, 'B')}
  </div>

  <div class="section">
    <h2>Differences</h2>
    <table>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">${escapeHtml(a.name)}</th>
          <th scope="col">${escapeHtml(b.name)}</th>
        </tr>
      </thead>
      <tbody>
        ${getTagsRowHtml(a, b)}
        ${differenceRows || '<tr><td colspan="3" class="muted">No field-level differences.</td></tr>'}
      </tbody>
    </table>
  </div>

  <div class="recommendation" aria-live="polite">${safeRecommendation}</div>
</body>
</html>`
}

/**
 * Build a local error page for the Compare panel. Mirrors the detail panel's
 * getErrorHtml: aria-live region + a Retry button wired via nonce.
 */
export function getCompareErrorHtml(message: string, nonce: string, rawError?: string): string {
  const csp = getCompareCsp(nonce)
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
    <h1 style="font-size: 1.4em; font-weight: 600;">Couldn't Compare Skills</h1>
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
