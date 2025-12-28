/**
 * Webview panel for displaying skill details
 */
import * as vscode from 'vscode'

export class SkillDetailPanel {
  public static currentPanel: SkillDetailPanel | undefined
  public static readonly viewType = 'skillsmith.skillDetail'

  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri // Reserved for resource loading
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

    // Acknowledge extensionUri for future resource loading
    void this._extensionUri

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
            if (message.url) {
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
    const webview = this._panel.webview
    this._panel.title = `Skill: ${this._skillId}`
    this._panel.webview.html = this._getHtmlForWebview(webview)
  }

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    // Get mock skill data (replace with actual API call)
    const skill = this._getMockSkillData(this._skillId)

    const trustBadgeColor = this._getTrustBadgeColor(skill.trustTier)
    const trustBadgeText = this._getTrustBadgeText(skill.trustTier)

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
        .badge-verified {
            background-color: #28a745;
            color: white;
        }
        .badge-community {
            background-color: #ffc107;
            color: black;
        }
        .badge-standard {
            background-color: #007bff;
            color: white;
        }
        .badge-unverified {
            background-color: #6c757d;
            color: white;
        }
        .description {
            font-size: 16px;
            margin-bottom: 24px;
            color: var(--vscode-descriptionForeground);
        }
        .section {
            margin-bottom: 24px;
        }
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
        .meta-value {
            font-size: 14px;
            font-weight: 500;
        }
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
        .actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
        }
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
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .repository-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .repository-link:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${skill.name}</h1>
        <span class="badge badge-${trustBadgeColor}">${trustBadgeText}</span>
    </div>

    <p class="description">${skill.description}</p>

    <div class="section">
        <h2>Details</h2>
        <div class="meta-grid">
            <div class="meta-item">
                <div class="meta-label">Author</div>
                <div class="meta-value">${skill.author}</div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Category</div>
                <div class="meta-value">${skill.category}</div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Score</div>
                <div class="meta-value">${skill.score}/100</div>
                <div class="score-bar">
                    <div class="score-fill" style="width: ${skill.score}%"></div>
                </div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Trust Tier</div>
                <div class="meta-value">${skill.trustTier}</div>
            </div>
        </div>
    </div>

    ${
      skill.repository
        ? `
    <div class="section">
        <h2>Repository</h2>
        <a href="#" class="repository-link" onclick="openRepository('${skill.repository}')">${skill.repository}</a>
    </div>
    `
        : ''
    }

    <div class="actions">
        <button class="btn-primary" onclick="installSkill()">Install Skill</button>
        ${skill.repository ? `<button class="btn-secondary" onclick="openRepository('${skill.repository}')">View Repository</button>` : ''}
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function installSkill() {
            vscode.postMessage({ command: 'install' });
        }

        function openRepository(url) {
            vscode.postMessage({ command: 'openRepository', url });
        }
    </script>
</body>
</html>`
  }

  private _getMockSkillData(skillId: string): {
    id: string
    name: string
    description: string
    author: string
    category: string
    trustTier: string
    score: number
    repository?: string
  } {
    // Mock data - replace with actual API call
    const skills: Record<
      string,
      {
        id: string
        name: string
        description: string
        author: string
        category: string
        trustTier: string
        score: number
        repository?: string
      }
    > = {
      governance: {
        id: 'governance',
        name: 'Governance',
        description:
          'Enforces engineering standards from standards.md. Ensures code quality and best practices across your project.',
        author: 'skillsmith',
        category: 'development',
        trustTier: 'verified',
        score: 95,
        repository: 'https://github.com/skillsmith/governance-skill',
      },
      'linear-integration': {
        id: 'linear-integration',
        name: 'Linear Integration',
        description:
          'Manages Linear issues, projects, and workflows. Sync tasks directly from VS Code.',
        author: 'skillsmith',
        category: 'productivity',
        trustTier: 'verified',
        score: 92,
        repository: 'https://github.com/skillsmith/linear-skill',
      },
    }

    return (
      skills[skillId] || {
        id: skillId,
        name: skillId,
        description: 'Skill details not available',
        author: 'Unknown',
        category: 'other',
        trustTier: 'unverified',
        score: 0,
      }
    )
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
