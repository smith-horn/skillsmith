/**
 * SkillTreeDataProvider - Unified tree data provider for the skill sidebar
 * Shows both installed skills and search results in collapsible groups
 *
 * @module sidebar/SkillTreeDataProvider
 */
import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillTreeItem, type SkillItemData, type TrustTier } from './SkillTreeItem.js'
import { type SkillData } from '../data/mockSkills.js'

/** Maximum length for skill descriptions */
const MAX_DESCRIPTION_LENGTH = 100

/**
 * SkillTreeDataProvider implements TreeDataProvider for the skill sidebar
 * Provides a unified view with collapsible groups for installed and available skills
 */
export class SkillTreeDataProvider implements vscode.TreeDataProvider<SkillTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SkillTreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private installedSkills: SkillItemData[] = []
  private availableSkills: SkillItemData[] = []
  private isLoading = false
  private lastSearchQuery = ''

  constructor() {
    // Load installed skills on initialization
    void this.loadInstalledSkills()
  }

  /**
   * Refreshes the tree view by reloading installed skills
   */
  refresh(): void {
    void this.loadInstalledSkills()
  }

  /**
   * Sets search results as available skills
   *
   * @param results - Search results to display
   * @param query - The search query used
   */
  setSearchResults(results: SkillData[], query: string): void {
    this.lastSearchQuery = query
    this.availableSkills = results.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      author: skill.author,
      category: skill.category,
      trustTier: skill.trustTier as TrustTier,
      score: skill.score,
      isInstalled: false,
    }))
    this._onDidChangeTreeData.fire()
  }

  /**
   * Clears search results
   */
  clearSearchResults(): void {
    this.availableSkills = []
    this.lastSearchQuery = ''
    this._onDidChangeTreeData.fire()
  }

  /**
   * Gets the search query that was last used
   */
  getLastSearchQuery(): string {
    return this.lastSearchQuery
  }

  /**
   * Gets available skills (search results)
   */
  getAvailableSkills(): SkillItemData[] {
    return this.availableSkills
  }

  /**
   * Returns the tree item for display
   */
  getTreeItem(element: SkillTreeItem): vscode.TreeItem {
    return element
  }

  /**
   * Returns children for the given element
   * If no element is provided, returns the root groups
   */
  getChildren(element?: SkillTreeItem): SkillTreeItem[] {
    // Root level - return groups
    if (!element) {
      return this.getRootGroups()
    }

    // Group level - return skills in that group
    if (element.itemType === 'group') {
      return this.getGroupChildren(element.groupId)
    }

    // Skill level - no children
    return []
  }

  /**
   * Gets the root level groups
   */
  private getRootGroups(): SkillTreeItem[] {
    const groups: SkillTreeItem[] = []

    // Always show installed skills group
    groups.push(
      SkillTreeItem.createGroup('Installed Skills', 'installed', this.installedSkills.length, true)
    )

    // Show available skills group if there are search results
    if (this.availableSkills.length > 0) {
      const label = this.lastSearchQuery
        ? `Available Skills - "${this.lastSearchQuery}"`
        : 'Available Skills'

      groups.push(SkillTreeItem.createGroup(label, 'available', this.availableSkills.length, true))
    }

    return groups
  }

  /**
   * Gets children for a specific group
   */
  private getGroupChildren(groupId?: string): SkillTreeItem[] {
    switch (groupId) {
      case 'installed':
        return this.installedSkills.map((skill) => SkillTreeItem.createSkill(skill))
      case 'available':
        return this.availableSkills.map((skill) => SkillTreeItem.createSkill(skill))
      default:
        return []
    }
  }

  /**
   * Loads installed skills from the filesystem
   */
  private async loadInstalledSkills(): Promise<void> {
    if (this.isLoading) {
      return
    }

    this.isLoading = true

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
        // Directory doesn't exist, clear installed skills
        this.installedSkills = []
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
          let trustTier: TrustTier = 'unverified'

          // Try to read description and trust tier from SKILL.md
          try {
            const content = await fs.readFile(skillMdPath, 'utf-8')
            description = this.extractDescription(content)
            trustTier = this.extractTrustTier(content)
          } catch {
            // Ignore read errors - file may not exist
          }

          return {
            id: entry.name,
            name: entry.name,
            description,
            trustTier,
            path: skillPath,
            isInstalled: true,
          }
        })

      this.installedSkills = await Promise.all(skillPromises)
    } catch (error) {
      console.error('[Skillsmith] Failed to load installed skills:', error)
      this.installedSkills = []
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

  /**
   * Extracts trust tier from SKILL.md content
   * Looks for trust tier badge or frontmatter
   */
  private extractTrustTier(content: string): TrustTier {
    const lowerContent = content.toLowerCase()

    // Check for trust tier badges
    if (lowerContent.includes('trust-verified') || lowerContent.includes('verified')) {
      return 'verified'
    }
    if (lowerContent.includes('trust-community') || lowerContent.includes('community')) {
      return 'community'
    }
    if (lowerContent.includes('trust-standard') || lowerContent.includes('standard')) {
      return 'standard'
    }

    return 'unverified'
  }
}
