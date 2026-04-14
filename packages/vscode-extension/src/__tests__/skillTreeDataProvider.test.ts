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
      appendCodeblock() {
        return this
      }
    },
    ThemeIcon: class {
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
