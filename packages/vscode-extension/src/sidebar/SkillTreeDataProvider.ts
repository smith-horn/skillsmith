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
import { SkillTreeItem, type SkillItemData } from './SkillTreeItem.js'
import { type ExtensionTrustTier, normalizeTrustTier, getTrustTierLabel } from './trustTier.js'
import { type SkillData } from '../types/skill.js'
import { type SearchFilters } from '../commands/searchFilters.js'
import { buildInstalledKeySet, skillComparisonKey } from '../utils/skillId.js'
import { NextStepsManager } from './SkillTreeDataProvider.nextSteps.js'

/** Maximum length for skill descriptions */
const MAX_DESCRIPTION_LENGTH = 100

/**
 * Structured description of the active discovery context (#1432 / SMI-5305).
 *
 * The SINGLE source of truth (plan-review #1) from which BOTH the Available
 * group label and the persistent `TreeView.message` banner are composed, so the
 * two surfaces can never drift. Each surface picks the parts it owns:
 *   - banner = `rawQuery` + `filterParts` (the "Showing results for…" sentence)
 *   - group label = the count header (`Available Skills (N)`)
 */
export interface ActiveContext {
  /** The true search query (distinct from any `(Demo)`/`all skills` display label). */
  rawQuery: string
  /** Whether the results came from demo-mode mock data. */
  demo: boolean
  /** Ordered, human-readable active-filter labels (tier, category, `N+`). */
  filterParts: string[]
}

/**
 * SkillTreeDataProvider implements TreeDataProvider for the skill sidebar
 * Provides a unified view with collapsible groups for installed and available skills
 */
