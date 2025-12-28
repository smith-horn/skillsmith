/**
 * Tree data provider for displaying search results
 */
import * as vscode from 'vscode'

export interface SearchResultItem {
  id: string
  name: string
  description: string
  author: string
  category: string
  trustTier: string
  score: number
  repository?: string
}

export class SkillSearchProvider implements vscode.TreeDataProvider<SearchResultItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SearchResultItem | undefined | null | void
  >()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private searchResults: SearchResultItem[] = []
  private lastQuery: string = ''

  setResults(results: SearchResultItem[], query: string): void {
    this.searchResults = results
    this.lastQuery = query
    this._onDidChangeTreeData.fire()
  }

  clearResults(): void {
    this.searchResults = []
    this.lastQuery = ''
    this._onDidChangeTreeData.fire()
  }

  getResults(): SearchResultItem[] {
    return this.searchResults
  }

  getLastQuery(): string {
    return this.lastQuery
  }

  getTreeItem(element: SearchResultItem): vscode.TreeItem {
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

  getChildren(element?: SearchResultItem): SearchResultItem[] {
    if (element) {
      return [] // No nested items
    }
    return this.searchResults
  }

  private createTooltip(item: SearchResultItem): vscode.MarkdownString {
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
