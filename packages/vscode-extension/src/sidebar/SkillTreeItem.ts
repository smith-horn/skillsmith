/**
 * SkillTreeItem - Represents a skill item in the tree view
 * Supports both installed skills and available skills with trust tier badges
 *
 * @module sidebar/SkillTreeItem
 */
import * as vscode from 'vscode'

/**
 * Trust tier values for skills
 */
export type TrustTier = 'verified' | 'community' | 'standard' | 'unverified'

/**
 * Data for a skill tree item
 */
export interface SkillItemData {
  id: string
  name: string
  description: string | undefined
  author?: string
  trustTier?: TrustTier
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
    this.iconPath = this.getTrustTierIcon(data.trustTier)

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

    if (data.trustTier && data.trustTier !== 'unverified') {
      parts.push(data.trustTier)
    }

    return parts.join(' | ')
  }

  /**
   * Creates a rich tooltip for the skill item
   */
  private createTooltip(data: SkillItemData): vscode.MarkdownString {
    const md = new vscode.MarkdownString()

    md.appendMarkdown(`## ${data.name}\n\n`)

    if (data.description) {
      md.appendMarkdown(`${data.description}\n\n`)
    }

    md.appendMarkdown(`---\n\n`)

    if (data.author) {
      md.appendMarkdown(`- **Author:** ${data.author}\n`)
    }

    if (data.category) {
      md.appendMarkdown(`- **Category:** ${data.category}\n`)
    }

    if (data.trustTier) {
      const emoji = this.getTrustTierEmoji(data.trustTier)
      md.appendMarkdown(`- **Trust Tier:** ${emoji} ${data.trustTier}\n`)
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
   * Gets the appropriate icon for a trust tier
   */
  private getTrustTierIcon(tier?: TrustTier): vscode.ThemeIcon {
    switch (tier) {
      case 'verified':
        return new vscode.ThemeIcon('verified-filled', new vscode.ThemeColor('charts.green'))
      case 'community':
        return new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'))
      case 'standard':
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
      case 'unverified':
      default:
        return new vscode.ThemeIcon('symbol-misc', new vscode.ThemeColor('charts.gray'))
    }
  }

  /**
   * Gets the emoji for a trust tier
   */
  private getTrustTierEmoji(tier: TrustTier): string {
    switch (tier) {
      case 'verified':
        return '(verified)'
      case 'community':
        return '(star)'
      case 'standard':
        return '(circle)'
      default:
        return '(question)'
    }
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
