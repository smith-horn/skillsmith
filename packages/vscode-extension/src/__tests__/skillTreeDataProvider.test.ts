import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('vscode', () => {
  class TreeItem {
    constructor(
      public label: string,
      public collapsibleState?: number
    ) {}
    iconPath?: unknown
    description?: string
    tooltip?: unknown
    contextValue?: string
    command?: unknown
  }
  return {
    EventEmitter: class {
      event = vi.fn()
      fire = vi.fn()
    },
    workspace: {
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })),
    },
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    MarkdownString: class {
      value = ''
      isTrusted = true
      appendMarkdown(s: string) {
        this.value += s
        return this
      }
      appendText(s: string) {
        this.value += s
        return this
      }
      appendCodeblock() {
        return this
      }
    },
    ThemeIcon: class {
      constructor(
        public id: string,
        public color?: unknown
      ) {}
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
  }
})

describe('SkillTreeDataProvider installed-skills API (SMI-4194)', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-tree-'))
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('getInstalledSkills returns empty array before any refresh', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    expect(provider.getInstalledSkills()).toEqual([])
  })

  it('refreshAndWait populates installed skills from skillsDirectory', async () => {
    const skillDir = path.join(tempRoot, 'my-skill')
    await fs.mkdir(skillDir)
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\n---\nMy skill description'
    )

    const vscode = await import('vscode')
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(() => tempRoot),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    // Mock must be set BEFORE constructor fires loadInstalledSkills.
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    // The constructor-fired load shares its in-flight promise with refreshAndWait,
    // so awaiting refreshAndWait guarantees the initial load has settled.
    await provider.refreshAndWait()

    const installed = provider.getInstalledSkills()
    expect(installed).toHaveLength(1)
    const first = installed[0]
    if (!first) throw new Error('expected one installed skill')
    expect(first.id).toBe('my-skill')
    expect(first.isInstalled).toBe(true)
  })
})

describe('SkillTreeDataProvider unified search surface (#1431 / SMI-5298)', () => {
  // No skillsDirectory configured → installed group stays empty; these tests
  // exercise only the in-memory search/available-group surface.
  const sampleResults = [
    {
      id: 'a/one',
      name: 'one',
      description: 'first',
      author: 'a',
      category: 'cat',
      trustTier: 'verified',
      score: 90,
    },
    {
      id: 'b/two',
      name: 'two',
      description: 'second',
      author: 'b',
      category: 'cat',
      trustTier: 'community',
      score: 50,
    },
  ]

  it('setSearchResults populates the Available group; clearSearchResults empties it', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()

    provider.setSearchResults(sampleResults, 'docker')
    expect(provider.getAvailableSkills()).toHaveLength(2)
    expect(provider.getLastSearchQuery()).toBe('docker')

    provider.clearSearchResults()
    expect(provider.getAvailableSkills()).toHaveLength(0)
    expect(provider.getLastSearchQuery()).toBe('')
  })

  it('renders Available group first while searching, with the em-dash query label', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    provider.setSearchResults(sampleResults, 'docker')

    const roots = provider.getChildren()
    expect(roots).toHaveLength(2)
    // Available-first ordering.
    expect(roots[0]?.groupId).toBe('available')
    expect(roots[1]?.groupId).toBe('installed')
    expect(roots[0]?.label).toBe('Available Skills — "docker" (2)')
  })

  it('renders Installed group first (only) when no search is active', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()

    const roots = provider.getChildren()
    expect(roots).toHaveLength(1)
    expect(roots[0]?.groupId).toBe('installed')
  })

  it('getChildren on the available group returns the search-result skill items', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    provider.setSearchResults(sampleResults, 'docker')

    const roots = provider.getChildren()
    const availableGroup = roots.find((g) => g.groupId === 'available')
    if (!availableGroup) throw new Error('expected an available group')
    const children = provider.getChildren(availableGroup)
    expect(children).toHaveLength(2)
    expect(children.every((c) => c.itemType === 'skill')).toBe(true)
  })

  it('getAvailableGroupItem returns the group when results exist, undefined otherwise', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()

    expect(provider.getAvailableGroupItem()).toBeUndefined()

    provider.setSearchResults(sampleResults, 'docker')
    const group = provider.getAvailableGroupItem()
    expect(group).toBeDefined()
    expect(group?.groupId).toBe('available')

    // Id matches the Available entry from getChildren/getRootGroups.
    const roots = provider.getChildren()
    const fromRoots = roots.find((g) => g.groupId === 'available')
    expect(group?.id).toBe(fromRoots?.id)
  })

  it('group ids are stable across calls (so TreeView.reveal can match)', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    provider.setSearchResults(sampleResults, 'docker')

    const first = provider.getAvailableGroupItem()
    const second = provider.getAvailableGroupItem()
    expect(first?.id).toBe('group:available')
    expect(first?.id).toBe(second?.id)

    const installedFirst = provider.getChildren().find((g) => g.groupId === 'installed')
    expect(installedFirst?.id).toBe('group:installed')
  })

  it('getParent: group items resolve to undefined (root)', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    provider.setSearchResults(sampleResults, 'docker')

    const roots = provider.getChildren()
    for (const group of roots) {
      expect(provider.getParent(group)).toBeUndefined()
    }
  })

  it('getParent: an available (skill) item resolves to the Available group', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    provider.setSearchResults(sampleResults, 'docker')

    const availableGroup = provider.getChildren().find((g) => g.groupId === 'available')
    if (!availableGroup) throw new Error('expected an available group')
    const skillItem = provider.getChildren(availableGroup)[0]
    if (!skillItem) throw new Error('expected an available skill item')
    expect(skillItem.contextValue).toBe('skill')

    const parent = provider.getParent(skillItem)
    expect(parent?.groupId).toBe('available')
    expect(parent?.id).toBe('group:available')
  })

  it('getParent: an installed (installedSkill) item resolves to the Installed group', async () => {
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-getparent-'))
    try {
      const skillDir = path.join(localRoot, 'installed-one')
      await fs.mkdir(skillDir)
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: installed-one\n---\nInstalled'
      )

      const vscode = await import('vscode')
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => localRoot),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
      const provider = new SkillTreeDataProvider()
      await provider.refreshAndWait()

      const installedGroup = provider.getChildren().find((g) => g.groupId === 'installed')
      if (!installedGroup) throw new Error('expected an installed group')
      const skillItem = provider.getChildren(installedGroup)[0]
      if (!skillItem) throw new Error('expected an installed skill item')
      expect(skillItem.contextValue).toBe('installedSkill')

      const parent = provider.getParent(skillItem)
      expect(parent?.groupId).toBe('installed')
      expect(parent?.id).toBe('group:installed')
    } finally {
      await fs.rm(localRoot, { recursive: true, force: true })
    }
  })
})
