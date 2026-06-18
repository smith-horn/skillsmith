/**
 * Tree data provider for displaying search results
 */
import * as vscode from 'vscode'
import { type SkillData } from '../types/skill.js'
import { getTrustTierIcon, getTrustTierEmoji, getTrustTierLabel } from '../sidebar/trustTier.js'

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
    const label = getTrustTierLabel(element.trustTier)
    treeItem.description = label ? `by ${element.author} | ${label}` : `by ${element.author}`
    treeItem.tooltip = this.createTooltip(element)
    treeItem.contextValue = 'skill'
    treeItem.iconPath = getTrustTierIcon(element.trustTier)
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
    const emoji = getTrustTierEmoji(item.trustTier)
    const label = getTrustTierLabel(item.trustTier)
    if (label) {
      md.appendMarkdown(`- **Trust Tier:** ${emoji} ${label}\n`)
    }
    md.appendMarkdown(`- **Score:** ${item.score}/100\n`)
    if (item.repository) {
      md.appendMarkdown(`- **Repository:** [${item.repository}](${item.repository})\n`)
    }
    return md
  }
}
