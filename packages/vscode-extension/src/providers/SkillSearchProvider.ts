/**
 * Tree data provider for displaying search results
 */
import * as vscode from 'vscode'
import { type SkillData } from '../data/mockSkills.js'

export class SkillSearchProvider implements vscode.TreeDataProvider<SkillData> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SkillData | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private searchResults: SkillData[] = []
  private lastQuery: string = ''

  setResults(results: SkillData[], query: string): void {
    this.searchResults = results
    this.lastQuery = query
    this._onDidChangeTreeData.fire()
  }

  clearResults(): void {
    this.searchResults = []
    this.lastQuery = ''
    this._onDidChangeTreeData.fire()
  }

  getResults(): SkillData[] {
    return this.searchResults
  }

  getLastQuery(): string {
    return this.lastQuery
  }

  getTreeItem(element: SkillData): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None)

    treeItem.id = element.id
    treeItem.description = `by ${element.author} | ${element.trustTier}`
    treeItem.tooltip = this.createTooltip(element)
    treeItem.contextValue = 'skill'
    treeItem.iconPath = this.getTrustTierIcon(element.trustTier)
    treeItem.command = {
      command: 'skillsmith.viewSkillDetails',
      title: 'View Details',
      arguments: [element.id],
    }

    return treeItem
  }

  getChildren(element?: SkillData): SkillData[] {
    if (element) {
      return [] // No nested items
    }
    return this.searchResults
  }

  private createTooltip(item: SkillData): vscode.MarkdownString {
    const md = new vscode.MarkdownString()
    md.appendMarkdown(`## ${item.name}\n\n`)
    md.appendMarkdown(`${item.description}\n\n`)
    md.appendMarkdown(`---\n\n`)
    md.appendMarkdown(`- **Author:** ${item.author}\n`)
    md.appendMarkdown(`- **Category:** ${item.category}\n`)
    md.appendMarkdown(
      `- **Trust Tier:** ${this.getTrustTierEmoji(item.trustTier)} ${item.trustTier}\n`
    )
    md.appendMarkdown(`- **Score:** ${item.score}/100\n`)
    if (item.repository) {
      md.appendMarkdown(`- **Repository:** [${item.repository}](${item.repository})\n`)
    }
    return md
  }

  private getTrustTierIcon(tier: string): vscode.ThemeIcon {
    switch (tier.toLowerCase()) {
      case 'verified':
        return new vscode.ThemeIcon('verified-filled', new vscode.ThemeColor('charts.green'))
      case 'community':
        return new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'))
      case 'standard':
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
      default:
        return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.gray'))
    }
  }

  private getTrustTierEmoji(tier: string): string {
    switch (tier.toLowerCase()) {
      case 'verified':
        return '✅'
      case 'community':
        return '⭐'
      case 'standard':
        return '🔵'
      default:
        return '❓'
    }
  }
}
