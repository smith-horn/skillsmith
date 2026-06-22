/**
 * Tests for Wave 2a discovery: filters, persistent banner, and the
 * `hasActiveFilters` context key (#1433 / SMI-5304, #1432 / SMI-5305,
 * #1434-P2 / #1438-P2 / SMI-5306).
 *
 * Split out of searchSkills.test.ts to keep each file under the 500-line gate
 * (scripts/check-file-length.mjs does not exempt test files). Self-contained:
 * carries its own copy of the shared fixtures so it does not depend on the
 * sibling file's setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SkillData } from '../types/skill.js'

const showInputBox = vi.fn()
const showInformationMessage = vi.fn()
const showWarningMessage = vi.fn()
const showErrorMessage = vi.fn()
const executeCommand = vi.fn()

/**
 * `withProgress` invokes its task with a `progress` reporter and a cancellation
 * `token`. Tests override `currentToken` to simulate cancellation.
 */
let currentToken = { isCancellationRequested: false }
const withProgress = vi.fn(
  async (_opts: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => {
    const progress = { report: vi.fn() }
    return task(progress, currentToken)
  }
)

vi.mock('vscode', () => ({
  window: {
    showInputBox,
    showInformationMessage,
    showWarningMessage,
    showErrorMessage,
    withProgress,
  },
  commands: { executeCommand, registerCommand: vi.fn() },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
  },
  ProgressLocation: { Notification: 15 },
}))

vi.mock('../services/Telemetry.js', () => ({ track: vi.fn() }))

function makeSkill(id: string): SkillData {
  return {
    id,
    name: id,
    description: 'desc',
    author: 'author',
    category: 'category',
    trustTier: 'verified',
    score: 90,
  }
}

/** Available group sentinel returned by the fake provider. */
const AVAILABLE_GROUP = { id: 'group:available', itemType: 'group' as const }

interface FakeProvider {
  setSearchResults: ReturnType<typeof vi.fn>
  clearSearchResults: ReturnType<typeof vi.fn>
  getAvailableGroupItem: ReturnType<typeof vi.fn>
  getFilters: ReturnType<typeof vi.fn>
  setFilters: ReturnType<typeof vi.fn>
  clearFilters: ReturnType<typeof vi.fn>
  hasActiveFilters: ReturnType<typeof vi.fn>
  getLastSearchQuery: ReturnType<typeof vi.fn>
  describeActiveContext: ReturnType<typeof vi.fn>
}

interface ProviderState {
  filters?: import('../commands/searchFilters.js').SearchFilters
  lastQuery?: string
}

function makeProvider(hasAvailable: boolean, state: ProviderState = {}): FakeProvider {
  let filters = state.filters ?? {}
  const lastQuery = state.lastQuery ?? ''
  return {
    setSearchResults: vi.fn(),
    clearSearchResults: vi.fn(),
    getAvailableGroupItem: vi.fn(() => (hasAvailable ? AVAILABLE_GROUP : undefined)),
    getFilters: vi.fn(() => filters),
    setFilters: vi.fn((f) => {
      filters = f
    }),
    clearFilters: vi.fn(() => {
      filters = {}
    }),
    hasActiveFilters: vi.fn(
      () =>
        filters.trustTier !== undefined ||
        filters.category !== undefined ||
        filters.minScore !== undefined
    ),
    getLastSearchQuery: vi.fn(() => lastQuery),
    describeActiveContext: vi.fn(() => ({ rawQuery: lastQuery, demo: false, filterParts: [] })),
  }
}

function makeView() {
  return {
    reveal: vi.fn((..._args: unknown[]) => Promise.resolve()),
    message: undefined as string | undefined,
  }
}

function makeService(result: { results: SkillData[]; isOffline: boolean }) {
  return { search: vi.fn(async () => result) }
}

/**
 * SMI-5345: `performSearch` routes the persistent banner / no-results / offline
 * copy through the `SidebarMessageState` machine (the single owner of
 * `view.message`) instead of writing `view.message` directly. Tests assert on
 * `setSearchBanner` and pass this mock as the (now required) dep.
 */
function makeMessageState() {
  return { setFirstRunHint: vi.fn(), setSearchBanner: vi.fn(), setOffline: vi.fn() }
}

let messageState = makeMessageState()

