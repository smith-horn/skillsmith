/**
 * SkillTreeItem - Represents a skill item in the tree view
 * Supports both installed skills and available skills with trust tier badges
 *
 * @module sidebar/SkillTreeItem
 */
import * as vscode from 'vscode'
import {
  type ExtensionTrustTier,
  getTrustTierIcon,
  getTrustTierEmoji,
  getTrustTierLabel,
} from './trustTier.js'

/**
 * TrustTier is now the canonical 5-tier model. Re-exported as an alias for
 * backward compatibility with external consumers.
 */
export type { ExtensionTrustTier as TrustTier } from './trustTier.js'

/**
 * Data for a skill tree item
 */
export interface SkillItemData {
  id: string
  name: string
  description: string | undefined
  author?: string
  trustTier?: ExtensionTrustTier
  category?: string
  score?: number
  path?: string
  isInstalled: boolean
}

/**
 * Tree item types for the skill sidebar
 */
export type SkillTreeItemType = 'group' | 'skill'

/**
 * SkillTreeItem represents a node in the skill tree view
 * Can be either a group header or an individual skill
 */
export class SkillTreeItem extends vscode.TreeItem {
  public readonly itemType: SkillTreeItemType
  public readonly skillData: SkillItemData | undefined
  public readonly groupId: string | undefined

  /**
   * Creates a SkillTreeItem instance
   *
   * @param label - Display label for the item
   * @param collapsibleState - Whether the item is collapsible
   * @param itemType - Type of item (group or skill)
   * @param data - Optional skill data for skill items
   * @param groupId - Optional group identifier for group items
   */
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    itemType: SkillTreeItemType,
    data: SkillItemData | undefined,
    groupId: string | undefined
  ) {
    super(label, collapsibleState)
    this.itemType = itemType
    this.skillData = data
    this.groupId = groupId

    if (itemType === 'skill' && data) {
      this.setupSkillItem(data)
    } else if (itemType === 'group') {
      this.setupGroupItem(groupId)
    }
  }

  /**
   * Sets up the tree item for a skill
   */
  private setupSkillItem(data: SkillItemData): void {
    this.id = data.id
    this.description = this.formatDescription(data)
    this.tooltip = this.createTooltip(data)
    this.contextValue = data.isInstalled ? 'installedSkill' : 'skill'
    this.iconPath = getTrustTierIcon(data.trustTier)

    // Set command to view details
    this.command = {
      command: 'skillsmith.viewSkillDetails',
      title: 'View Details',
      arguments: [data.id],
    }
  }

  /**
   * Sets up the tree item for a group header
   */
  private setupGroupItem(groupId?: string): void {
    this.contextValue = 'skillGroup'
    this.iconPath = this.getGroupIcon(groupId)
  }

  /**
   * Formats the description line for a skill item
   */
  private formatDescription(data: SkillItemData): string {
    const parts: string[] = []

    if (data.author) {
      parts.push(`by ${data.author}`)
    }

    const label = getTrustTierLabel(data.trustTier)
    if (label) {
      parts.push(label)
    }

    return parts.join(' | ')
  }

  /**
   * Creates a rich tooltip for the skill item
   */
  private createTooltip(data: SkillItemData): vscode.MarkdownString {
    const md = new vscode.MarkdownString()
    md.isTrusted = false

    md.appendMarkdown('## ')
    md.appendText(data.name)
    md.appendMarkdown('\n\n')

    if (data.description) {
      md.appendText(data.description)
      md.appendMarkdown('\n\n')
    }

    md.appendMarkdown(`---\n\n`)

    if (data.author) {
      md.appendMarkdown('- **Author:** ')
      md.appendText(data.author)
      md.appendMarkdown('\n')
    }

    if (data.category) {
      md.appendMarkdown('- **Category:** ')
      md.appendText(data.category)
      md.appendMarkdown('\n')
    }

    const tierEmoji = getTrustTierEmoji(data.trustTier)
    const tierLabel = getTrustTierLabel(data.trustTier)
    if (tierLabel) {
      md.appendMarkdown(`- **Trust Tier:** ${tierEmoji} ${tierLabel}\n`)
    }

    if (data.score !== undefined) {
      md.appendMarkdown(`- **Score:** ${data.score}/100\n`)
    }

    if (data.path) {
      md.appendMarkdown(`- **Path:** \`${data.path}\`\n`)
    }

    md.appendMarkdown(`\n*${data.isInstalled ? 'Installed' : 'Available for installation'}*`)

    return md
  }

  /**
   * Gets the icon for a group header
   */
  private getGroupIcon(groupId?: string): vscode.ThemeIcon {
    switch (groupId) {
      case 'installed':
        return new vscode.ThemeIcon('folder-library')
      case 'available':
        return new vscode.ThemeIcon('cloud')
      default:
        return new vscode.ThemeIcon('symbol-misc')
    }
  }

  /**
   * Creates a group header item
   *
   * @param label - Group label
   * @param groupId - Group identifier
   * @param count - Number of items in the group
   * @param expanded - Whether the group should be expanded
   */
  static createGroup(
    label: string,
    groupId: string,
    count: number,
    expanded: boolean = true
  ): SkillTreeItem {
    const displayLabel = count > 0 ? `${label} (${count})` : label
    const state = expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed

    return new SkillTreeItem(displayLabel, state, 'group', undefined, groupId)
  }

  /**
   * Creates a skill item from skill data
   *
   * @param data - Skill data
   */
  static createSkill(data: SkillItemData): SkillTreeItem {
    return new SkillTreeItem(
      data.name,
      vscode.TreeItemCollapsibleState.None,
      'skill',
      data,
      undefined
    )
  }
}
