/**
 * HTML generation for SkillDetailPanel
 */

import { escapeHtml } from '../utils/security.js'
import { getSkillDetailCsp } from '../utils/csp.js'
import type { McpAdvisory } from '../mcp/types.js'
import type { ExtendedSkillData, ScoreBreakdown, SkillActionContext } from './skill-panel-types.js'
import { getContentHtml, renderMarkdown } from './skill-panel-content.js'
import { inferRepositoryUrl } from './skill-panel-helpers.js'
import { getStyles } from './skill-panel-styles.js'
import { getScript } from './skill-panel-script.js'
import { getActionBlock } from './skill-panel-actions.js'

// Re-export for testing
export { getContentHtml } from './skill-panel-content.js'

// SMI-5315: trust-badge helpers extracted to ./trust-badge.ts so the Compare /
// Diff panels share the same `.badge badge-${color}` component. Re-exported here
// for back-compat with existing importers + tests.
import { getTrustBadgeColor, getTrustBadgeText } from './trust-badge.js'
export { getTrustBadgeColor, getTrustBadgeText } from './trust-badge.js'

/**
 * Generate loading HTML for the panel
 */
export function getLoadingHtml(nonce: string, csp: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Loading...</title>
    <style nonce="${nonce}">
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
 * SMI-3857/3858: Generate the security scan status HTML for the details grid.
 * SMI-4240: Tier-aware "pending" copy — verified skills show "Pending review"
 * (neutral), community/experimental/local/unknown show "Pending scan". The row
 * stays visible across all tiers so the grid layout is stable.
 */
function getSecurityScanHtml(skill: ExtendedSkillData): string {
  const passed = skill.securityPassed
  const risk = skill.securityRiskScore
  const scannedAt = skill.securityScannedAt

  let statusText: string
  let statusClass: string
  let tooltip: string | null = null
  if (passed === true) {
    statusText = 'PASS'
    statusClass = 'scan-pass'
  } else if (passed === false) {
    statusText = risk != null ? `FAIL (risk: ${risk}/100)` : 'FAIL'
    // SMI-5317: append the finding count only on FAIL with >0 findings (count
    // only — the findings list is not on get_skill, see SMI-5324).
    const n = skill.securityFindingsCount
    if (typeof n === 'number' && n > 0) {
      statusText += ` · ${n} finding${n === 1 ? '' : 's'}`
    }
    statusClass = 'scan-fail'
  } else {
    // passed === null || undefined: no scan result available.
    statusText = skill.trustTier === 'verified' ? 'Pending review' : 'Pending scan'
    statusClass = 'scan-none'
    tooltip = 'Security scan status — see https://skillsmith.app/docs/security'
  }

  const dateStr = scannedAt
    ? ` <span class="scan-date">${escapeHtml(scannedAt.split('T')[0] ?? scannedAt)}</span>`
    : ''

  const titleAttr = tooltip ? ` title="${escapeHtml(tooltip)}"` : ''

  return `<div class="meta-item">
                <div class="meta-label">Security Scan</div>
                <div class="meta-value"><span class="${statusClass}"${titleAttr}>${statusText}</span>${dateStr}</div>
            </div>`
}

/** Severity values that map to a known `.badge-sev-*` class (L1 whitelist). */
const ADVISORY_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

/**
 * SMI-5317: Generate the lazily-loaded "Security Advisories" section from
 * Team-gated `skill_audit` advisories. Returns `''` when there is nothing to
 * show so the caller can place it unconditionally (M4).
 *
 * Security (L1): every untrusted field is escaped via `escapeHtml`, and the
 * severity is mapped to a CSS class through a whitelist — never interpolated
 * raw. The section is `aria-live="polite"` (L2) since it arrives after the
 * base panel render, and severity is rendered as visible text (not color-only).
 */
export function getAdvisoriesHtml(advisories: McpAdvisory[] | null, tierDenied: boolean): string {
  if (advisories && advisories.length > 0) {
    const rows = advisories
      .map((a) => {
        const sev = ADVISORY_SEVERITIES.includes(a.severity) ? a.severity : 'low'
        const sevLabel = escapeHtml(sev.toUpperCase())
        const title = escapeHtml(a.title)
        const id = escapeHtml(a.id)
        const fixMarker = a.fixAvailable ? ' <span class="advisory-fix">fix available</span>' : ''
        return `
            <div class="advisory-row">
                <span class="badge badge-sev-${sev}">${sevLabel}</span>
                <span class="advisory-title">${title}</span>
                <span class="advisory-id">${id}</span>${fixMarker}
            </div>`
      })
      .join('')
    return `
    <div class="section" aria-live="polite">
        <style>
            .advisory-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; flex-wrap: wrap; }
            .advisory-id { color: var(--vscode-descriptionForeground); font-size: 12px; }
            .advisory-fix { color: var(--vscode-charts-green, #28a745); font-size: 12px; }
            .badge-sev-critical { background-color: #d32f2f; color: white; }
            .badge-sev-high { background-color: #e65100; color: white; }
            .badge-sev-medium { background-color: #b8960a; color: white; }
            .badge-sev-low { background-color: #6c757d; color: white; }
        </style>
        <h2>Security Advisories</h2>${rows}
    </div>
    `
  }
  if (tierDenied) {
    return `
    <div class="section">
        <p class="advisory-upsell">${escapeHtml('Security advisories are available on the Team plan.')}</p>
    </div>
    `
  }
  return ''
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
  showFullContent = false,
  actionCtx: SkillActionContext = { installed: false },
  advisoryCtx: { advisories: McpAdvisory[] | null; tierDenied: boolean } = {
    advisories: null,
    tierDenied: false,
  }
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
    <div class="header">
        <div class="header-titles">
            <h1>${safeName}</h1>
            <span class="badge badge-${trustBadgeColor}">${trustBadgeText}</span>
        </div>
        ${getActionBlock(actionCtx, safeRepository)}
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

    ${getAdvisoriesHtml(advisoryCtx.advisories, advisoryCtx.tierDenied)}

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
          : // SMI-4240: Hide the entire section when no URL is available rather than rendering
            // a "No repository URL available" placeholder — matches the tag-section pattern
            // (lines 257-267). For intentionally non-installable skills (SMI-2723) or
            // cross-ecosystem discovery-only skills, the section simply doesn't appear.
            ''
    }

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
