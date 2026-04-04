/**
 * HTML generation for SkillDetailPanel
 */

import { escapeHtml } from '../utils/security.js'
import { getSkillDetailCsp } from '../utils/csp.js'
import type { ExtendedSkillData, ScoreBreakdown } from './skill-panel-types.js'
import { getContentHtml, renderMarkdown } from './skill-panel-content.js'
import { inferRepositoryUrl } from './skill-panel-helpers.js'
import { getStyles } from './skill-panel-styles.js'
import { getScript } from './skill-panel-script.js'

// Re-export for testing
export { getContentHtml } from './skill-panel-content.js'

/**
 * Get the CSS class for trust tier badge color
 */
export function getTrustBadgeColor(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'verified':
      return 'verified'
    case 'community':
      return 'community'
    case 'experimental':
      return 'experimental'
    case 'local':
      return 'local'
    default:
      return 'unknown'
  }
}

/**
 * Get the display text for trust tier badge
 */
export function getTrustBadgeText(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'verified':
      return 'Verified'
    case 'community':
      return 'Community'
    case 'experimental':
      return 'Experimental'
    case 'local':
      return 'Local'
    default:
      return 'Unknown'
  }
}

/**
 * Generate loading HTML for the panel
 */
export function getLoadingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Loading...</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 200px;
        }
        .loading {
            text-align: center;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--vscode-progressBar-background);
            border-top-color: var(--vscode-progressBar-foreground);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="loading">
        <div class="spinner"></div>
        <p>Loading skill details...</p>
    </div>
