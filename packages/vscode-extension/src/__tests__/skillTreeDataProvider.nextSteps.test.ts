/**
 * Unit tests for SkillTreeDataProvider next-steps and MCP-offline features
 * (SMI-5345 / SMI-5346).
 *
 * Covers:
 *  - showNextSteps adds the 'Next steps' group with 4 rows
 *  - dismissNextSteps (and the dismissed flag) hides it
 *  - a fresh showNextSteps after dismiss RE-shows (per-create reset)
 *  - setMcpOffline(true) prepends the reconnect row; false removes it
 *  - showNextSteps emits 'vscode_create_checklist_view' EXACTLY ONCE even across
 *    multiple getChildren calls (mock track)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vscode mock ───────────────────────────────────────────────────────────────
const trackMock = vi.fn()

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
  track: trackMock,
}))

// ── In-memory globalState mock ────────────────────────────────────────────────
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SkillTreeDataProvider — next-steps section (SMI-5346)', () => {
  beforeEach(() => {
    trackMock.mockReset()
    vi.resetModules()
  })

  it('showNextSteps adds a "nextSteps" group with 4 child rows', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.showNextSteps('my-skill', '/home/user/.claude/skills/my-skill')

    const roots = provider.getChildren()
    const nextStepsGroup = roots.find((g) => g.groupId === 'nextSteps')
    expect(nextStepsGroup).toBeDefined()
    expect(nextStepsGroup?.contextValue).toBe('nextStepsGroup')

    if (!nextStepsGroup) throw new Error('nextSteps group missing')
    const rows = provider.getChildren(nextStepsGroup)
    expect(rows).toHaveLength(4)
    const labels = rows.map((r) => r.label)
    expect(labels).toContain('Open skill folder')
    expect(labels).toContain('Open SKILL.md to add triggers')
    expect(labels).toContain('Run skillsmith validate')
    expect(labels).toContain('Authoring docs')
  })

  it('each checklist row has a command', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)
    provider.showNextSteps('my-skill', '/home/user/.claude/skills/my-skill')

    const roots = provider.getChildren()
    const nextStepsGroup = roots.find((g) => g.groupId === 'nextSteps')
    if (!nextStepsGroup) throw new Error('nextSteps group missing')
    const rows = provider.getChildren(nextStepsGroup)
    for (const row of rows) {
      expect(row.command).toBeDefined()
      expect(typeof (row.command as { command: string }).command).toBe('string')
    }
  })

  it('dismissNextSteps hides the section', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.showNextSteps('my-skill', '/home/user/.claude/skills/my-skill')
    expect(provider.getChildren().some((g) => g.groupId === 'nextSteps')).toBe(true)

    provider.dismissNextSteps()
    expect(provider.getChildren().some((g) => g.groupId === 'nextSteps')).toBe(false)
  })

  it('a fresh showNextSteps after dismiss RE-shows the section (per-create reset)', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.showNextSteps('skill-1', '/home/user/.claude/skills/skill-1')
    provider.dismissNextSteps()
    // Section hidden after first dismiss.
    expect(provider.getChildren().some((g) => g.groupId === 'nextSteps')).toBe(false)

    // A new create resets the dismissed flag.
    provider.showNextSteps('skill-2', '/home/user/.claude/skills/skill-2')
    expect(provider.getChildren().some((g) => g.groupId === 'nextSteps')).toBe(true)
  })

  it('showNextSteps emits vscode_create_checklist_view exactly once, not on subsequent getChildren', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.showNextSteps('my-skill', '/home/user/.claude/skills/my-skill')
    // Multiple getChildren calls must NOT trigger additional track calls.
    provider.getChildren()
    provider.getChildren()
    provider.getChildren()

    const viewCalls = trackMock.mock.calls.filter(
      (call: unknown[]) => call[0] === 'vscode_create_checklist_view'
    )
    expect(viewCalls).toHaveLength(1)
  })

  it('getParent returns the nextSteps group for a checklist row', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.showNextSteps('my-skill', '/home/user/.claude/skills/my-skill')
    const roots = provider.getChildren()
    const nextStepsGroup = roots.find((g) => g.groupId === 'nextSteps')
    if (!nextStepsGroup) throw new Error('nextSteps group missing')
    const rows = provider.getChildren(nextStepsGroup)
    const firstRow = rows[0]
    if (!firstRow) throw new Error('expected at least one row')

    const parent = provider.getParent(firstRow)
    expect(parent).toBeDefined()
    expect(parent?.groupId).toBe('nextSteps')
  })

  it('nextSteps group is inserted AFTER the offline row and BEFORE Installed', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.setMcpOffline(true)
    provider.showNextSteps('my-skill', '/home/user/.claude/skills/my-skill')

    const roots = provider.getChildren()
    const labels = roots.map((r) => r.label)
    const offlineIdx = roots.findIndex((r) => r.contextValue === 'mcpOffline')
    const nextStepsIdx = roots.findIndex((r) => r.groupId === 'nextSteps')
    const installedIdx = roots.findIndex((r) => r.groupId === 'installed')

    expect(offlineIdx).toBeGreaterThanOrEqual(0)
    expect(nextStepsIdx).toBeGreaterThan(offlineIdx)
    expect(installedIdx).toBeGreaterThan(nextStepsIdx)
    // suppress unused variable lint for labels
    expect(labels.length).toBeGreaterThan(0)
  })
})

describe('SkillTreeDataProvider — MCP-offline reconnect row (SMI-5345)', () => {
  beforeEach(() => {
    trackMock.mockReset()
    vi.resetModules()
  })

  it('setMcpOffline(true) prepends the reconnect row to root groups', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.setMcpOffline(true)

    const roots = provider.getChildren()
    const offlineRow = roots[0]
    expect(offlineRow).toBeDefined()
    expect(offlineRow?.contextValue).toBe('mcpOffline')
    expect(offlineRow?.label).toContain('Reconnect')
    expect((offlineRow?.command as { command: string } | undefined)?.command).toBe(
      'skillsmith.mcpReconnect'
    )
  })

  it('setMcpOffline(false) removes the reconnect row', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.setMcpOffline(true)
    expect(provider.getChildren().some((r) => r.contextValue === 'mcpOffline')).toBe(true)

    provider.setMcpOffline(false)
    expect(provider.getChildren().some((r) => r.contextValue === 'mcpOffline')).toBe(false)
  })

  it('offline row is first (before Installed group) when no next-steps are shown', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    provider.setMcpOffline(true)

    const roots = provider.getChildren()
    expect(roots[0]?.contextValue).toBe('mcpOffline')
    expect(roots[roots.length - 1]?.groupId).toBe('installed')
  })

  it('no offline row when setMcpOffline was never called (default false)', async () => {
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const ctx = makeContext()
    const provider = new SkillTreeDataProvider(ctx)

    const roots = provider.getChildren()
    expect(roots.some((r) => r.contextValue === 'mcpOffline')).toBe(false)
  })
})
