/**
 * HTML generation for SkillDetailPanel
 */

import { escapeHtml } from '../utils/security.js'
import type { ExtendedSkillData, ScoreBreakdown } from './skill-panel-types.js'
import { getContentHtml, getContentStyles, renderMarkdown } from './skill-panel-content.js'
import { inferRepositoryUrl } from './skill-panel-helpers.js'

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
    case 'standard':
      return 'standard'
    default:
      return 'unverified'
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
    case 'standard':
      return 'Standard'
    default:
      return 'Unverified'
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
 * Generate the CSS styles for the skill detail panel
 */
function getStyles(): string {
  return `
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header h1 {
            margin: 0;
            font-size: 24px;
        }
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 16px;
            font-size: 12px;
            font-weight: 500;
            text-transform: uppercase;
        }
        .badge-verified { background-color: #28a745; color: white; }
        .badge-community { background-color: #b8960a; color: white; }
        .badge-standard { background-color: #007bff; color: white; }
        .badge-unverified { background-color: #6c757d; color: white; }
        .description {
            font-size: 16px;
            margin-bottom: 24px;
            color: var(--vscode-descriptionForeground);
        }
        .section { margin-bottom: 24px; }
        .section h2 {
            font-size: 16px;
            margin-bottom: 12px;
            color: var(--vscode-foreground);
        }
        .meta-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
        }
        .meta-item {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 12px;
            border-radius: 8px;
        }
        .meta-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            margin-bottom: 4px;
        }
        .meta-value { font-size: 14px; font-weight: 500; }
        .score-bar {
            height: 8px;
            background-color: var(--vscode-progressBar-background);
            border-radius: 4px;
            overflow: hidden;
            margin-top: 8px;
        }
        .score-fill {
            height: 100%;
            background-color: var(--vscode-progressBar-foreground);
            border-radius: 4px;
        }
        .actions { display: flex; gap: 12px; margin-top: 24px; }
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .repository-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }
        .repository-link:hover, .repository-link:focus { text-decoration: underline; }
        .repository-link:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
        .score-breakdown {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .score-row {
            display: grid;
            grid-template-columns: 120px 1fr 50px;
            align-items: center;
            gap: 12px;
        }
        .score-label {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .score-value {
            font-size: 13px;
            font-weight: 500;
            text-align: right;
        }
        .tags {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .tag {
            display: inline-block;
            padding: 4px 10px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 12px;
            font-size: 12px;
        }
        .description h1, .description h2, .description h3 {
            font-size: 14px;
            margin-top: 8px;
            margin-bottom: 4px;
            color: var(--vscode-foreground);
        }
        .description a {
            color: var(--vscode-textLink-foreground);
        }
        .description p {
            margin: 4px 0;
        }
        .inferred-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-left: 8px;
        }
        ${getContentStyles()}
    `
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
                <span class="score-label">Security</span>
                <div class="score-bar"><div class="score-fill" style="width: ${scoreBreakdown.security}%"></div></div>
                <span class="score-value">${scoreBreakdown.security}</span>
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
 * Generate the JavaScript for the webview
 */
function getScript(nonce: string): string {
  return `
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        document.getElementById('installBtn').addEventListener('click', function() {
            vscode.postMessage({ command: 'install' });
        });

        const repoBtn = document.getElementById('repoBtn');
        if (repoBtn) {
            repoBtn.addEventListener('click', function() {
                const url = this.getAttribute('data-url');
                if (url) {
                    vscode.postMessage({ command: 'openRepository', url: url });
                }
            });
        }

        document.querySelectorAll('.repository-link').forEach(function(link) {
            link.addEventListener('click', function() {
                const url = this.getAttribute('data-url');
                if (url) {
                    vscode.postMessage({ command: 'openRepository', url: url });
                }
            });
            link.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.click();
                }
            });
        });

        const expandBtn = document.getElementById('expandContentBtn');
        if (expandBtn) {
            expandBtn.addEventListener('click', function() {
                vscode.postMessage({ command: 'expandContent' });
            });
        }

        // Intercept all link clicks in rendered markdown content
        document.addEventListener('click', function(e) {
            const link = e.target.closest('.skill-content a[href], .description a[href]');
            if (link) {
                e.preventDefault();
                const url = link.getAttribute('href');
                if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
                    vscode.postMessage({ command: 'openExternal', url: url });
                }
            }
        });
    </script>`
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
