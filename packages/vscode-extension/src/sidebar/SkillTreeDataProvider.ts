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
   * Sets search results as available skills.
   *
   * The raw query is stored SEPARATELY from any display suffix (#1432 / #1433):
   * earlier code conflated the query with the `(Demo)`/`all skills` display
   * label, so the context formatter could not recover the true query. Callers
   * now pass the true `rawQuery` plus an optional `demo` flag; the demo
   * annotation is composed at render time from `demo`, never baked into the
   * stored query.
   *
   * @param results - Search results to display
   * @param rawQuery - The true search query ('' for browse-all)
   * @param meta.demo - Whether the results are demo-mode mock data
   */
  setSearchResults(results: SkillData[], rawQuery: string, meta: { demo?: boolean } = {}): void {
    this.rawQuery = rawQuery
    this.demo = meta.demo ?? false
    // `isInstalled` is intentionally false for all search results stored here.
    // Whether a registry hit is ALSO installed locally is determined at render
    // time in `getGroupChildren` via the normalized id cross-reference (H4).
    // `installedElsewhere` (set there) is the authoritative "also installed"
    // signal for the Available surface — it must never be baked into the stored
    // item because the installed set can change between renders.
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

  /**
   * Clears search results. Does NOT clear the active filters — clearing
   * results (e.g. a no-results or offline run) must leave the user's filter
   * selection intact so the Clear Filters action still reflects reality.
   */
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
   * Returns the parent of the given element.
   *
   * Required by `vscode.TreeView.reveal` (#1431 / SMI-5298). Implemented as a
   * PURE DERIVATION rather than a mutable membership map: a skill can appear in
   * BOTH the Installed and Available groups (installed AND a search hit), so any
   * cached single-parent map would be wrong. Parentage is derived solely from
   * the element's type and `contextValue`/`isInstalled`:
   *   - group items → `undefined` (root)
   *   - installed skill (`contextValue === 'installedSkill'`) → Installed group
   *   - available skill (`contextValue === 'skill'`) → Available group
   */
  getParent(element: SkillTreeItem): SkillTreeItem | undefined {
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

  /**
   * Returns the Available group `SkillTreeItem` when search results exist, else
   * `undefined` (so `reveal` no-ops). Shares the single group-builder with
   * `getRootGroups()` so the id matches and `TreeView.reveal` can resolve it.
   */
  getAvailableGroupItem(): SkillTreeItem | undefined {
    if (this.availableSkills.length === 0) {
      return undefined
    }
    return this.buildAvailableGroupItem()
  }

  /**
   * Returns installed skills in a form suitable for quickPick consumers
   * (e.g., uninstall/create commands) without requiring a tree selection.
   * Data is refreshed via `refresh()`; callers awaiting fresh state should
   * call `await provider.refreshAndWait()` first.
   */
  getInstalledSkills(): readonly SkillItemData[] {
    return this.installedSkills
  }

  /**
   * Triggers a reload and resolves when the installed-skills list is current.
   * Preferred over `refresh()` when callers need to observe the post-refresh
   * state (e.g., a command that enumerates after uninstalling).
   */
  async refreshAndWait(): Promise<void> {
    await this.loadInstalledSkills()
  }

  /**
   * Gets the root level groups.
   *
   * Ordering (#1431 / SMI-5298): when a search is active (`availableSkills`
   * populated) the Available group renders FIRST so just-searched results lead;
   * with no active search, Installed-first (the default browse layout).
   */
  private getRootGroups(): SkillTreeItem[] {
    const installedGroup = this.buildInstalledGroupItem()

    // Show available skills group only when there are search results.
    if (this.availableSkills.length > 0) {
      // Available-first while searching.
      return [this.buildAvailableGroupItem(), installedGroup]
    }

    return [installedGroup]
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
   * Builds the Available group header. Single source of truth shared by
   * `getRootGroups()`, `getAvailableGroupItem()`, and `getParent()` so the
   * stable id (`group:available`) matches across all reveal/parent lookups.
   *
   * The label is now the COUNT-BEARING header only (#1432 plan-review #8): the
   * query + filter context lives in the persistent `TreeView.message` banner,
   * so the two surfaces are complementary, not duplicate. `createGroup` appends
   * the `(N)` count; the stable `group:available` id is decoupled from the
   * label (set from `groupId` in `SkillTreeItem.setupGroupItem`), so changing
   * the label never regresses the reveal contract (#1431 / SMI-5298).
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
   * Gets children for a specific group.
   *
   * For the `available` branch the installed-key set is computed once per
   * render call and used to mark each registry hit with `installedElsewhere`
   * when its normalized slug matches a locally-installed skill. This is a
   * render-time annotation — the stored `availableSkills` items are never
   * mutated and `isInstalled` is left false so `getParent` continues routing
   * Available items to the Available group (#1431 / SMI-5298, H4 / C2).
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
