/**
 * Webview panel for displaying skill details
 */
import * as vscode from 'vscode'
import { escapeHtml } from '../utils/security.js'
import { getSkillById } from '../data/mockSkills.js'

export class SkillDetailPanel {
  public static currentPanel: SkillDetailPanel | undefined
  public static readonly viewType = 'skillsmith.skillDetail'

  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri
  private _skillId: string
  private _disposables: vscode.Disposable[] = []

  public static createOrShow(extensionUri: vscode.Uri, skillId: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    // If we already have a panel, show it
    if (SkillDetailPanel.currentPanel) {
      SkillDetailPanel.currentPanel._panel.reveal(column)
      SkillDetailPanel.currentPanel._skillId = skillId
      SkillDetailPanel.currentPanel._update()
      return
    }

    // Create a new panel
    const panel = vscode.window.createWebviewPanel(
      SkillDetailPanel.viewType,
      'Skill Details',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
      }
    )

    SkillDetailPanel.currentPanel = new SkillDetailPanel(panel, extensionUri, skillId)
  }

  public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, skillId: string) {
    SkillDetailPanel.currentPanel = new SkillDetailPanel(panel, extensionUri, skillId)
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, skillId: string) {
    this._panel = panel
    this._extensionUri = extensionUri
    this._skillId = skillId

    // Set the webview's initial html content
    this._update()

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'install':
            vscode.commands.executeCommand('skillsmith.installSkill')
            return
          case 'openRepository':
            if (message.url && this._isValidUrl(message.url)) {
              vscode.env.openExternal(vscode.Uri.parse(message.url))
            }
            return
        }
      },
      null,
      this._disposables
    )
  }

  public dispose() {
    SkillDetailPanel.currentPanel = undefined

    // Clean up resources
    this._panel.dispose()

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  private _update() {
    this._panel.title = `Skill: ${this._skillId}`
    this._panel.webview.html = this._getHtmlForWebview()
  }

  /**
   * Validates that a URL is a safe HTTP/HTTPS URL
   */
  private _isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    } catch {
      return false
    }
  }

  /**
   * Gets a nonce for Content Security Policy
   */
  private _getNonce(): string {
    let text = ''
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length))
    }
    return text
  }

  /**
   * Gets the resource URI for webview content
   */
  private _getResourceUri(resourcePath: string): vscode.Uri {
    return this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', resourcePath)
    )
  }

  private _getHtmlForWebview(): string {
    const skill = getSkillById(this._skillId)
    const nonce = this._getNonce()

    // Ensure extensionUri is used (for future resource loading)
    void this._getResourceUri

    // Escape all user-controlled content to prevent XSS
    const safeName = escapeHtml(skill.name)
    const safeDescription = escapeHtml(skill.description)
    const safeAuthor = escapeHtml(skill.author)
    const safeCategory = escapeHtml(skill.category)
    const safeTrustTier = escapeHtml(skill.trustTier)
    const safeRepository = skill.repository ? escapeHtml(skill.repository) : ''

    const trustBadgeColor = this._getTrustBadgeColor(skill.trustTier)
    const trustBadgeText = this._getTrustBadgeText(skill.trustTier)

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Skill Details</title>
    <style>
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
        .badge-community { background-color: #ffc107; color: black; }
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
        .repository-link:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="header">
        <h1>${safeName}</h1>
        <span class="badge badge-${trustBadgeColor}">${trustBadgeText}</span>
    </div>

    <p class="description">${safeDescription}</p>

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

    ${
      skill.repository
        ? `
    <div class="section">
        <h2>Repository</h2>
        <span class="repository-link" data-url="${safeRepository}">${safeRepository}</span>
    </div>
    `
        : ''
    }

    <div class="actions">
        <button class="btn-primary" id="installBtn">Install Skill</button>
        ${skill.repository ? `<button class="btn-secondary" id="repoBtn" data-url="${safeRepository}">View Repository</button>` : ''}
    </div>

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
        });
    </script>
</body>
</html>`
  }

  private _getTrustBadgeColor(tier: string): string {
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

  private _getTrustBadgeText(tier: string): string {
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
}