describe('filter + banner + context-key (#1433 / #1432 / #1434-P2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentToken = { isCancellationRequested: false }
    messageState = makeMessageState()
  })

  it('performSearch threads stored filters into skillService.search (via search command)', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('react')
    const filters = { trustTier: 'verified', category: 'Testing', minScore: 70 }
    const provider = makeProvider(true, { filters, lastQuery: 'react' })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(service.search).toHaveBeenCalledWith('react', filters)
  })

  it('filter command collects filters, stores them, and re-runs the last query', async () => {
    vi.resetModules()
    vi.doMock('../commands/searchFilters.js', () => ({
      collectSearchFilters: vi.fn(async () => ({ trustTier: 'verified' })),
    }))
    const { filterSkillsAction } = await import('../commands/searchSkills.js')
    const provider = makeProvider(true, { lastQuery: 'react' })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await filterSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(provider.setFilters).toHaveBeenCalledWith({ trustTier: 'verified' })
    expect(service.search).toHaveBeenCalledWith('react', { trustTier: 'verified' })
    vi.doUnmock('../commands/searchFilters.js')
    vi.resetModules()
  })

  it('filter-first (no query yet) runs browse-all with the new filters', async () => {
    vi.resetModules()
    vi.doMock('../commands/searchFilters.js', () => ({
      collectSearchFilters: vi.fn(async () => ({ category: 'DevOps' })),
    }))
    const { filterSkillsAction } = await import('../commands/searchSkills.js')
    const provider = makeProvider(true, { lastQuery: '' })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await filterSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(service.search).toHaveBeenCalledWith('', { category: 'DevOps' })
    vi.doUnmock('../commands/searchFilters.js')
    vi.resetModules()
  })

  it('filter command aborts (no setFilters / no search) when the QuickPick is cancelled', async () => {
    vi.resetModules()
    vi.doMock('../commands/searchFilters.js', () => ({
      collectSearchFilters: vi.fn(async () => undefined),
    }))
    const { filterSkillsAction } = await import('../commands/searchSkills.js')
    const provider = makeProvider(true, { lastQuery: 'react' })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await filterSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(provider.setFilters).not.toHaveBeenCalled()
    expect(service.search).not.toHaveBeenCalled()
    vi.doUnmock('../commands/searchFilters.js')
    vi.resetModules()
  })

  it('clear command clears filters and re-runs the last query unfiltered', async () => {
    const { clearFiltersAction } = await import('../commands/searchSkills.js')
    const provider = makeProvider(true, {
      filters: { trustTier: 'verified' },
      lastQuery: 'react',
    })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await clearFiltersAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(provider.clearFilters).toHaveBeenCalledTimes(1)
    expect(service.search).toHaveBeenCalledWith('react', {})
  })

  it('sets the persistent context banner on results from describeActiveContext', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('react')
    const provider = makeProvider(true, { lastQuery: 'react' })
    provider.describeActiveContext.mockReturnValue({
      rawQuery: 'react',
      demo: false,
      filterParts: ['Verified', 'Testing', '70+'],
    })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(messageState.setSearchBanner).toHaveBeenCalledWith(
      'Showing results for "react" · Verified · Testing · 70+'
    )
  })

  it('sets a persistent banner on no-results and clears the result set', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('zzz')
    const provider = makeProvider(false, { lastQuery: 'zzz' })
    const view = makeView()
    const service = makeService({ results: [], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(messageState.setSearchBanner).toHaveBeenCalledWith('No skills found for "zzz"')
    expect(provider.clearSearchResults).toHaveBeenCalledTimes(1)
  })

  it('filter-aware no-results copy when filters are active', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('react')
    const provider = makeProvider(false, {
      filters: { trustTier: 'verified' },
      lastQuery: 'react',
    })
    const view = makeView()
    const service = makeService({ results: [], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(showInformationMessage).toHaveBeenCalledWith(
      'No skills match "react" with the current filters — try Clear Filters.'
    )
  })

  it('offline + empty: persistent unavailable banner + warning + clears results', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('react')
    const provider = makeProvider(false, { lastQuery: 'react' })
    const view = makeView()
    const service = makeService({ results: [], isOffline: true })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(showWarningMessage).toHaveBeenCalled()
    expect(messageState.setSearchBanner).toHaveBeenCalledWith(
      'Skillsmith server unavailable — start the MCP server and try again.'
    )
    expect(provider.clearSearchResults).toHaveBeenCalledTimes(1)
  })

  it('sets hasActiveFilters context key true when filters are active', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('react')
    const provider = makeProvider(true, {
      filters: { trustTier: 'verified' },
      lastQuery: 'react',
    })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'skillsmith.hasActiveFilters', true)
  })

  it('sets hasActiveFilters false on no-results (cleared via clearSearchResults path)', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('zzz')
    const provider = makeProvider(false, { lastQuery: 'zzz' })
    const view = makeView()
    const service = makeService({ results: [], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'skillsmith.hasActiveFilters', false)
  })

  it('sets hasActiveFilters false on offline (cleared via clearSearchResults path)', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('react')
    const provider = makeProvider(false, { lastQuery: 'react' })
    const view = makeView()
    const service = makeService({ results: [], isOffline: true })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'skillsmith.hasActiveFilters', false)
  })

  it('clear command sets hasActiveFilters false after clearing', async () => {
    const { clearFiltersAction } = await import('../commands/searchSkills.js')
    const provider = makeProvider(true, {
      filters: { trustTier: 'verified' },
      lastQuery: 'react',
    })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await clearFiltersAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    })

    // clearFilters() flips the fake provider's hasActiveFilters to false.
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'skillsmith.hasActiveFilters', false)
  })

  it('filter + clear actions are telemetry-wrapped with distinct ids', async () => {
    const { filterSkillsAction, clearFiltersAction } = await import('../commands/searchSkills.js')
    const { isTelemetered } = await import('../services/telemetry-wrap.js')
    expect(isTelemetered(filterSkillsAction)).toBe(true)
    expect(isTelemetered(clearFiltersAction)).toBe(true)
  })

  it("emits distinct telemetry skill_ids ('filter' / 'clear_filter', not 'search')", async () => {
    vi.resetModules()
    vi.doMock('../commands/searchFilters.js', () => ({
      collectSearchFilters: vi.fn(async () => ({})),
    }))
    const { track } = await import('../services/Telemetry.js')
    const { searchSkillsAction, filterSkillsAction, clearFiltersAction } =
      await import('../commands/searchSkills.js')
    const provider = makeProvider(true, { lastQuery: 'react' })
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })
    showInputBox.mockResolvedValue('react')
    const deps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState,
    }

    await searchSkillsAction(deps)
    await filterSkillsAction(deps)
    await clearFiltersAction(deps)

    const ids = vi
      .mocked(track)
      .mock.calls.filter((c) => c[0] === 'vscode_skill_invoke')
      .map((c) => (c[1] as { skill_id: string }).skill_id)
    expect(ids).toContain('search')
    expect(ids).toContain('filter')
    expect(ids).toContain('clear_filter')
    vi.doUnmock('../commands/searchFilters.js')
    vi.resetModules()
  })
})
