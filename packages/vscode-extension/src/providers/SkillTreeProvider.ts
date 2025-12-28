/**
 * Tree data provider for displaying installed skills
 */
import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

/** Maximum length for skill descriptions */
const MAX_DESCRIPTION_LENGTH = 100

export interface SkillTreeItem {
  id: string
  name: string
  description: string | undefined
  path: string
}

export class SkillTreeProvider implements vscode.TreeDataProvider<SkillTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SkillTreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private skills: SkillTreeItem[] = []
  private isLoading = false

  constructor() {
    // Load skills asynchronously
    void this.loadInstalledSkills()
  }

  refresh(): void {
    void this.loadInstalledSkills()
  }

  getTreeItem(element: SkillTreeItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None)

    treeItem.id = element.id
    if (element.description) {
      treeItem.description = element.description
    }
    treeItem.tooltip = new vscode.MarkdownString(
      `**${element.name}**\n\n${element.description || 'No description'}\n\nPath: \`${element.path}\``
    )
    treeItem.contextValue = 'installedSkill'
    treeItem.iconPath = new vscode.ThemeIcon('symbol-function')
    treeItem.command = {
      command: 'skillsmith.viewSkillDetails',
      title: 'View Details',
      arguments: [element.id],
    }

    return treeItem
  }

  getChildren(element?: SkillTreeItem): SkillTreeItem[] {
    if (element) {
      return [] // No nested items
    }
    return this.skills
  }

  private async loadInstalledSkills(): Promise<void> {
    if (this.isLoading) {
      return
    }

    this.isLoading = true
    this.skills = []

    try {
      const config = vscode.workspace.getConfiguration('skillsmith')
      let skillsDir = config.get<string>('skillsDirectory') || '~/.claude/skills'

      // Expand home directory
      if (skillsDir.startsWith('~')) {
        skillsDir = path.join(os.homedir(), skillsDir.slice(1))
      }

      // Check if directory exists
      try {
        await fs.access(skillsDir)
      } catch {
        // Directory doesn't exist, return empty list
        this._onDidChangeTreeData.fire()
        return
      }

      const entries = await fs.readdir(skillsDir, { withFileTypes: true })

      // Process entries in parallel
      const skillPromises = entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const skillPath = path.join(skillsDir, entry.name)
          const skillMdPath = path.join(skillPath, 'SKILL.md')

          let description: string | undefined

          // Try to read description from SKILL.md
          try {
            const content = await fs.readFile(skillMdPath, 'utf-8')
            description = this.extractDescription(content)
          } catch {
            // Ignore read errors - file may not exist
          }

          return {
            id: entry.name,
            name: entry.name,
            description,
            path: skillPath,
          }
        })

      this.skills = await Promise.all(skillPromises)
    } catch (error) {
      console.error('Failed to load installed skills:', error)
    } finally {
      this.isLoading = false
      this._onDidChangeTreeData.fire()
    }
  }

  /**
   * Extracts the first meaningful line from SKILL.md as the description
   */
  private extractDescription(content: string): string | undefined {
    const lines = content.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      // Skip empty lines, headers, and frontmatter delimiters
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
        if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
          return trimmed.slice(0, MAX_DESCRIPTION_LENGTH) + '...'
        }
        return trimmed
      }
    }
    return undefined
  }
}
