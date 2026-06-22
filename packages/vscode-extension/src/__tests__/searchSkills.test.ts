/**
 * Tests for the unified search command (#1431 / SMI-5298, #1434-P1).
 *
 * Asserts that search routes into the unified SkillTreeDataProvider
 * (`setSearchResults`/`clearSearchResults`), focuses the Skillsmith container,
 * then reveals the Available group via the TreeView handle — across results,
 * no-results, offline-empty, and cancellation paths. Also asserts the success
 * toast was removed (#1434-P1) while the offline warning + no-results info
 * message are retained.
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
 * SMI-5345: `performSearch` now routes banner/offline copy through the
 * `SidebarMessageState` machine instead of writing `view.message` directly.
 * Tests pass a mock so the (now required) dep is satisfied.
 */
function makeMessageState() {
  return { setFirstRunHint: vi.fn(), setSearchBanner: vi.fn(), setOffline: vi.fn() }
}

describe('searchSkillsAction (#1431 / SMI-5298, #1434-P1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentToken = { isCancellationRequested: false }
  })

  it('routes results into the provider, focuses the container, then reveals the Available group', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('docker')
    const provider = makeProvider(true)
    const view = makeView()
    const service = makeService({ results: [makeSkill('a'), makeSkill('b')], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState: makeMessageState(),
    })

    expect(provider.setSearchResults).toHaveBeenCalledWith(expect.any(Array), 'docker', {
      demo: false,
    })
    expect(provider.clearSearchResults).not.toHaveBeenCalled()
    // Container focused BEFORE reveal so a collapsed/hidden sidebar still surfaces.
    expect(executeCommand).toHaveBeenCalledWith('skillsmith.skillsView.focus')
    expect(view.reveal).toHaveBeenCalledTimes(1)
    // Success toast removed (#1434-P1).
    expect(showInformationMessage).not.toHaveBeenCalled()
  })

  it('reveals the exact Available group item with the stable id', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('docker')
    const provider = makeProvider(true)
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState: makeMessageState(),
    })

    const revealArg = view.reveal.mock.calls[0]?.[0]
    expect(revealArg).toBe(AVAILABLE_GROUP)
    expect((revealArg as typeof AVAILABLE_GROUP).id).toBe('group:available')
    expect(view.reveal).toHaveBeenCalledWith(AVAILABLE_GROUP, { focus: true, expand: true })
  })

  it('focuses the container even when the sidebar is collapsed (no reveal if no group)', async () => {
    // getAvailableGroupItem returns undefined → reveal must no-op, but the
    // container focus still fires so a palette-invoked search gives feedback.
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('docker')
    const provider = makeProvider(false)
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState: makeMessageState(),
    })

    expect(executeCommand).toHaveBeenCalledWith('skillsmith.skillsView.focus')
    expect(view.reveal).not.toHaveBeenCalled()
  })

  it('no results (online): clears results, shows info message, does NOT reveal', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('zzz')
    const provider = makeProvider(false)
    const view = makeView()
    const service = makeService({ results: [], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState: makeMessageState(),
    })

    expect(provider.clearSearchResults).toHaveBeenCalledTimes(1)
    expect(provider.setSearchResults).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith('No skills found for "zzz"')
    expect(view.reveal).not.toHaveBeenCalled()
    // No reveal/focus on no-results; the only executeCommand is the
    // hasActiveFilters setContext sync.
    expect(executeCommand).not.toHaveBeenCalledWith('skillsmith.skillsView.focus')
  })

  it('offline + empty (not demo): shows warning, clears results, does NOT reveal', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('docker')
    const provider = makeProvider(false)
    const view = makeView()
    const service = makeService({ results: [], isOffline: true })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState: makeMessageState(),
    })

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Skillsmith server unavailable — start the Skillsmith MCP server and try again.'
    )
    expect(provider.clearSearchResults).toHaveBeenCalledTimes(1)
    expect(provider.setSearchResults).not.toHaveBeenCalled()
    expect(showInformationMessage).not.toHaveBeenCalled()
    expect(view.reveal).not.toHaveBeenCalled()
  })

  it('user cancels the input box (Escape): early return, no search', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue(undefined)
    const provider = makeProvider(true)
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState: makeMessageState(),
    })

    expect(service.search).not.toHaveBeenCalled()
    expect(withProgress).not.toHaveBeenCalled()
    expect(provider.setSearchResults).not.toHaveBeenCalled()
    expect(view.reveal).not.toHaveBeenCalled()
  })

  it('cancellation token tripped before search: returns without revealing', async () => {
    const { searchSkillsAction } = await import('../commands/searchSkills.js')
    showInputBox.mockResolvedValue('docker')
    currentToken = { isCancellationRequested: true }
    const provider = makeProvider(true)
    const view = makeView()
    const service = makeService({ results: [makeSkill('a')], isOffline: false })

    await searchSkillsAction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      treeDataProvider: provider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsView: view as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillService: service as any,
      messageState: makeMessageState(),
    })

    expect(service.search).not.toHaveBeenCalled()
    expect(provider.setSearchResults).not.toHaveBeenCalled()
    expect(view.reveal).not.toHaveBeenCalled()
  })
})
