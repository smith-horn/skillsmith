/**
 * CSS styles for SkillDetailPanel
 * Extracted from skill-panel-html.ts (SMI-3728) to stay under 500-line limit.
 */

import { getContentStyles } from './skill-panel-content.js'

/**
 * Generate the CSS styles for the skill detail panel
 */
export function getStyles(): string {
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