export class SkillTreeDataProvider implements vscode.TreeDataProvider<SkillTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SkillTreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private installedSkills: SkillItemData[] = []
  private availableSkills: SkillItemData[] = []
  private loadingPromise: Promise<void> | undefined
  /** The TRUE raw search query — distinct from any display label (#1432). */
  private rawQuery = ''
  /** Whether the current results came from demo-mode mock data. */
  private demo = false
  /** Active discovery filters — single source of truth (#1433). Ephemeral. */
  private filters: SearchFilters = {}
  /** Whether the MCP server is currently offline (SMI-5345). */
  private mcpOffline = false
  /** Next-steps checklist manager (SMI-5346). */
  private readonly nextStepsManager: NextStepsManager

  constructor(context: vscode.ExtensionContext) {
    this.nextStepsManager = new NextStepsManager(context)
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
   * Sets the MCP-offline state (SMI-5345).
   * When offline, a pinned reconnect row is prepended to the root groups.
   */
  setMcpOffline(isOffline: boolean): void {
    this.mcpOffline = isOffline
    this._onDidChangeTreeData.fire()
  }

  /**
   * Shows the next-steps checklist section for a newly-created skill (SMI-5346).
   *
   * - Resets the per-create dismissed flag (per-create reset).
   * - Tracks 'vscode_create_checklist_view' exactly once, synchronously.
   * - Fires _onDidChangeTreeData.
   */
  showNextSteps(name: string, targetDir: string): void {
    this.nextStepsManager.show(name, targetDir, () => {
      this._onDidChangeTreeData.fire()
    })
  }

  /**
   * Dismisses the next-steps section (SMI-5346).
   * Persists dismissal in globalState so it survives reloads.
   */
  dismissNextSteps(): void {
    this.nextStepsManager.dismiss(() => {
      this._onDidChangeTreeData.fire()
    })
  }

  /**
   * Sets search results as available skills.
   * Raw query stored separately from display suffix (#1432 / #1433).
   * @param rawQuery - The true search query ('' for browse-all)
   * @param meta.demo - Whether results are demo-mode mock data
   */
  setSearchResults(results: SkillData[], rawQuery: string, meta: { demo?: boolean } = {}): void {
    this.rawQuery = rawQuery
    this.demo = meta.demo ?? false
    // `isInstalled` stays false here; `installedElsewhere` is computed at
    // render time via cross-reference so getParent routes Available items
    // correctly (#1431 / SMI-5298, H4 / C2).
    this.availableSkills = results.map((skill) => {
      const tier = normalizeTrustTier(skill.trustTier)
      const item: SkillItemData = {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        author: skill.author,
        category: skill.category,
        score: skill.score,
        isInstalled: false,
      }
      if (tier !== undefined) {
        item.trustTier = tier
      }
      return item
    })
    this._onDidChangeTreeData.fire()
  }

  /** Clears search results without clearing active filters. */
  clearSearchResults(): void {
    this.availableSkills = []
    this.rawQuery = ''
    this.demo = false
    this._onDidChangeTreeData.fire()
  }

  /**
   * Gets the true search query last used ('' for browse-all / no search).
   */
  getLastSearchQuery(): string {
    return this.rawQuery
  }

  /** Returns the active discovery filters (single source of truth, #1433). */
  getFilters(): SearchFilters {
    return this.filters
  }

  /**
   * Replaces the active filters. Stored by value (shallow copy) so a later
   * mutation of the caller's object cannot retroactively change provider state.
   */
  setFilters(filters: SearchFilters): void {
    this.filters = { ...filters }
    this._onDidChangeTreeData.fire()
  }

  /** Clears all active filters. */
  clearFilters(): void {
    this.filters = {}
    this._onDidChangeTreeData.fire()
  }

  /** Whether any discovery filter is currently active. */
  hasActiveFilters(): boolean {
    return (
      this.filters.trustTier !== undefined ||
      this.filters.category !== undefined ||
      this.filters.minScore !== undefined
    )
  }

  /**
   * The SINGLE formatter (plan-review #1) describing the active discovery
   * context. Both the Available group label and the #1432 banner derive from
   * this, so they can never diverge. Returns the raw query, the demo flag, and
   * the ordered filter-facet labels (tier · category · `N+`).
   */
  describeActiveContext(): ActiveContext {
    const filterParts: string[] = []
    if (this.filters.trustTier !== undefined) {
      const label = getTrustTierLabel(this.filters.trustTier)
      filterParts.push(label || this.filters.trustTier)
    }
    if (this.filters.category !== undefined) {
      filterParts.push(this.filters.category)
    }
    if (this.filters.minScore !== undefined) {
      filterParts.push(`${this.filters.minScore}+`)
    }
    return { rawQuery: this.rawQuery, demo: this.demo, filterParts }
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
   * Returns the parent of the given element (required by TreeView.reveal,
   * #1431 / SMI-5298). Pure derivation — no cached map, since a skill can
   * appear in both Installed and Available groups simultaneously.
   */
  getParent(element: SkillTreeItem): SkillTreeItem | undefined {
    // Next-steps row items belong to the nextSteps group (must be checked BEFORE
    // the general group guard, because checklist rows use itemType='group').
    if (element.contextValue === 'nextStepsRow') {
      return this.nextStepsManager.buildGroupItem()
    }

    // Group items (nextSteps group, offline row, installed, available) are root items.
    if (element.itemType === 'group') {
      return undefined
    }

    const isInstalled =
      element.contextValue === 'installedSkill' || element.skillData?.isInstalled === true

    if (isInstalled) {
      return this.buildInstalledGroupItem()
    }
    return this.getAvailableGroupItem()
  }

  /** Returns the Available group item when search results exist, else undefined. */
  getAvailableGroupItem(): SkillTreeItem | undefined {
    if (this.availableSkills.length === 0) {
      return undefined
    }
    return this.buildAvailableGroupItem()
  }

  /** Returns installed skills for quickPick consumers (uninstall/create). */
  getInstalledSkills(): readonly SkillItemData[] {
    return this.installedSkills
  }

  /** Triggers a reload and resolves when the installed-skills list is current. */
  async refreshAndWait(): Promise<void> {
    await this.loadInstalledSkills()
  }

  /**
   * Gets the root level groups.
   *
   * Ordering (#1431 / SMI-5298 / SMI-5345 / SMI-5346):
   *   1. Pinned MCP-offline reconnect row (if offline)
   *   2. Next steps group (if visible)
   *   3. Available Skills (if search active) or Installed Skills (default)
   *   4. Installed Skills (always present)
   */
  private getRootGroups(): SkillTreeItem[] {
    const groups: SkillTreeItem[] = []

    // (1) Pinned offline reconnect row (SMI-5345)
    if (this.mcpOffline) {
      groups.push(SkillTreeItem.createMcpOfflineRow())
    }

    // (2) Next-steps section (SMI-5346)
    if (this.nextStepsManager.isVisible()) {
      groups.push(this.nextStepsManager.buildGroupItem())
    }

    // (3+4) Available-first while searching; otherwise Installed only.
    const installedGroup = this.buildInstalledGroupItem()
    if (this.availableSkills.length > 0) {
      groups.push(this.buildAvailableGroupItem(), installedGroup)
    } else {
      groups.push(installedGroup)
    }

    return groups
  }

  /**
   * Builds the Installed group header. Single source of truth for the group's
   * label, count, and (via `createGroup`) its stable id.
   */
  private buildInstalledGroupItem(): SkillTreeItem {
    return SkillTreeItem.createGroup(
      'Installed Skills',
      'installed',
      this.installedSkills.length,
      true
    )
  }

  /**
   * Builds the Available group header (single source of truth for label/id).
   * Label is count-bearing only (#1432); stable `group:available` id decoupled
   * from label so TreeView.reveal never regresses (#1431 / SMI-5298).
   */
  private buildAvailableGroupItem(): SkillTreeItem {
    return SkillTreeItem.createGroup(
      'Available Skills',
      'available',
      this.availableSkills.length,
      true
    )
  }

  /**
   * Gets children for a specific group. Available branch computes the
   * installedElsewhere marker at render time (H4 / #1431 / SMI-5298).
   */
  private getGroupChildren(groupId?: string): SkillTreeItem[] {
    switch (groupId) {
      case 'installed':
        return this.installedSkills.map((skill) => SkillTreeItem.createSkill(skill))
      case 'available': {
        const installedKeys = buildInstalledKeySet(this.installedSkills.map((s) => s.id))
        return this.availableSkills.map((skill) => {
          const installedElsewhere = installedKeys.has(skillComparisonKey(skill.id))
          if (installedElsewhere) {
            return SkillTreeItem.createSkill({ ...skill, installedElsewhere: true })
          }
          return SkillTreeItem.createSkill(skill)
        })
      }
      case 'nextSteps':
        return this.nextStepsManager.buildRows()
      default:
        return []
    }
  }

  /**
   * Loads installed skills from the filesystem. Concurrent callers (including
   * the constructor + a subsequent `refreshAndWait`) share the in-flight
   * promise rather than returning immediately, so callers can reliably await
   * the current state.
   */
  private async loadInstalledSkills(): Promise<void> {
    if (this.loadingPromise) {
      return this.loadingPromise
    }

    this.loadingPromise = this.doLoadInstalledSkills().finally(() => {
      this.loadingPromise = undefined
    })
    return this.loadingPromise
  }

  private async doLoadInstalledSkills(): Promise<void> {
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
          let trustTier: ExtensionTrustTier | undefined = undefined
          let hasSkillMd = false

          // Try to read description and trust tier from SKILL.md
          try {
            const content = await fs.readFile(skillMdPath, 'utf-8')
            hasSkillMd = true
            description = this.extractDescription(content)
            trustTier = this.extractTrustTier(content)
          } catch {
            // Ignore read errors - file may not exist or be unreadable
          }

          const item: SkillItemData = {
            id: entry.name,
            name: entry.name,
            description,
            path: skillPath,
            isInstalled: true,
          }
          if (trustTier !== undefined) {
            item.trustTier = trustTier
          }
          if (hasSkillMd) {
            item.hasSkillMd = true
          }
          return item
        })

      this.installedSkills = await Promise.all(skillPromises)
    } catch (error) {
      console.error('[Skillsmith] Failed to load installed skills:', error)
      this.installedSkills = []
    } finally {
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
   * Extracts trust tier from SKILL.md content by matching canonical badge strings.
   * Returns undefined when no recognizable API tier is found (e.g. a purely
   * local skill) — callers use undefined to render a neutral icon rather than
   * the red `unverified` icon.
   */
  private extractTrustTier(content: string): ExtensionTrustTier | undefined {
    const lowerContent = content.toLowerCase()

    // Match canonical badge strings in priority order (most specific first)
    if (lowerContent.includes('trust-official') || lowerContent.includes('tier:official')) {
      return 'official'
    }
    if (lowerContent.includes('trust-verified') || lowerContent.includes('tier:verified')) {
      return 'verified'
    }
    if (lowerContent.includes('trust-curated') || lowerContent.includes('tier:curated')) {
      return 'curated'
    }
    if (lowerContent.includes('trust-community') || lowerContent.includes('tier:community')) {
      return 'community'
    }
    if (lowerContent.includes('trust-unverified') || lowerContent.includes('tier:unverified')) {
      return 'unverified'
    }

    // No recognizable API tier badge → local/installed skill with no tier
    return undefined
  }
}
