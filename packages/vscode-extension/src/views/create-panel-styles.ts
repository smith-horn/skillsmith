/**
 * CSS styles for the Create Skill webview panel (SMI-5313 / GH #1454).
 * Split out (mirrors skill-panel-styles.ts) to keep CreateSkillPanel.ts under
 * the 500-line gate. Uses VS Code CSS variables only — no external resources.
 */

/** Generate the CSS for the Create Skill form. */
export function getCreateStyles(): string {
  return `
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.5;
        }
        h1 {
            font-size: 1.4em;
            margin: 0 0 4px 0;
        }
        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin: 0 0 20px 0;
            font-size: 0.9em;
        }
        form {
            max-width: 640px;
        }
        .field {
            margin-bottom: 18px;
        }
        .field label {
            display: block;
            margin-bottom: 6px;
            font-weight: 600;
        }
        .field input[type="text"] {
            width: 100%;
            box-sizing: border-box;
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
            font-family: inherit;
            font-size: inherit;
        }
        .field input[type="text"]:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        .name-validity {
            display: block;
            margin-top: 4px;
            font-size: 0.85em;
            min-height: 1.1em;
        }
        .name-validity.valid {
            color: var(--vscode-charts-green, var(--vscode-foreground));
        }
        .name-validity.invalid {
            color: var(--vscode-errorForeground);
        }
        .error {
            display: block;
            margin-top: 4px;
            min-height: 1.1em;
            font-size: 0.85em;
            color: var(--vscode-errorForeground);
        }
        fieldset {
            border: none;
            margin: 0;
            padding: 0;
        }
        fieldset > legend {
            font-weight: 600;
            margin-bottom: 6px;
            padding: 0;
        }
        .type-cards {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .type-card {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 10px 12px;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent));
            border-radius: 4px;
            cursor: pointer;
        }
        .type-card:hover {
            border-color: var(--vscode-focusBorder);
        }
        .type-card input[type="radio"] {
            margin-top: 2px;
        }
        .type-card .type-meta {
            display: flex;
            flex-direction: column;
        }
        .type-card .type-name {
            font-weight: 600;
            text-transform: capitalize;
        }
        .type-card .type-desc {
            color: var(--vscode-descriptionForeground);
            font-size: 0.85em;
        }
        .actions {
            margin-top: 20px;
        }
        .btn-primary {
            padding: 6px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-family: inherit;
            font-size: inherit;
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground, var(--vscode-button-background));
        }
        .btn-primary:disabled {
            opacity: 0.5;
            cursor: default;
        }
        .failed-banner {
            margin-top: 16px;
            min-height: 1.1em;
            color: var(--vscode-errorForeground);
            white-space: pre-wrap;
        }
        #cliLog {
            margin-top: 16px;
            max-height: 240px;
            overflow: auto;
            padding: 8px;
            background-color: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-panel-border, transparent);
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            white-space: pre-wrap;
            word-break: break-word;
        }
        #cliLog:empty {
            display: none;
        }
        form[aria-busy="true"] {
            opacity: 0.7;
        }
    `
}
