/**
 * Webview panel for displaying skill details
 */
import * as vscode from 'vscode'
import { escapeHtml } from '../utils/security.js'
import { generateCspNonce, getSkillDetailCsp } from '../utils/csp.js'
import { getSkillById } from '../data/mockSkills.js'
import { getMcpClient } from '../mcp/McpClient.js'
import { type McpSkillDetails } from '../mcp/types.js'

/**
 * Score breakdown type
 */
interface ScoreBreakdown {
  quality: number
  popularity: number
  maintenance: number
  security: number
  documentation: number
}

/**
 * Extended skill data with optional fields from MCP
 */
interface ExtendedSkillData {
  id: string
  name: string
  description: string
  author: string
  category: string
  trustTier: string
  score: number
  repository: string | undefined
  version: string | undefined
  tags: string[] | undefined
  installCommand: string | undefined
  scoreBreakdown: ScoreBreakdown | undefined
}

export class SkillDetailPanel {
  public static currentPanel: SkillDetailPanel | undefined
  public static readonly viewType = 'skillsmith.skillDetail'

  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri
  private _skillId: string
  private _skillData: ExtendedSkillData | null = null
  private _disposables: vscode.Disposable[] = []

  public static createOrShow(extensionUri: vscode.Uri, skillId: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    // If we already have a panel, show it
    if (SkillDetailPanel.currentPanel) {
      SkillDetailPanel.currentPanel._panel.reveal(column)
      SkillDetailPanel.currentPanel._skillId = skillId
      SkillDetailPanel.currentPanel._skillData = null
      void SkillDetailPanel.currentPanel._loadAndUpdate()
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

    // Load skill data and set the webview's initial html content
    void this._loadAndUpdate()

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message: { command: string; url?: string }) => {
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

  /**
   * Load skill data from MCP and update the panel
   */
  private async _loadAndUpdate(): Promise<void> {
    // Show loading state first
    this._panel.title = `Loading: ${this._skillId}`
    this._panel.webview.html = this._getLoadingHtml()

    // Try to fetch from MCP
    const client = getMcpClient()
    if (client.isConnected()) {
      try {
        const response = await client.getSkill(this._skillId)
        this._skillData = this._convertMcpSkill(response.skill, response.installCommand)
      } catch (error) {
        console.warn('[Skillsmith] MCP get_skill failed, falling back to mock data:', error)
        this._skillData = this._getMockSkillData()
      }
    } else {
      // Fall back to mock data
      this._skillData = this._getMockSkillData()
    }

    this._update()
  }

  /**
   * Get skill data from mock source
   */
  private _getMockSkillData(): ExtendedSkillData {
    const mockData = getSkillById(this._skillId)
    return {
      id: mockData.id,
      name: mockData.name,
      description: mockData.description,
      author: mockData.author,
      category: mockData.category,
      trustTier: mockData.trustTier,
      score: mockData.score,
      repository: mockData.repository,
      version: undefined,
      tags: undefined,
      installCommand: undefined,
      scoreBreakdown: undefined,
    }
  }

  /**
   * Convert MCP skill details to ExtendedSkillData
   */
  private _convertMcpSkill(skill: McpSkillDetails, installCommand: string): ExtendedSkillData {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      author: skill.author,
      category: skill.category,
      trustTier: skill.trustTier,
      score: skill.score,
      repository: skill.repository,
      version: skill.version,
      tags: skill.tags,
      installCommand: installCommand,
      scoreBreakdown: skill.scoreBreakdown as ScoreBreakdown | undefined,
    }
  }

  /**
   * Get loading HTML
   */
  private _getLoadingHtml(): string {
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

  private _update() {
    if (!this._skillData) {
      return
    }
    this._panel.title = `Skill: ${this._skillData.name}`
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
    return generateCspNonce()
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
    const skill = this._skillData || getSkillById(this._skillId)
    const nonce = this._getNonce()
    const csp = getSkillDetailCsp(nonce)

    // Ensure extensionUri is used (for future resource loading)
    void this._getResourceUri

    // Escape all user-controlled content to prevent XSS
    const safeName = escapeHtml(skill.name)
    const safeDescription = escapeHtml(skill.description)
    const safeAuthor = escapeHtml(skill.author)
    const safeCategory = escapeHtml(skill.category)
    const safeTrustTier = escapeHtml(skill.trustTier)
    const safeRepository = skill.repository ? escapeHtml(skill.repository) : ''

    // Handle extended skill data properties
    const extendedSkill = skill as ExtendedSkillData
    const safeVersion = extendedSkill.version ? escapeHtml(extendedSkill.version) : null
    const safeTags = extendedSkill.tags
      ? extendedSkill.tags.map((t: string) => escapeHtml(t))
      : null
    const scoreBreakdown = extendedSkill.scoreBreakdown || null

    const trustBadgeColor = this._getTrustBadgeColor(skill.trustTier)
    const trustBadgeText = this._getTrustBadgeText(skill.trustTier)

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
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

    ${
      scoreBreakdown
        ? `
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
        : ''
    }

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
