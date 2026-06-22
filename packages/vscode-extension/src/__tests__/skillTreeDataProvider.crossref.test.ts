/**
 * SkillTreeDataProvider — installedElsewhere cross-reference + hasSkillMd
 * (#1436 / SMI-5307)
 *
 * Split from skillTreeDataProvider.test.ts to stay under the 500-line limit.
 * These tests exercise the render-time `installedElsewhere` annotation (C2 /
 * H4) and the `hasSkillMd` flag set in `doLoadInstalledSkills`.
 */
import { describe, it, expect, vi } from 'vitest'
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
    id?: string
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
    Uri: {
      file: (s: string) => ({ toString: () => s, fsPath: s }),
      parse: (s: string) => ({ toString: () => s }),
    },
  }
})

vi.mock('../services/Telemetry.js', () => ({
  track: vi.fn(),
}))

function makeContext(): import('vscode').ExtensionContext {
  const store = new Map<string, unknown>()
  return {
    globalState: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value)
      },
      keys: () => [...store.keys()],
      setKeysForSync: vi.fn(),
    },
  } as unknown as import('vscode').ExtensionContext
}

describe('SkillTreeDataProvider installedElsewhere cross-reference (#1436 / SMI-5307)', () => {
  // C2: normalized id cross-reference — registry id `smith-horn/my-skill` must
  // match installed slug `my-skill`; unrelated `smith-horn/other` must not.
  it('C2: Available child for a registry hit matching an installed slug gets installedElsewhere', async () => {
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-c2-'))
    try {
      const skillDir = path.join(localRoot, 'my-skill')
      await fs.mkdir(skillDir)

      const vscode = await import('vscode')
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => localRoot),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
      const provider = new SkillTreeDataProvider(makeContext())
      await provider.refreshAndWait()

      provider.setSearchResults(
        [
          {
            id: 'smith-horn/my-skill',
            name: 'My Skill',
            description: 'desc',
            author: 'smith-horn',
            category: 'cat',
            trustTier: 'verified',
            score: 80,
          },
          {
            id: 'smith-horn/other',
            name: 'Other',
            description: 'desc2',
            author: 'smith-horn',
            category: 'cat',
            trustTier: 'community',
            score: 60,
          },
        ],
        'test'
      )

      const availableGroup = provider.getChildren().find((g) => g.groupId === 'available')
      if (!availableGroup) throw new Error('expected an available group')
      const children = provider.getChildren(availableGroup)

      const mySkillItem = children.find((c) => c.skillData?.id === 'smith-horn/my-skill')
      const otherItem = children.find((c) => c.skillData?.id === 'smith-horn/other')

      if (!mySkillItem) throw new Error('expected smith-horn/my-skill in available children')
      if (!otherItem) throw new Error('expected smith-horn/other in available children')

      // The matching hit must carry the installedElsewhere marker.
      expect(mySkillItem.skillData?.installedElsewhere).toBe(true)
      expect(String(mySkillItem.description)).toContain('✓ Installed')

      // The non-matching hit must not.
      expect(otherItem.skillData?.installedElsewhere).toBeFalsy()
      expect(String(otherItem.description)).not.toContain('✓ Installed')
    } finally {
      await fs.rm(localRoot, { recursive: true, force: true })
    }
  })

  // Async ordering (a): search results arrive BEFORE installed scan completes;
  // after scan, re-rendering getGroupChildren must apply the marker.
  it('async ordering (a): setSearchResults before installed load — marker present after load', async () => {
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-async-a-'))
    try {
      const skillDir = path.join(localRoot, 'my-skill')
      await fs.mkdir(skillDir)

      const vscode = await import('vscode')
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => localRoot),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
      const provider = new SkillTreeDataProvider(makeContext())

      // Set search results immediately (before the constructor-fired load settles).
      provider.setSearchResults(
        [
          {
            id: 'smith-horn/my-skill',
            name: 'My Skill',
            description: 'd',
            author: 'a',
            category: 'cat',
            trustTier: 'verified',
            score: 80,
          },
        ],
        'test'
      )

      // Wait for the installed load to complete; getGroupChildren re-evaluates
      // against the now-populated installedSkills on the next getChildren call.
      await provider.refreshAndWait()

      const availableGroup = provider.getChildren().find((g) => g.groupId === 'available')
      if (!availableGroup) throw new Error('expected an available group')
      const children = provider.getChildren(availableGroup)
      const item = children.find((c) => c.skillData?.id === 'smith-horn/my-skill')
      if (!item) throw new Error('expected smith-horn/my-skill')

      expect(item.skillData?.installedElsewhere).toBe(true)
    } finally {
      await fs.rm(localRoot, { recursive: true, force: true })
    }
  })

  // Async ordering (b): installed scan completes first, then search arrives.
  it('async ordering (b): installed load first, then setSearchResults — marker present', async () => {
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-async-b-'))
    try {
      const skillDir = path.join(localRoot, 'my-skill')
      await fs.mkdir(skillDir)

      const vscode = await import('vscode')
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => localRoot),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
      const provider = new SkillTreeDataProvider(makeContext())
      await provider.refreshAndWait()

      // Search arrives after load has settled.
      provider.setSearchResults(
        [
          {
            id: 'smith-horn/my-skill',
            name: 'My Skill',
            description: 'd',
            author: 'a',
            category: 'cat',
            trustTier: 'verified',
            score: 80,
          },
        ],
        'test'
      )

      const availableGroup = provider.getChildren().find((g) => g.groupId === 'available')
      if (!availableGroup) throw new Error('expected an available group')
      const children = provider.getChildren(availableGroup)
      const item = children.find((c) => c.skillData?.id === 'smith-horn/my-skill')
      if (!item) throw new Error('expected smith-horn/my-skill')

      expect(item.skillData?.installedElsewhere).toBe(true)
    } finally {
      await fs.rm(localRoot, { recursive: true, force: true })
    }
  })

  // H4 / reveal-contract guard: a search hit that is also installed still
  // parents to the Available group, never to the Installed group.
  // `getAvailableGroupItem().id === 'group:available'` must be unchanged.
  it('reveal-contract guard: installedElsewhere item still parents to Available group', async () => {
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-reveal-'))
    try {
      const skillDir = path.join(localRoot, 'my-skill')
      await fs.mkdir(skillDir)

      const vscode = await import('vscode')
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => localRoot),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
      const provider = new SkillTreeDataProvider(makeContext())
      await provider.refreshAndWait()

      provider.setSearchResults(
        [
          {
            id: 'smith-horn/my-skill',
            name: 'My Skill',
            description: 'd',
            author: 'a',
            category: 'cat',
            trustTier: 'verified',
            score: 80,
          },
        ],
        'test'
      )

      const availableGroup = provider.getChildren().find((g) => g.groupId === 'available')
      if (!availableGroup) throw new Error('expected an available group')
      const children = provider.getChildren(availableGroup)
      const item = children.find((c) => c.skillData?.id === 'smith-horn/my-skill')
      if (!item) throw new Error('expected smith-horn/my-skill')

      // installedElsewhere is set, but isInstalled stays false and contextValue
      // stays 'skill' — getParent must route to Available, not Installed.
      expect(item.skillData?.installedElsewhere).toBe(true)
      expect(item.skillData?.isInstalled).toBe(false)
      expect(item.contextValue).toBe('skill')

      const parent = provider.getParent(item)
      expect(parent?.groupId).toBe('available')
      expect(parent?.id).toBe('group:available')

      // Stable Available group id is unaffected by the cross-reference.
      expect(provider.getAvailableGroupItem()?.id).toBe('group:available')
    } finally {
      await fs.rm(localRoot, { recursive: true, force: true })
    }
  })
})