</body>
</html>`
}

/**
 * SMI-3857/3858: Generate the security scan status HTML for the details grid
 */
function getSecurityScanHtml(skill: ExtendedSkillData): string {
  const passed = skill.securityPassed
  const risk = skill.securityRiskScore
  const scannedAt = skill.securityScannedAt

  let statusText: string
  let statusClass: string
  if (passed === true) {
    statusText = 'PASS'
    statusClass = 'scan-pass'
  } else if (passed === false) {
    statusText = risk != null ? `FAIL (risk: ${risk}/100)` : 'FAIL'
    statusClass = 'scan-fail'
  } else {
    statusText = 'Not scanned'
    statusClass = 'scan-none'
  }

  const dateStr = scannedAt
    ? ` <span class="scan-date">${escapeHtml(scannedAt.split('T')[0] ?? scannedAt)}</span>`
    : ''

  return `<div class="meta-item">
                <div class="meta-label">Security Scan</div>
                <div class="meta-value"><span class="${statusClass}">${statusText}</span>${dateStr}</div>
            </div>`
}

/**
 * Generate the score breakdown section HTML
 */
function getScoreBreakdownHtml(scoreBreakdown: ScoreBreakdown): string {
  return `
    <div class="section">
        <h2>Score Breakdown</h2>
        <div class="score-breakdown">
            <div class="score-row">
                <span class="score-label">Quality</span>
                <div class="score-bar"><div class="score-fill" style="width: ${scoreBreakdown.quality}%"></div></div>
                <span class="score-value">${scoreBreakdown.quality}</span>
            </div>
            <div class="score-row">
                <span class="score-label">Popularity</span>
                <div class="score-bar"><div class="score-fill" style="width: ${scoreBreakdown.popularity}%"></div></div>
                <span class="score-value">${scoreBreakdown.popularity}</span>
            </div>
            <div class="score-row">
                <span class="score-label">Maintenance</span>
                <div class="score-bar"><div class="score-fill" style="width: ${scoreBreakdown.maintenance}%"></div></div>
                <span class="score-value">${scoreBreakdown.maintenance}</span>
            </div>
            <div class="score-row">
                <span class="score-label">Security (quality)</span>
                <div class="score-bar"><div class="score-fill" style="width: ${scoreBreakdown.security}%"></div></div>
                <span class="score-value">${scoreBreakdown.security}/100</span>
            </div>
            <div class="score-row">
                <span class="score-label">Documentation</span>
                <div class="score-bar"><div class="score-fill" style="width: ${scoreBreakdown.documentation}%"></div></div>
                <span class="score-value">${scoreBreakdown.documentation}</span>
            </div>
        </div>
    </div>
    `
}

/**
 * Generate the complete HTML for the skill detail webview
 */
export function getSkillDetailHtml(
  skill: ExtendedSkillData,
  nonce: string,
  csp: string,
  showFullContent = false
): string {
  // Escape all user-controlled content to prevent XSS
  const safeName = escapeHtml(skill.name)
  const safeDescription = renderMarkdown(skill.description)
  const safeAuthor = escapeHtml(skill.author)
  const safeCategory = escapeHtml(skill.category)
  const safeTrustTier = escapeHtml(skill.trustTier)
  const safeRepository = skill.repository ? escapeHtml(skill.repository) : ''

  // Fallback: infer GitHub URL from author/name skill ID (validated in helper)
  const inferredUrl = !safeRepository ? inferRepositoryUrl(skill.id) : null
  const inferredRepository = inferredUrl ? escapeHtml(inferredUrl) : null

  // Handle extended skill data properties
  const safeVersion = skill.version ? escapeHtml(skill.version) : null
  const safeTags = skill.tags ? skill.tags.map((t: string) => escapeHtml(t)) : null
  const scoreBreakdown = skill.scoreBreakdown || null

  const trustBadgeColor = getTrustBadgeColor(skill.trustTier)
  const trustBadgeText = getTrustBadgeText(skill.trustTier)

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Skill Details</title>
    <style>${getStyles()}</style>
</head>
<body>
    <div aria-live="polite">
    <div class="header">
        <h1>${safeName}</h1>
        <span class="badge badge-${trustBadgeColor}">${trustBadgeText}</span>
    </div>

    <div class="description">${safeDescription}</div>

    ${getContentHtml(skill.content, showFullContent)}

    <div class="section">
        <h2>Details</h2>
        <div class="meta-grid">
            <div class="meta-item">
                <div class="meta-label">Author</div>
                <div class="meta-value">${safeAuthor}</div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Category</div>
                <div class="meta-value">${safeCategory}</div>
            </div>
            ${
              safeVersion
                ? `
            <div class="meta-item">
                <div class="meta-label">Version</div>
                <div class="meta-value">${safeVersion}</div>
            </div>
            `
                : ''
            }
            <div class="meta-item">
                <div class="meta-label">Score</div>
                <div class="meta-value">${skill.score}/100</div>
                <div class="score-bar">
                    <div class="score-fill" style="width: ${Math.min(100, Math.max(0, skill.score))}%"></div>
                </div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Trust Tier</div>
                <div class="meta-value">${safeTrustTier}</div>
            </div>
            ${getSecurityScanHtml(skill)}
        </div>
    </div>

    ${scoreBreakdown ? getScoreBreakdownHtml(scoreBreakdown) : ''}

    ${
      safeTags && safeTags.length > 0
        ? `
    <div class="section">
        <h2>Tags</h2>
        <div class="tags">
            ${safeTags.map((tag) => `<span class="tag">${tag}</span>`).join('')}
        </div>
    </div>
    `
        : ''
    }

    ${
      safeRepository
        ? `
    <div class="section">
        <h2>Repository</h2>
        <span class="repository-link" tabindex="0" role="link" data-url="${safeRepository}">${safeRepository}</span>
    </div>
    `
        : inferredRepository
          ? `
    <div class="section">
        <h2>Repository</h2>
        <span class="repository-link" tabindex="0" role="link" data-url="${inferredRepository}">${inferredRepository}</span>
        <span class="inferred-label">(inferred from skill ID)</span>
    </div>
    `
          : `
    <div class="section">
        <h2>Repository</h2>
        <span class="meta-label">No repository URL available</span>
    </div>
    `
    }

    <div class="actions">
        <button class="btn-primary" id="installBtn">Install Skill</button>
        ${safeRepository ? `<button class="btn-secondary" id="repoBtn" data-url="${safeRepository}">View Repository</button>` : ''}
    </div>

    </div>

    ${getScript(nonce)}
</body>
</html>`
}

/** Map common error strings to user-friendly messages */
export function mapErrorToUserMessage(rawError: string): string {
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(rawError)) {
    return 'Could not connect to the skill server. Check that the MCP server is running.'
  }
  if (/JSON|parse|unexpected token/i.test(rawError)) {
    return 'Received an unexpected response from the server.'
  }
  if (/not connected/i.test(rawError)) {
    return 'MCP client is not connected. Try reconnecting.'
  }
  return rawError
}

/** Generate error HTML with a retry button (CSP-compatible, accessible) */
export function getErrorHtml(
  message: string,
  _skillId: string,
  nonce: string,
  rawError?: string
): string {
  const csp = getSkillDetailCsp(nonce)
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
    <h1 style="font-size: 1.4em; font-weight: 600;">Error Loading Skill</h1>
    <p role="alert">${escapeHtml(message)}</p>
    <p style="color: var(--vscode-descriptionForeground); font-size: 0.9em;">
      You can close this panel and try again from the skill list.
    </p>
    ${detailsBlock}
    <button id="retryBtn" style="background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 10px 20px; border-radius: 4px; font-size: 14px; font-weight: 500; cursor: pointer; margin-top: 16px;">
      Retry
    </button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('retryBtn');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Retrying...';
      vscode.postMessage({ command: 'retry' });
    });
  </script>
</body></html>`
}
