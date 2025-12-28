/**
 * Tree data provider for displaying installed skills
 */
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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

  constructor() {
    this.loadInstalledSkills()
  }

  refresh(): void {
    this.loadInstalledSkills()
    this._onDidChangeTreeData.fire()
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

  private loadInstalledSkills(): void {
    this.skills = []

    const config = vscode.workspace.getConfiguration('skillsmith')
    let skillsDir = config.get<string>('skillsDirectory') || '~/.claude/skills'

    // Expand home directory
    if (skillsDir.startsWith('~')) {
      skillsDir = path.join(os.homedir(), skillsDir.slice(1))
    }

    if (!fs.existsSync(skillsDir)) {
      return
    }

    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(skillsDir, entry.name)
          const skillMdPath = path.join(skillPath, 'SKILL.md')

          let description: string | undefined

          // Try to read description from SKILL.md
          if (fs.existsSync(skillMdPath)) {
            try {
              const content = fs.readFileSync(skillMdPath, 'utf-8')
              // Extract first line after the title as description
              const lines = content.split('\n')
              for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
                  description = trimmed.slice(0, 100)
                  if (trimmed.length > 100) {
                    description += '...'
                  }
                  break
                }
              }
            } catch {
              // Ignore read errors
            }
          }

          this.skills.push({
            id: entry.name,
            name: entry.name,
            description,
            path: skillPath,
          })
        }
      }
    } catch (error) {
      console.error('Failed to load installed skills:', error)
    }
  }
}