describe('SkillTreeDataProvider hasSkillMd (#1436 / SMI-5307)', () => {
  it('installed skill with SKILL.md present → hasSkillMd true', async () => {
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-skillmd-'))
    try {
      const skillDir = path.join(localRoot, 'has-skill-md')
      await fs.mkdir(skillDir)
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: has-skill-md\n---\nDesc')

      const vscode = await import('vscode')
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => localRoot),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
      const provider = new SkillTreeDataProvider(makeContext())
      await provider.refreshAndWait()

      const installed = provider.getInstalledSkills()
      expect(installed).toHaveLength(1)
      expect(installed[0]?.hasSkillMd).toBe(true)
    } finally {
      await fs.rm(localRoot, { recursive: true, force: true })
    }
  })

  it('installed skill without SKILL.md → hasSkillMd falsy (undefined)', async () => {
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-noskillmd-'))
    try {
      const skillDir = path.join(localRoot, 'no-skill-md')
      await fs.mkdir(skillDir)
      // No SKILL.md written — readFile throws, hasSkillMd stays false/undefined.

      const vscode = await import('vscode')
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => localRoot),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
      const provider = new SkillTreeDataProvider(makeContext())
      await provider.refreshAndWait()

      const installed = provider.getInstalledSkills()
      expect(installed).toHaveLength(1)
      expect(installed[0]?.hasSkillMd).toBeFalsy()
    } finally {
      await fs.rm(localRoot, { recursive: true, force: true })
    }
  })
})
